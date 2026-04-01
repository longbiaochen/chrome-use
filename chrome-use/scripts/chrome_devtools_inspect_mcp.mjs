#!/usr/bin/env node
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MIN_WAIT_MS = 500;
const DEFAULT_TRUNCATE = 400;
const CDP_METHOD_NOT_FOUND_CODE = -32601;

function parseFlags(args) {
  const flags = {};
  for (const arg of args) {
    if (!arg.startsWith("--") || !arg.includes("=")) {
      continue;
    }
    const idx = arg.indexOf("=");
    flags[arg.slice(2, idx)] = arg.slice(idx + 1);
  }
  return flags;
}

function encodeMessage(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function createFrameParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (!Number.isFinite(length) || length < 0) {
        buffer = buffer.slice(bodyStart);
        continue;
      }
      if (buffer.length < bodyStart + length) {
        return;
      }
      const body = buffer.slice(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.slice(bodyStart + length);
      try {
        onMessage(JSON.parse(body));
      } catch (_err) {
        // skip malformed payloads
      }
    }
  };
}

function parseNumber(v, fallback) {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(v, min, max, fallback) {
  const n = parseNumber(v, fallback);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  const limited = Math.max(min, Math.trunc(n));
  if (max > 0) {
    return Math.min(limited, max);
  }
  return limited;
}

function isMethodUnavailableError(err) {
  if (!err) {
    return false;
  }
  if (err.code === CDP_METHOD_NOT_FOUND_CODE) {
    return true;
  }
  const message = String(err.message || "").toLowerCase();
  return message.includes("not found") || message.includes("wasn't found");
}

async function safeSend(cdp, method, params = {}, sessionId) {
  try {
    const result = await cdp.send(method, params, sessionId);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

function fetchJson(url) {
  const reqFn = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = reqFn(url, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function safeTruncate(text, max) {
  if (!text) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAttr(node, name) {
  if (!node || !Array.isArray(node.attributes)) {
    return null;
  }
  for (let i = 0; i + 1 < node.attributes.length; i += 2) {
    if (node.attributes[i] === name) {
      return node.attributes[i + 1];
    }
  }
  return null;
}

function quadBounds(quad) {
  if (!Array.isArray(quad) || quad.length < 8) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < quad.length; i += 2) {
    minX = Math.min(minX, quad[i]);
    minY = Math.min(minY, quad[i + 1]);
    maxX = Math.max(maxX, quad[i]);
    maxY = Math.max(maxY, quad[i + 1]);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function inspectToolDef() {
  return {
    name: "inspect_selected_element",
    description:
      "Return the currently selected element from DevTools selection, including description, geometry, and page context.",
    inputSchema: {
      type: "object",
      properties: {
        waitForSelectionMs: {
          type: "number",
          minimum: DEFAULT_MIN_WAIT_MS,
          default: DEFAULT_WAIT_MS,
          description:
            "How long to wait for a new inspect selection event before giving up (in ms).",
        },
        timeoutMs: {
          type: "number",
          minimum: 0,
          default: DEFAULT_WAIT_MS,
          description:
            "Maximum total wait time for returning a selected element (in ms).",
        },
      },
      additionalProperties: false,
    },
  };
}

function inspectFlowToolDef() {
  return {
    name: "inspect",
    description:
      "Interactive inspect flow: capture selected element, return a concise summary, then accept user modification instruction for the same workflow.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["capture", "apply_instruction"],
          default: "capture",
          description:
            "capture to wait for and read the selected element, apply_instruction to attach a user instruction to the same selection context.",
        },
        waitForSelectionMs: {
          type: "number",
          minimum: DEFAULT_MIN_WAIT_MS,
          default: DEFAULT_WAIT_MS,
          description:
            "How long to wait for a new inspect selection event before falling back to polling (in ms).",
        },
        timeoutMs: {
          type: "number",
          minimum: 0,
          default: 0,
          description:
            "Maximum total wait time for returning a selected element (in ms). Use 0 to wait until user selects an element.",
        },
        instruction: {
          type: "string",
          description:
            "User modification instruction text used only when action=apply_instruction.",
        },
      },
      additionalProperties: false,
    },
  };
}

function inspectSummary(payload) {
  const { selectedElement, page, position } = payload;
  const label = selectedElement.selectorHint
    ? selectedElement.selectorHint
    : selectedElement.descriptionText || "(unknown)";
  const id = selectedElement.id || "(no id)";
  const title = page.title || "(no title)";
  return `${label} (${selectedElement.nodeName || "UNKNOWN"}) [id:${id}] on ${title} at ${page.url || "(no url)"} ` +
    `at ${position.x !== null ? position.x.toFixed(2) : "?"}x${position.y !== null ? position.y.toFixed(2) : "?"}, ` +
    `${position.width !== null ? position.width.toFixed(2) : "?"}×${position.height !== null ? position.height.toFixed(2) : "?"}`;
}

function createCDPSession(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let messageId = 1;
  let openResolve;
  const opened = new Promise((resolve) => {
    openResolve = resolve;
  });
  const handlers = [];

  socket.addEventListener("open", () => openResolve());
  socket.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.id) {
      const item = pending.get(msg.id);
      if (!item) {
        return;
      }
      pending.delete(msg.id);
      if (msg.error) {
        item.reject(msg.error);
      } else {
        item.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      for (const handler of handlers) {
        handler(msg);
      }
    }
  });
  socket.addEventListener("close", () => {
    for (const item of pending.values()) {
      item.reject(new Error("CDP websocket closed"));
    }
    pending.clear();
  });
  socket.addEventListener("error", (err) => {
    for (const item of pending.values()) {
      item.reject(err.error || err);
    }
    pending.clear();
  });

  return {
    waitOpen: async () => opened,
    send: async (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = messageId++;
        const payload = { id, method, params };
        if (sessionId) {
          payload.sessionId = sessionId;
        }
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify(payload));
      }),
    onEvent: (handler) => handlers.push(handler),
    close: () => socket.close(),
    isClosed: () => socket.readyState !== WebSocket.OPEN,
  };
}

function formatSelectionNotReadyMessage(timeoutMs, state) {
  const listened = state.lastObservedError
    ? "事件监听不可用（可能未返回 Overlay.inspectNodeRequested）"
    : "未检测到事件推送（可能未开启 Inspect 选择）";
  return `尚未选中目标元素。已等待 ${timeoutMs}ms，${listened}。建议先在 Chrome 中点击元素后重试。`;
}

async function resolveSelectedElementPayload(
  cdp,
  state,
  sessionState,
  pageInfo,
  explicitSelection = null,
) {
  const activeCdp = sessionState?.cdp || cdp;
  const selection = explicitSelection || state.lastSelectionEvent;
  const directSession = String(sessionState?.sessionId || "").startsWith("direct:");
  const sessionId =
    selection?.sessionId && !String(selection.sessionId).startsWith("direct:")
      ? selection.sessionId
      : directSession
        ? null
        : sessionState.sessionId;
  if (!selection) {
    throw new Error("尚未选中元素（未收到 Selection 事件）。请在 Chrome 中先点击 Inspect 并选中一个节点后重试。");
  }
  let backendNodeId = selection.backendNodeId || selection.nodeId;
  if (!backendNodeId) {
    throw new Error("选中事件无可映射标识（缺少 backendNodeId/nodeId），请重试并重新选中该元素。");
  }

  let nodeId = selection.nodeId;
  if (!nodeId && backendNodeId) {
    const pushed = await activeCdp.send(
      "DOM.pushNodesByBackendIdsToFrontend",
      { backendNodeIds: [backendNodeId] },
      sessionId,
    );
    nodeId = pushed?.nodeIds?.[0];
  }
  if (!nodeId) {
    nodeId = backendNodeId;
  }

  const describe = await activeCdp.send("DOM.describeNode", { nodeId }, sessionId);
  const node = describe?.node || {};
  const nodeName = node.nodeName || "UNKNOWN";
  const id = getAttr(node, "id");
  const className = getAttr(node, "class") || "";

  let model = null;
  try {
    const box = await activeCdp.send("DOM.getBoxModel", { nodeId }, sessionId);
    model = box?.model || null;
  } catch (_err) {}

  let snippet = "";
  try {
      const outer = await activeCdp.send("DOM.getOuterHTML", { nodeId }, sessionId);
    snippet = safeTruncate(outer?.outerHTML || "", DEFAULT_TRUNCATE);
  } catch (_err) {
    try {
      const outer = await activeCdp.send(
        "DOM.getOuterHTML",
        { backendNodeId },
        sessionId,
      );
      snippet = safeTruncate(outer?.outerHTML || "", DEFAULT_TRUNCATE);
    } catch (_innerErr) {}
  }

  const hintCandidates = [
    id ? `#${id}` : null,
    className
      ? `${nodeName.toLowerCase()}.${className
          .split(/\s+/)
          .filter(Boolean)
          .join(".")}`
      : null,
    nodeName.toLowerCase(),
  ].filter(Boolean);

  const usedQuad = model?.content || model?.border || model?.padding || null;
  const bounds = quadBounds(usedQuad);
  const quads = usedQuad && usedQuad.length >= 8 ? [usedQuad] : [];
  const ariaLabel = getAttr(node, "aria-label");

  return {
    selectedElement: {
      backendNodeId,
      nodeName,
      id: id || null,
      className: className || null,
      ariaLabel,
      descriptionText: [
        nodeName,
        id ? `#${id}` : "",
        className ? `.${className.split(/\s+/).join(".")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      selectorHint: hintCandidates[0] || null,
      snippet,
    },
    position: {
      x: bounds ? bounds.x : null,
      y: bounds ? bounds.y : null,
      width: bounds ? bounds.width : null,
      height: bounds ? bounds.height : null,
      quads,
    },
    page: {
      title: pageInfo.title || null,
      url: pageInfo.url || null,
      pageId: pageInfo.targetId || null,
      frameId: selection.frameId || null,
    },
    observedAt: new Date(selection.eventTime).toISOString(),
  };
}

function waitForSelection(state, ms, sinceMs) {
  if (state.lastSelectionEvent && state.lastSelectionEvent.eventTime >= sinceMs) {
    return Promise.resolve(state.lastSelectionEvent);
  }
  if (ms <= 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const waiter = { done: false, resolve, deadline: Date.now() + ms };
    waiter.timer = setTimeout(() => {
      if (waiter.done) {
        return;
      }
      waiter.done = true;
      const idx = state.selectionWaiters.indexOf(waiter);
      if (idx >= 0) {
        state.selectionWaiters.splice(idx, 1);
      }
      resolve(null);
    }, ms);
    state.selectionWaiters.push(waiter);
  });
}

function notifySelectionWaiters(state, selection) {
  for (const waiter of [...state.selectionWaiters]) {
    if (waiter.done) {
      continue;
    }
    waiter.done = true;
    clearTimeout(waiter.timer);
    const idx = state.selectionWaiters.indexOf(waiter);
    if (idx >= 0) {
      state.selectionWaiters.splice(idx, 1);
    }
    waiter.resolve(selection);
  }
}

async function resolveSelectionByActiveElement(cdp, state, sessionState, pageInfo) {
  const activeCdp = sessionState?.cdp || cdp;
  const sessionId =
    sessionState?.sessionId && !String(sessionState?.sessionId).startsWith("direct:")
      ? sessionState.sessionId
      : null;
  if (!activeCdp && !sessionId) {
    return null;
  }

  let activeResult = null;
  try {
    activeResult = await activeCdp.send(
      "Runtime.evaluate",
      {
        expression:
          "document && document.activeElement ? document.activeElement : null",
        returnByValue: false,
      },
      sessionId,
    );
  } catch (_err) {
    return null;
  }
  const objectId = activeResult?.result?.objectId;
  if (!objectId) {
    return null;
  }

  let nodeId = null;
  try {
    const request = await activeCdp.send("DOM.requestNode", { objectId }, sessionId);
    nodeId = request?.nodeId;
  } catch (_err) {}
  if (!nodeId) {
    return null;
  }

  let described = null;
  try {
    described = await activeCdp.send("DOM.describeNode", { nodeId }, sessionId);
  } catch (_err) {}

  const describedNode = described?.node || {};
  if (!describedNode.nodeName || describedNode.nodeName === "HTML") {
    return null;
  }

  const syntheticSelection = {
    backendNodeId: describedNode.backendNodeId || null,
    nodeId,
    targetId: sessionState.targetId,
    frameId: sessionState.frameId || pageInfo.frameId || null,
    eventTime: Date.now(),
  };

  if (!syntheticSelection.backendNodeId && !syntheticSelection.nodeId) {
    return null;
  }

  return resolveSelectedElementPayload(
    cdp,
    state,
    sessionState,
    pageInfo,
    syntheticSelection,
  );
}

async function materializeSelectionPayload(cdp, state, selection) {
  if (!selection || !selection.targetId) {
    throw new Error(
      "尚未选中元素（未收到 Selection 事件）。请在 Chrome 中先点击 Inspect 并选中一个节点后重试。",
    );
  }

  const sessionState = state.targetsById.get(selection.targetId);
  if (!sessionState || (!sessionState.sessionId && !sessionState.cdp)) {
    throw new Error("未匹配到当前选中元素所在页面，建议重新选中元素后重试。");
  }

  const basePageInfo = state.targetInfosByTargetId.get(selection.targetId) || {};
  const pageInfo = {
    ...basePageInfo,
    frameId: sessionState.frameId || basePageInfo.frameId || null,
  };
  return resolveSelectedElementPayload(
    cdp,
    state,
    sessionState,
    pageInfo,
    selection,
  );
}

async function resolveSelectionOnDemandBlocking(cdp, state, { waitForSelectionMs }) {
  const startedAt = Date.now();
  const waitMs = Math.max(DEFAULT_MIN_WAIT_MS, waitForSelectionMs);

  while (true) {
    if (!state.targetsById.size || cdp.isClosed?.()) {
      throw new Error(
        "未发现可用的检查会话，请先在 Chrome 打开页面并切换到 inspect 模式后重试。",
      );
    }

    const selection = await waitForSelection(state, waitMs, startedAt);
    if (selection) {
      return materializeSelectionPayload(cdp, state, selection);
    }

    for (const [targetId, sessionState] of state.targetsById) {
      const pageInfo = state.targetInfosByTargetId.get(targetId) || {};
      const fromActive = await resolveSelectionByActiveElement(
        cdp,
        state,
        sessionState,
        pageInfo,
      );
      if (fromActive) {
        return fromActive;
      }
    }

    await sleep(250);
  }
}

async function resolveSelectionOnDemand(cdp, state, { waitForSelectionMs, timeoutMs }) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  const primaryWait = Math.min(waitForSelectionMs, timeoutMs);
  const first = await waitForSelection(state, primaryWait, start);

  let selection = first || null;
  if (!selection || !selection.targetId) {
    const pollInterval = 250;
    while (Date.now() < deadline) {
      for (const [targetId, sessionState] of state.targetsById) {
        const pageInfo = state.targetInfosByTargetId.get(targetId) || {};
        const fromActive = await resolveSelectionByActiveElement(
          cdp,
          state,
          sessionState,
          pageInfo,
        );
        if (fromActive) {
          return fromActive;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(pollInterval, remaining));
      if (state.lastSelectionEvent && state.lastSelectionEvent.eventTime >= start) {
        selection = state.lastSelectionEvent;
        break;
      }
    }

    const observedSelection = state.lastSelectionEvent;
    if (!selection && (!observedSelection || observedSelection.eventTime < start)) {
      throw new Error(
        formatSelectionNotReadyMessage(timeoutMs, state),
      );
    }
    if (!selection) {
      selection = observedSelection;
    }
  }

  return materializeSelectionPayload(cdp, state, selection);
}

async function runInspectFlow(cdp, state, args, messageId) {
  const action = args.action === "apply_instruction" ? "apply_instruction" : "capture";
  const waitForSelectionMs = clampInt(args.waitForSelectionMs, DEFAULT_MIN_WAIT_MS, 60000, DEFAULT_WAIT_MS);
  const timeoutMs = clampInt(args.timeoutMs, 0, 60000, DEFAULT_TIMEOUT_MS);

  if (action === "capture") {
    const payload =
      timeoutMs > 0
        ? await resolveSelectionOnDemand(cdp, state, {
            waitForSelectionMs,
            timeoutMs,
          })
        : await resolveSelectionOnDemandBlocking(cdp, state, {
            waitForSelectionMs,
          });

    const workflow = {
      workflowId: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      payload,
      status: "awaiting_instruction",
      createdAt: Date.now(),
    };
    state.inspectWorkflow = workflow;

    return {
      phase: "awaiting_user_instruction",
      workflowId: workflow.workflowId,
      status: "awaiting_user_instruction",
      summary: inspectSummary(payload),
      selectedElement: payload.selectedElement,
      position: payload.position,
      page: payload.page,
      nextStep: {
        action: "apply_instruction",
        instruction: "你要怎么改？请给出具体 DOM 修改指令。",
      },
    };
  }

  if (!state.inspectWorkflow || state.inspectWorkflow.status !== "awaiting_instruction") {
    throw new Error("当前没有可用的 inspect 会话。请先执行 inspect(action='capture') 获取一次选中结果。");
  }

  if (!state.targetsById.size || cdp.isClosed?.()) {
    state.inspectWorkflow = null;
    throw new Error("会话已失效或浏览器连接断开，请重新执行 inspect(action='capture')。");
  }

  if (typeof args.instruction !== "string" || !args.instruction.trim()) {
    return {
      phase: "awaiting_user_instruction",
      workflowId: state.inspectWorkflow.workflowId,
      selectedElement: state.inspectWorkflow.payload.selectedElement,
      position: state.inspectWorkflow.payload.position,
      page: state.inspectWorkflow.payload.page,
      message:
        "尚未收到修改指令。请直接给出你要改的 DOM 内容，例如“把文本改为…”或“按钮改成红色”。",
    };
  }

  state.inspectWorkflow.status = "ready_to_apply";
  state.inspectWorkflow.instruction = args.instruction.trim();

  return {
    phase: "ready_to_apply",
    workflowId: state.inspectWorkflow.workflowId,
    selectedElement: state.inspectWorkflow.payload.selectedElement,
    position: state.inspectWorkflow.payload.position,
    page: state.inspectWorkflow.payload.page,
    userInstruction: state.inspectWorkflow.instruction,
    nextStep: {
      action: "apply",
      note: "将 instruction 与 selectedElement/position/page 一起传给后续 DOM 修改工具。",
      toolingHint: {
        messageId,
        requires: ["execute_javascript", "DOM"],
      },
    },
  };
}

async function attachPageTarget(cdp, targetInfo, state) {
  if (state.targetsById.has(targetInfo.targetId)) {
    return;
  }

  const useDirectSession = targetInfo.preferDirectSession || !state.targetDomainAvailable;
  let sessionId = null;
  let sessionCdp = cdp;

  if (useDirectSession && targetInfo.webSocketDebuggerUrl) {
    sessionCdp = createCDPSession(targetInfo.webSocketDebuggerUrl);
    await sessionCdp.waitOpen();
  } else {
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: targetInfo.targetId,
      flatten: true,
    });
    sessionId = attached?.sessionId;
    if (!sessionId) {
      return;
    }
  }

  const effectiveSessionId = useDirectSession ? null : sessionId;
  const safeResults = await Promise.all([
    safeSend(sessionCdp, "DOM.enable", {}, effectiveSessionId),
    safeSend(sessionCdp, "Page.enable", {}, effectiveSessionId),
    safeSend(sessionCdp, "Overlay.enable", {}, effectiveSessionId),
    safeSend(sessionCdp, "Runtime.enable", {}, effectiveSessionId),
  ]);
  const overlayEnabled = safeResults[2].ok;
  if (!overlayEnabled) {
    state.lastObservedError = `Overlay.enable unavailable for target ${targetInfo.targetId}: ${safeResults[2].error?.message || safeResults[2].error}`;
  }

  let frameId = null;
  try {
    const frameTree = await sessionCdp.send("Page.getFrameTree", {}, effectiveSessionId);
    frameId = frameTree?.frameTree?.frame?.id || null;
  } catch (_err) {}

  const sessionKey = effectiveSessionId || `direct:${targetInfo.targetId}`;
  state.targetsById.set(targetInfo.targetId, {
    targetId: targetInfo.targetId,
    sessionId: sessionKey,
    cdp: sessionCdp,
    frameId,
  });
  state.targetsBySessionId.set(sessionKey, targetInfo.targetId);

  if (overlayEnabled) {
    const sessionState = state.targetsById.get(targetInfo.targetId);
    sessionCdp.onEvent((msg) => {
      if (useDirectSession) {
        if (msg.method !== "Overlay.inspectNodeRequested") {
          return;
        }
      } else if (msg.sessionId !== sessionId) {
        return;
      }

      if (msg.method !== "Overlay.inspectNodeRequested") {
        return;
      }
      state.lastSelectionEvent = {
        ...msg.params,
        targetId: targetInfo.targetId,
        sessionId: sessionState.sessionId,
        eventTime: Date.now(),
      };
      notifySelectionWaiters(state, state.lastSelectionEvent);
    });
  }
}

async function loadTargetsFromTargetDomain(cdp, state) {
  const enableResult = await safeSend(cdp, "Target.enable");
  state.targetDomainAvailable = enableResult.ok;
  if (!enableResult.ok && !isMethodUnavailableError(enableResult.error)) {
    throw enableResult.error;
  }
  if (!enableResult.ok) {
    return [];
  }

  const discoverResult = await safeSend(cdp, "Target.setDiscoverTargets", {
    discover: true,
  });
  if (!discoverResult.ok && !isMethodUnavailableError(discoverResult.error)) {
    throw discoverResult.error;
  }

  const getTargetsResult = await safeSend(cdp, "Target.getTargets");
  if (!getTargetsResult.ok) {
    if (isMethodUnavailableError(getTargetsResult.error)) {
      return [];
    }
    throw getTargetsResult.error;
  }
  return getTargetsResult.result?.targetInfos || [];
}

async function loadTargetsFromDebugList(debugUrl, state) {
  const list = await fetchJson(`${debugUrl}/json/list`);
  const items = Array.isArray(list) ? list : [];
  const pageItems = items.filter((item) => item?.type === "page");
  if (!pageItems.length) {
    state.lastObservedError = "No page targets discovered via /json/list";
    return [];
  }
  return pageItems.map((item) => ({
    targetId: item.id,
    title: item.title || null,
    url: item.url || null,
    type: item.type || "page",
    webSocketDebuggerUrl: item.webSocketDebuggerUrl,
    preferDirectSession: true,
  }));
}

function updateTargetInfo(state, info) {
  if (!info?.targetId) {
    return;
  }
  state.targetInfosByTargetId.set(info.targetId, {
    targetId: info.targetId,
    title: info.title || null,
    url: info.url || null,
    type: info.type || null,
  });
}

async function start() {
  const args = parseFlags(process.argv.slice(2));
  const debugUrl = args["browser-url"] || "http://127.0.0.1:9223";
  const upstreamBin = args["upstream-bin"] || "";

  const version = await fetchJson(`${debugUrl}/json/version`);
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error(`No webSocketDebuggerUrl from ${debugUrl}/json/version`);
  }

  const cdp = createCDPSession(wsUrl);
  await cdp.waitOpen();

  const state = {
    selectionWaiters: [],
    targetsBySessionId: new Map(),
    targetsById: new Map(),
    targetInfosByTargetId: new Map(),
    lastSelectionEvent: null,
    lastObservedError: null,
    targetDomainAvailable: false,
    inspectWorkflow: null,
  };

  let targetInfos = await loadTargetsFromTargetDomain(cdp, state);
  if (!targetInfos.length) {
    targetInfos = await loadTargetsFromDebugList(debugUrl, state);
  }
  if (!targetInfos.length) {
    throw new Error("未发现可用的页面目标，请先在 Chrome 打开页面后重试。");
  }
  for (const info of targetInfos || []) {
    if (info.type === "page") {
      updateTargetInfo(state, info);
      try {
        await attachPageTarget(cdp, info, state);
      } catch (err) {
        state.lastObservedError = `attach page failed: ${err?.message || err}`;
      }
    }
  }
  if (!state.targetsById.size) {
    throw new Error(`Failed to attach any page target for inspection. Last error: ${state.lastObservedError || "unknown"}`);
  }

  cdp.onEvent((msg) => {
    if (!state.targetDomainAvailable) {
      return;
    }
    if (!msg?.method) {
      return;
    }
    if (msg.method === "Target.targetCreated" && msg.params?.targetInfo?.type === "page") {
      const info = msg.params.targetInfo;
      updateTargetInfo(state, info);
      attachPageTarget(cdp, info, state).catch((err) => {
        state.lastObservedError = `attach page failed: ${err?.message || err}`;
      });
      return;
    }
    if (msg.method === "Target.targetDestroyed" && msg.params?.targetId) {
      const targetId = msg.params.targetId;
      const session = state.targetsById.get(targetId);
      if (session?.sessionId) {
        state.targetsBySessionId.delete(session.sessionId);
      }
      state.targetsById.delete(targetId);
      state.targetInfosByTargetId.delete(targetId);
      return;
    }
    if (msg.method === "Target.targetInfoChanged" && msg.params?.targetInfo) {
      updateTargetInfo(state, msg.params.targetInfo);
      return;
    }
    if (msg.sessionId && msg.method === "Overlay.inspectNodeRequested") {
      const targetId = state.targetsBySessionId.get(msg.sessionId);
      if (!targetId) {
        return;
      }
      state.lastSelectionEvent = {
        ...msg.params,
        targetId,
        sessionId: msg.sessionId,
        eventTime: Date.now(),
      };
      notifySelectionWaiters(state, state.lastSelectionEvent);
      return;
    }
  });

  const child = upstreamBin
    ? spawn(upstreamBin, [`--browser-url=${debugUrl}`], { stdio: ["pipe", "pipe", "pipe"] })
    : spawn(
        "npm",
        [
          "exec",
          "--yes",
          "--package=chrome-devtools-mcp@latest",
          "--",
          "chrome-devtools-mcp",
          `--browser-url=${debugUrl}`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[upstream] ${chunk}`);
  });
  child.on("exit", (code) => {
    process.exit(code || 0);
  });

  const pendingToolListCalls = new Map();
  const fromClient = createFrameParser(async (message) => {
    if (message.method === "tools/list") {
      const id = message.id;
      const onResponse = (response) => {
        if (response.result?.tools && !response.result.tools.some((tool) => tool.name === inspectToolDef().name)) {
          response.result.tools.push(inspectToolDef());
        }
        if (response.result?.tools && !response.result.tools.some((tool) => tool.name === inspectFlowToolDef().name)) {
          response.result.tools.push(inspectFlowToolDef());
        }
        process.stdout.write(encodeMessage(response));
      };
      pendingToolListCalls.set(id, onResponse);
      child.stdin.write(encodeMessage(message));
      return;
    }

    if (
      message.method === "tools/call" &&
      message.params?.name === "inspect_selected_element"
    ) {
      const args = message.params?.arguments || {};
      const waitForSelectionMs = clampInt(args.waitForSelectionMs, DEFAULT_MIN_WAIT_MS, 60000, DEFAULT_WAIT_MS);
      const timeoutMs = clampInt(args.timeoutMs, 0, 60000, DEFAULT_TIMEOUT_MS);

      if (!state.lastSelectionEvent && !state.lastObservedError) {
        state.lastObservedError = "尚未接收到元素选择事件。请先在 DevTools 中选择元素后重试。";
      }

      try {
        const payload = await resolveSelectionOnDemand(cdp, state, {
          waitForSelectionMs,
          timeoutMs,
        });
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(payload, null, 2),
                },
              ],
              structuredContent: payload,
            },
          }),
        );
      } catch (err) {
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message:
                err?.message || "failed to inspect selected element",
            },
          }),
        );
      }
      return;
    }

    if (message.method === "tools/call" && message.params?.name === "inspect") {
      const args = message.params?.arguments || {};

      try {
        const payload = await runInspectFlow(cdp, state, args, message.id);
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(payload, null, 2),
                },
              ],
              structuredContent: payload,
            },
          }),
        );
      } catch (err) {
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message:
                err?.message || "failed to run inspect workflow",
            },
          }),
        );
      }
      return;
    }

    child.stdin.write(encodeMessage(message));
  });

  const fromUpstream = createFrameParser((message) => {
    if (message.id && pendingToolListCalls.has(message.id)) {
      const callback = pendingToolListCalls.get(message.id);
      pendingToolListCalls.delete(message.id);
      callback(message);
      return;
    }
    process.stdout.write(encodeMessage(message));
  });

  process.stdin.on("data", fromClient);
  child.stdout.on("data", fromUpstream);

  process.on("SIGINT", () => {
    cdp.close();
    for (const sessionState of state.targetsById.values()) {
      if (sessionState?.cdp && sessionState.cdp !== cdp) {
        sessionState.cdp.close();
      }
    }
    child.kill("SIGINT");
    process.exit(0);
  });
}

start().catch((err) => {
  process.stderr.write(`${err?.message || err}\n`);
  process.exit(1);
});
