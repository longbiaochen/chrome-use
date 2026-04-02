#!/usr/bin/env node
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  mkdir,
  readFile,
  rename,
  watch as fsWatch,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MIN_WAIT_MS = 500;
const DEFAULT_POLL_MS = 250;
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

export function createFrameParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
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
      } catch {
        // Skip malformed payloads.
      }
    }
  };
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value, min, max, fallback) {
  const parsed = parseNumber(value, fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const limited = Math.max(min, Math.trunc(parsed));
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
  const requestFn = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn(url, (res) => {
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
  for (let idx = 0; idx + 1 < node.attributes.length; idx += 2) {
    if (node.attributes[idx] === name) {
      return node.attributes[idx + 1];
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
  for (let idx = 0; idx < quad.length; idx += 2) {
    minX = Math.min(minX, quad[idx]);
    minY = Math.min(minY, quad[idx + 1]);
    maxX = Math.max(maxX, quad[idx]);
    maxY = Math.max(maxY, quad[idx + 1]);
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
      "Return selected element context from the durable inspect workflow state, including geometry and page metadata.",
    inputSchema: {
      type: "object",
      properties: {
        waitForSelectionMs: {
          type: "number",
          minimum: DEFAULT_MIN_WAIT_MS,
          default: DEFAULT_WAIT_MS,
          description:
            "How long to wait for a new inspect selection event before falling back to recovery behavior (in ms).",
        },
        timeoutMs: {
          type: "number",
          minimum: 0,
          default: DEFAULT_TIMEOUT_MS,
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
      "Interactive inspect workflow with durable workflow state and polling-friendly lifecycle actions.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "begin_capture",
            "await_selection",
            "get_status",
            "capture",
            "apply_instruction",
          ],
          default: "capture",
          description:
            "begin_capture starts a new workflow, await_selection waits for a durable selection, get_status reads current durable workflow state, capture is the legacy one-shot compatibility action, and apply_instruction stores user instruction for the selected element.",
        },
        workflowId: {
          type: "string",
          description: "Workflow identifier returned from begin_capture or capture.",
        },
        waitForSelectionMs: {
          type: "number",
          minimum: DEFAULT_MIN_WAIT_MS,
          default: DEFAULT_WAIT_MS,
          description:
            "Polling/watch backoff hint used while waiting for durable selection state.",
        },
        timeoutMs: {
          type: "number",
          minimum: 0,
          default: 0,
          description:
            "Maximum wait for selection. Use 0 to wait indefinitely.",
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
  const label = selectedElement.selectorHint || selectedElement.descriptionText || "(unknown)";
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
  let openedResolve;
  const opened = new Promise((resolve) => {
    openedResolve = resolve;
  });
  const handlers = [];

  socket.addEventListener("open", () => openedResolve());
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        item.reject(message.error);
      } else {
        item.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      for (const handler of handlers) {
        handler(message);
      }
    }
  });
  socket.addEventListener("close", () => {
    for (const item of pending.values()) {
      item.reject(new Error("CDP websocket closed"));
    }
    pending.clear();
  });
  socket.addEventListener("error", (event) => {
    for (const item of pending.values()) {
      item.reject(event.error || event);
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
    ? "event listener reported an issue"
    : "no inspect selection event was observed";
  return `No selected element is available yet. Waited ${timeoutMs}ms and ${listened}. Select an element in Chrome inspect mode and retry.`;
}

export function createInspectStore({
  rootDir = process.env.CHROME_USE_STATE_DIR || path.join(os.homedir(), ".chrome-use", "state"),
  debugHost = process.env.CHROME_USE_DEBUG_HOST || "127.0.0.1",
  debugPort = process.env.CHROME_USE_DEBUG_PORT || "9223",
} = {}) {
  const scope = `${String(debugHost).replace(/[^a-zA-Z0-9_.-]/g, "_")}-${String(debugPort).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  const inspectDir = path.join(rootDir, "inspect", scope);
  const workflowsDir = path.join(inspectDir, "workflows");
  const eventsDir = path.join(inspectDir, "events");
  const sessionPath = path.join(inspectDir, "session.json");
  const currentSelectionPath = path.join(eventsDir, "current-selection.json");
  return {
    rootDir,
    inspectDir,
    workflowsDir,
    eventsDir,
    sessionPath,
    currentSelectionPath,
    workflowPath(workflowId) {
      return path.join(workflowsDir, `${workflowId}.json`);
    },
  };
}

async function ensureInspectStore(store) {
  await mkdir(store.inspectDir, { recursive: true });
  await mkdir(store.workflowsDir, { recursive: true });
  await mkdir(store.eventsDir, { recursive: true });
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      return null;
    }
    if (err instanceof SyntaxError) {
      return null;
    }
    throw err;
  }
}

export async function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, filePath);
}

function logSignal(event, details = {}) {
  process.stderr.write(`[chrome-inspect] ${JSON.stringify({
    event,
    time: new Date().toISOString(),
    ...details,
  })}\n`);
}

async function initializeStoreState(store, state) {
  await ensureInspectStore(store);
  const session = (await readJsonIfPresent(store.sessionPath)) || {};
  state.storeSequence = Number.isFinite(Number(session.sequence)) ? Number(session.sequence) : 0;
  state.activeWorkflowId = typeof session.activeWorkflowId === "string" ? session.activeWorkflowId : null;
}

async function nextSequence(state) {
  state.storeSequence += 1;
  return state.storeSequence;
}

async function persistSessionState(store, state, patch = {}) {
  const previous = (await readJsonIfPresent(store.sessionPath)) || {};
  const sequence = await nextSequence(state);
  const session = {
    sequence,
    updatedAt: new Date().toISOString(),
    activeWorkflowId: state.activeWorkflowId || null,
    status: patch.status || previous.status || "bridge_ready",
    lastError: patch.error || previous.lastError || null,
    targets: [...state.targetInfosByTargetId.values()],
  };
  await atomicWriteJson(store.sessionPath, session);
  return session;
}

async function persistWorkflowState(store, state, workflowId, patch = {}) {
  const workflowPath = store.workflowPath(workflowId);
  const previous = (await readJsonIfPresent(workflowPath)) || { workflowId };
  const sequence = await nextSequence(state);
  const workflow = {
    workflowId,
    sequence,
    updatedAt: new Date().toISOString(),
    createdAt: previous.createdAt || new Date().toISOString(),
    status: patch.status || previous.status || "waiting_for_selection",
    phase: patch.phase || previous.phase || null,
    targetId: patch.targetId !== undefined ? patch.targetId : (previous.targetId || null),
    page: patch.page !== undefined ? patch.page : (previous.page || null),
    selectedElement:
      patch.selectedElement !== undefined ? patch.selectedElement : (previous.selectedElement || null),
    position: patch.position !== undefined ? patch.position : (previous.position || null),
    payload: patch.payload !== undefined ? patch.payload : (previous.payload || null),
    summary: patch.summary !== undefined ? patch.summary : (previous.summary || null),
    selectionSource:
      patch.selectionSource !== undefined ? patch.selectionSource : (previous.selectionSource || null),
    userInstruction:
      patch.userInstruction !== undefined ? patch.userInstruction : (previous.userInstruction || null),
    heartbeat: patch.heartbeat !== undefined ? patch.heartbeat : (previous.heartbeat || null),
    error: patch.error !== undefined ? patch.error : (previous.error || null),
  };
  await atomicWriteJson(workflowPath, workflow);
  return workflow;
}

async function persistCurrentSelection(store, state, selectionRecord) {
  const sequence = await nextSequence(state);
  const event = {
    sequence,
    updatedAt: new Date().toISOString(),
    ...selectionRecord,
  };
  await atomicWriteJson(store.currentSelectionPath, event);
  return event;
}

async function persistRecoveredSelection(state, workflowId, payload, targetId = null) {
  return persistCurrentSelection(state.store, state, {
    workflowId: workflowId || null,
    status: "selection_received",
    targetId,
    page: payload.page,
    selectedElement: payload.selectedElement,
    position: payload.position,
    payload,
    selectionSource: payload.selectionSource || "page_click",
  });
}

function isSelectionReady(workflow) {
  return workflow?.status === "selection_received" || workflow?.status === "awaiting_user_instruction";
}

async function readWorkflow(store, workflowId) {
  if (!workflowId) {
    return null;
  }
  return readJsonIfPresent(store.workflowPath(workflowId));
}

export async function waitForFileSignal({
  filePath,
  predicate,
  timeoutMs = 0,
  pollMs = DEFAULT_POLL_MS,
}) {
  const start = Date.now();
  const timeoutAt = timeoutMs > 0 ? start + timeoutMs : Number.POSITIVE_INFINITY;
  const parentDir = path.dirname(filePath);

  const readCurrent = async () => {
    const current = await readJsonIfPresent(filePath);
    if (current && predicate(current)) {
      return current;
    }
    return null;
  };

  const immediate = await readCurrent();
  if (immediate) {
    return immediate;
  }

  let watcher;
  let resolvePromise;
  let settled = false;
  let pollTimer = null;
  let timeoutTimer = null;

  const cleanup = async () => {
    settled = true;
    if (watcher) {
      try {
        await watcher.close();
      } catch {
        // Ignore cleanup errors.
      }
    }
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  };

  const maybeResolve = async () => {
    if (settled) {
      return;
    }
    const current = await readCurrent();
    if (!current) {
      return;
    }
    await cleanup();
    resolvePromise(current);
  };

  return new Promise(async (resolve, reject) => {
    resolvePromise = resolve;

    try {
      watcher = await fsWatch(parentDir);
      (async () => {
        try {
          for await (const event of watcher) {
            if (settled) {
              return;
            }
            if (event.filename && event.filename !== path.basename(filePath)) {
              continue;
            }
            await maybeResolve();
          }
        } catch (err) {
          if (!settled) {
            logSignal("watch_error", { filePath, error: err?.message || String(err) });
          }
        }
      })();
    } catch (err) {
      logSignal("watch_unavailable", { filePath, error: err?.message || String(err) });
    }

    pollTimer = setInterval(() => {
      void maybeResolve();
      if (Date.now() >= timeoutAt) {
        void cleanup().then(() => resolve(null));
      }
    }, pollMs);

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        void cleanup().then(() => resolve(null));
      }, timeoutMs);
    }
  });
}

async function resolveSelectedElementPayload(
  cdp,
  state,
  sessionState,
  pageInfo,
  explicitSelection = null,
  selectionSource = "overlay_event",
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
    throw new Error("No selected element is available yet. Select a node in Chrome inspect mode and retry.");
  }

  let backendNodeId = selection.backendNodeId || selection.nodeId;
  if (!backendNodeId) {
    throw new Error("Selection event did not include backendNodeId or nodeId. Re-select the element and retry.");
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
  } catch {
    // Ignore box model failures.
  }

  let snippet = "";
  try {
    const outer = await activeCdp.send("DOM.getOuterHTML", { nodeId }, sessionId);
    snippet = safeTruncate(outer?.outerHTML || "", DEFAULT_TRUNCATE);
  } catch {
    try {
      const outer = await activeCdp.send("DOM.getOuterHTML", { backendNodeId }, sessionId);
      snippet = safeTruncate(outer?.outerHTML || "", DEFAULT_TRUNCATE);
    } catch {
      // Ignore outer HTML failures.
    }
  }

  const hintCandidates = [
    id ? `#${id}` : null,
    className
      ? `${nodeName.toLowerCase()}.${className.split(/\s+/).filter(Boolean).join(".")}`
      : null,
    nodeName.toLowerCase(),
  ].filter(Boolean);

  const usedQuad = model?.content || model?.border || model?.padding || null;
  const bounds = quadBounds(usedQuad);
  const quads = usedQuad && usedQuad.length >= 8 ? [usedQuad] : [];

  return {
    selectedElement: {
      backendNodeId,
      nodeName,
      id: id || null,
      className: className || null,
      ariaLabel: getAttr(node, "aria-label"),
      descriptionText: [nodeName, id ? `#${id}` : "", className ? `.${className.split(/\s+/).join(".")}` : ""]
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
    selectionSource,
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

function getSessionRuntime(sessionState, cdp) {
  const activeCdp = sessionState?.cdp || cdp;
  const sessionId =
    sessionState?.sessionId && !String(sessionState.sessionId).startsWith("direct:")
      ? sessionState.sessionId
      : null;
  return { activeCdp, sessionId };
}

async function setInspectModeForSession(cdp, sessionState, mode) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  const params = mode === "none"
    ? { mode: "none" }
    : {
        mode: "searchForNode",
        highlightConfig: {
          showInfo: true,
          showStyles: true,
          showRulers: false,
          contentColor: { r: 255, g: 102, b: 0, a: 0.15 },
          paddingColor: { r: 255, g: 170, b: 102, a: 0.2 },
          borderColor: { r: 255, g: 102, b: 0, a: 0.5 },
          marginColor: { r: 255, g: 204, b: 153, a: 0.2 },
        },
      };
  return safeSend(activeCdp, "Overlay.setInspectMode", params, sessionId);
}

async function installPageSelectionCapture(cdp, state, sessionState, workflowId) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  const expression = `(() => {
    const key = "__chromeInspectAgentState";
    const state = window[key] || (window[key] = {});
    const sameWorkflow = state.workflowId === ${JSON.stringify(workflowId)};
    state.workflowId = ${JSON.stringify(workflowId)};
    if (!sameWorkflow) {
      state.selected = null;
      state.selectedElement = null;
      state.cancelled = false;
      state.armedAt = Date.now();
    } else {
      state.cancelled = false;
      state.armedAt = state.armedAt || Date.now();
    }

    if (state.listenerInstalled) {
      if (state.highlighted) {
        state.highlighted.style.outline = state.previousOutline || "";
        state.highlighted.style.outlineOffset = state.previousOutlineOffset || "";
      }
      if (state.handleMove) document.removeEventListener("mousemove", state.handleMove, true);
      if (state.handleClick) document.removeEventListener("click", state.handleClick, true);
      if (state.handleKeydown) document.removeEventListener("keydown", state.handleKeydown, true);
      if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
      if (state.banner && state.banner.isConnected) state.banner.remove();
      state.listenerInstalled = false;
      state.handleMove = null;
      state.handleClick = null;
      state.handleKeydown = null;
      state.heartbeatTimer = null;
      state.banner = null;
      state.highlighted = null;
      state.previousOutline = "";
      state.previousOutlineOffset = "";
    }

    if (!state.listenerInstalled) {
      state.listenerInstalled = true;
      state.previousCursor = document.documentElement.style.cursor || "";
      state.highlighted = null;
      state.previousOutline = "";
      state.previousOutlineOffset = "";
      state.banner = null;
      state.heartbeatTimer = null;

      state.renderBanner = (message, accent = "#ff6600") => {
        let banner = state.banner;
        if (!banner || !banner.isConnected) {
          banner = document.createElement("div");
          banner.setAttribute("data-chrome-inspect-banner", "true");
          banner.style.position = "fixed";
          banner.style.top = "16px";
          banner.style.right = "16px";
          banner.style.zIndex = "2147483647";
          banner.style.maxWidth = "360px";
          banner.style.padding = "12px 14px";
          banner.style.borderRadius = "12px";
          banner.style.background = "rgba(18, 18, 18, 0.92)";
          banner.style.color = "#fff";
          banner.style.font = "600 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
          banner.style.boxShadow = "0 12px 36px rgba(0,0,0,0.35)";
          banner.style.border = "2px solid " + accent;
          banner.style.pointerEvents = "none";
          banner.style.whiteSpace = "pre-wrap";
          document.documentElement.appendChild(banner);
          state.banner = banner;
        }
        banner.style.borderColor = accent;
        banner.textContent = message;
      };

      state.updateHeartbeat = () => {
        const current = window[key];
        if (!current) return;
        current.heartbeat = {
          at: Date.now(),
          workflowId: current.workflowId || null,
          hoveredTagName: current.highlighted ? current.highlighted.tagName : null,
          hoveredId: current.highlighted && current.highlighted.id ? current.highlighted.id : null,
          hoveredClassName: current.highlighted && typeof current.highlighted.className === "string"
            ? current.highlighted.className
            : null,
          selected: current.selected || null,
          cancelled: !!current.cancelled
        };
      };

      state.handleMove = (event) => {
        const el = event.target instanceof Element ? event.target : null;
        if (!el) return;
        if (state.highlighted && state.highlighted !== el) {
          state.highlighted.style.outline = state.previousOutline;
          state.highlighted.style.outlineOffset = state.previousOutlineOffset;
        }
        if (state.highlighted !== el) {
          state.previousOutline = el.style.outline || "";
          state.previousOutlineOffset = el.style.outlineOffset || "";
        }
        state.highlighted = el;
        el.style.outline = "2px solid #ff6600";
        el.style.outlineOffset = "2px";
        state.updateHeartbeat();
      };

      state.handleClick = (event) => {
        const current = window[key];
        if (!current || !current.workflowId) return;
        const el = event.target instanceof Element ? event.target : null;
        if (!el) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        current.selectedElement = el;
        current.selected = {
          workflowId: current.workflowId,
          at: Date.now(),
          tagName: el.tagName,
          id: el.id || null,
          className: typeof el.className === "string" ? el.className : null,
          clientX: typeof event.clientX === "number" ? event.clientX : null,
          clientY: typeof event.clientY === "number" ? event.clientY : null
        };
        current.updateHeartbeat();
        current.renderBanner("Element selected. Return to the agent for the next step.", "#1a9c5a");
      };

      state.handleKeydown = (event) => {
        const current = window[key];
        if (!current) return;
        if (event.key === "Escape") {
          current.cancelled = true;
          current.selected = null;
          current.selectedElement = null;
          current.updateHeartbeat();
          current.renderBanner("Selection cancelled. Start capture again when ready.", "#cc3344");
        }
      };

      document.addEventListener("mousemove", state.handleMove, true);
      document.addEventListener("click", state.handleClick, true);
      document.addEventListener("keydown", state.handleKeydown, true);
      state.heartbeatTimer = window.setInterval(() => state.updateHeartbeat(), 1000);
    }

    document.documentElement.style.cursor = "crosshair";
    if (state.selected) {
      state.renderBanner("Element selected. Return to the agent for the next step.", "#1a9c5a");
    } else {
      state.renderBanner("Chrome Inspect is armed. Click any element on the page to select it.\\nPress Esc to cancel.", "#ff6600");
    }
    state.updateHeartbeat();
    return { workflowId: state.workflowId, armedAt: state.armedAt };
  })()`;

  await activeCdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );

  const inspectModeResult = await setInspectModeForSession(cdp, sessionState, "searchForNode");
  if (!inspectModeResult.ok) {
    const detail = inspectModeResult.error?.message || inspectModeResult.error || "unknown error";
    state.lastObservedError = `Overlay.setInspectMode unavailable for target ${sessionState?.targetId || "unknown"}: ${detail}`;
    logSignal("inspect_mode_arm_error", {
      workflowId,
      targetId: sessionState?.targetId || null,
      error: state.lastObservedError,
    });
  } else {
    logSignal("inspect_mode_armed", { workflowId, targetId: sessionState?.targetId || null });
  }
}

async function clearPageSelectionCapture(cdp, sessionState) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  const expression = `(() => {
    const state = window.__chromeInspectAgentState;
    if (!state) return false;
    if (state.highlighted) {
      state.highlighted.style.outline = state.previousOutline || "";
      state.highlighted.style.outlineOffset = state.previousOutlineOffset || "";
    }
    if (state.handleMove) document.removeEventListener("mousemove", state.handleMove, true);
    if (state.handleClick) document.removeEventListener("click", state.handleClick, true);
    if (state.handleKeydown) document.removeEventListener("keydown", state.handleKeydown, true);
    if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
    if (state.banner && state.banner.isConnected) state.banner.remove();
    document.documentElement.style.cursor = state.previousCursor || "";
    delete window.__chromeInspectAgentState;
    return true;
  })()`;
  try {
    await activeCdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
  } catch {
    // Ignore cleanup failures on navigation/closed targets.
  }
  await setInspectModeForSession(cdp, sessionState, "none");
}

async function armPageSelectionCapture(cdp, state, workflowId) {
  const targetIds = [...state.targetsById.keys()];
  for (const targetId of targetIds) {
    const sessionState = state.targetsById.get(targetId);
    if (!sessionState) {
      continue;
    }
    try {
      await installPageSelectionCapture(cdp, state, sessionState, workflowId);
      logSignal("page_capture_armed", { workflowId, targetId });
    } catch (err) {
      state.lastObservedError = `page capture arm failed for ${targetId}: ${err?.message || err}`;
      logSignal("page_capture_arm_error", { workflowId, targetId, error: state.lastObservedError });
    }
  }
}

async function resolveSelectionByPageClick(cdp, state, sessionState, pageInfo, workflowId) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);

  let metaResult = null;
  try {
    metaResult = await activeCdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const state = window.__chromeInspectAgentState;
          if (!state || state.workflowId !== ${JSON.stringify(workflowId)}) return null;
          if (state.cancelled) return { cancelled: true, workflowId: state.workflowId };
          return state.selected ? { ...state.selected } : null;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );
  } catch {
    return null;
  }

  const meta = metaResult?.result?.value || null;
  if (!meta) {
    return null;
  }
  if (meta.cancelled) {
    throw new Error("Page selection was cancelled with Escape. Start capture again to select an element.");
  }

  let nodeId = null;
  let backendNodeId = null;
  if (typeof meta.clientX === "number" && typeof meta.clientY === "number") {
    try {
      const hit = await activeCdp.send(
        "DOM.getNodeForLocation",
        {
          x: Math.round(meta.clientX),
          y: Math.round(meta.clientY),
          includeUserAgentShadowDOM: true,
          ignorePointerEventsNone: true,
        },
        sessionId,
      );
      nodeId = hit?.nodeId || null;
      backendNodeId = hit?.backendNodeId || null;
    } catch {
      nodeId = null;
      backendNodeId = null;
    }
  }

  if (!nodeId) {
    let selectedElementHandle = null;
    try {
      selectedElementHandle = await activeCdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const state = window.__chromeInspectAgentState;
            if (!state || state.workflowId !== ${JSON.stringify(workflowId)}) return null;
            return state.selectedElement || null;
          })()`,
          returnByValue: false,
          awaitPromise: true,
        },
        sessionId,
      );
    } catch {
      selectedElementHandle = null;
    }

    const objectId = selectedElementHandle?.result?.objectId;
    if (objectId) {
      try {
        const request = await activeCdp.send("DOM.requestNode", { objectId }, sessionId);
        nodeId = request?.nodeId || null;
      } catch {
        nodeId = null;
      }
    }
  }
  if (!nodeId && !backendNodeId) {
    return null;
  }

  const syntheticSelection = {
    backendNodeId: backendNodeId || null,
    nodeId,
    targetId: sessionState.targetId,
    frameId: sessionState.frameId || pageInfo.frameId || null,
    eventTime: meta.at || Date.now(),
    selectionSource: "page_click",
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
    "page_click",
  );
}

async function readPageCaptureHeartbeat(cdp, sessionState, workflowId) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  try {
    const result = await activeCdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const s = window.__chromeInspectAgentState;
          if (!s || s.workflowId !== ${JSON.stringify(workflowId)}) return null;
          return {
            heartbeat: s.heartbeat || null,
            selected: s.selected || null,
            cancelled: !!s.cancelled,
            armedAt: s.armedAt || null,
            listenerInstalled: !!s.listenerInstalled
          };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );
    return result?.result?.value || null;
  } catch {
    return null;
  }
}

async function resolveSelectionByActiveElement(cdp, state, sessionState, pageInfo) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);

  let activeResult = null;
  try {
    activeResult = await activeCdp.send(
      "Runtime.evaluate",
      {
        expression: "document && document.activeElement ? document.activeElement : null",
        returnByValue: false,
      },
      sessionId,
    );
  } catch {
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
  } catch {
    return null;
  }
  if (!nodeId) {
    return null;
  }

  let described = null;
  try {
    described = await activeCdp.send("DOM.describeNode", { nodeId }, sessionId);
  } catch {
    return null;
  }
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
    "active_element_fallback",
  );
}

async function materializeSelectionPayload(cdp, state, selection) {
  if (!selection || !selection.targetId) {
    throw new Error("No selected element is available yet. Select a node in Chrome inspect mode and retry.");
  }
  const sessionState = state.targetsById.get(selection.targetId);
  if (!sessionState || (!sessionState.sessionId && !sessionState.cdp)) {
    throw new Error("Could not match the selected element to a live page target. Re-select the element and retry.");
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
    selection.selectionSource || "overlay_event",
  );
}

async function resolveLatestSelection(state, cdp, waitForSelectionMs, timeoutMs) {
  const currentSelection = await readJsonIfPresent(state.store.currentSelectionPath);
  if (currentSelection?.payload?.selectedElement) {
    return currentSelection.payload;
  }

  const start = Date.now();
  const deadline = timeoutMs > 0 ? start + timeoutMs : Number.POSITIVE_INFINITY;

  while (Date.now() < deadline) {
    const selection = await waitForSelection(
      state,
      Math.min(waitForSelectionMs, Math.max(0, deadline - Date.now())),
      start,
    );
    if (selection) {
      return materializeSelectionPayload(cdp, state, selection);
    }

    for (const [targetId, sessionState] of state.targetsById) {
      const pageInfo = state.targetInfosByTargetId.get(targetId) || {};
      const activeWorkflowId = state.activeWorkflowId;
      if (activeWorkflowId) {
        const pageClickPayload = await resolveSelectionByPageClick(
          cdp,
          state,
          sessionState,
          pageInfo,
          activeWorkflowId,
        );
        if (pageClickPayload) {
          return pageClickPayload;
        }
      }
      const payload = await resolveSelectionByActiveElement(cdp, state, sessionState, pageInfo);
      if (payload) {
        return payload;
      }
    }

    if (timeoutMs === 0) {
      await sleep(DEFAULT_POLL_MS);
    } else if (Date.now() >= deadline) {
      break;
    } else {
      await sleep(Math.min(DEFAULT_POLL_MS, deadline - Date.now()));
    }
  }

  throw new Error(formatSelectionNotReadyMessage(timeoutMs, state));
}

async function tryResolveLatestSelection(state, cdp, waitForSelectionMs, timeoutMs) {
  try {
    return await resolveLatestSelection(state, cdp, waitForSelectionMs, timeoutMs);
  } catch (err) {
    const message = String(err?.message || "");
    if (message.startsWith("No selected element is available yet.")) {
      return null;
    }
    throw err;
  }
}

async function createCaptureWorkflow(state) {
  const workflowId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  state.activeWorkflowId = workflowId;
  const workflow = await persistWorkflowState(state.store, state, workflowId, {
    status: "waiting_for_selection",
    phase: "waiting_for_selection",
  });
  await persistSessionState(state.store, state, { status: "waiting_for_selection" });
  logSignal("workflow_created", { workflowId, sequence: workflow.sequence });
  return workflow;
}

function workflowToAwaitingPayload(workflow) {
  const payload = workflow.payload;
  return {
    phase: "awaiting_user_instruction",
    workflowId: workflow.workflowId,
    status: "awaiting_user_instruction",
    summary: workflow.summary || inspectSummary(payload),
    selectedElement: payload.selectedElement,
    position: payload.position,
    page: payload.page,
    selectionSource: workflow.selectionSource || payload.selectionSource || null,
    nextStep: {
      action: "apply_instruction",
      workflowId: workflow.workflowId,
      instruction: "How should I edit it?",
    },
  };
}

async function awaitWorkflowSelection(state, cdp, workflowId, waitForSelectionMs, timeoutMs) {
  let workflow = await readWorkflow(state.store, workflowId);
  if (!workflow) {
    throw new Error(`Unknown inspect workflow: ${workflowId}`);
  }
  if (isSelectionReady(workflow) && workflow.payload) {
    return workflowToAwaitingPayload(workflow);
  }
  if (workflow.status === "ready_to_apply" && workflow.payload) {
    return workflowToAwaitingPayload(workflow);
  }
  if (workflow.status === "browser_disconnected") {
    throw new Error("The browser inspect session disconnected before a selection was recorded.");
  }
  if (workflow.status === "error") {
    throw new Error(workflow.error || "The inspect workflow entered an error state.");
  }

  logSignal("waiting_for_selection", { workflowId, timeoutMs });

  const pollMs = Math.max(DEFAULT_POLL_MS, Math.min(waitForSelectionMs, 1000));
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  while (true) {
    const remaining = deadline - Date.now();
    const chunkTimeout = Number.isFinite(deadline)
      ? Math.max(0, Math.min(pollMs, remaining))
      : pollMs;

    const observed = await waitForFileSignal({
      filePath: state.store.workflowPath(workflowId),
      predicate: (candidate) =>
        candidate?.status === "selection_received" ||
        candidate?.status === "awaiting_user_instruction" ||
        candidate?.status === "ready_to_apply" ||
        candidate?.status === "browser_disconnected" ||
        candidate?.status === "error",
      timeoutMs: chunkTimeout,
      pollMs,
    });

    workflow = observed || (await readWorkflow(state.store, workflowId));
    if (isSelectionReady(workflow) && workflow?.payload) {
      const finalized = await persistWorkflowState(state.store, state, workflowId, {
        status: "awaiting_user_instruction",
        phase: "awaiting_user_instruction",
        payload: workflow.payload,
        selectedElement: workflow.payload.selectedElement,
        position: workflow.payload.position,
        page: workflow.payload.page,
        summary: workflow.summary || inspectSummary(workflow.payload),
        selectionSource: workflow.selectionSource || workflow.payload.selectionSource || null,
      });
      await persistSessionState(state.store, state, { status: "bridge_ready" });
      return workflowToAwaitingPayload(finalized);
    }

    if (workflow?.status === "browser_disconnected") {
      throw new Error("The browser inspect session disconnected before a selection was recorded.");
    }
    if (workflow?.status === "error") {
      throw new Error(workflow.error || "The inspect workflow entered an error state.");
    }

    let heartbeat = null;
    for (const sessionState of state.targetsById.values()) {
      const captureState = await readPageCaptureHeartbeat(cdp, sessionState, workflowId);
      if (!captureState) {
        continue;
      }
      heartbeat = captureState;
      break;
    }
    if (heartbeat) {
      workflow = await persistWorkflowState(state.store, state, workflowId, {
        status: "waiting_for_selection",
        phase: "waiting_for_selection",
        error: heartbeat.cancelled
          ? "Selection cancelled on page. Start capture again."
          : null,
        payload: workflow?.payload || null,
        selectedElement: workflow?.selectedElement || null,
        position: workflow?.position || null,
        page: workflow?.page || null,
        summary: workflow?.summary || null,
        selectionSource: workflow?.selectionSource || null,
        heartbeat,
      });
    }

    const fallback = await tryResolveLatestSelection(state, cdp, waitForSelectionMs, pollMs);
    if (fallback) {
      await persistRecoveredSelection(state, workflowId, fallback);
      const recovered = await persistWorkflowState(state.store, state, workflowId, {
        status: "awaiting_user_instruction",
        phase: "awaiting_user_instruction",
        payload: fallback,
        selectedElement: fallback.selectedElement,
        position: fallback.position,
        page: fallback.page,
        summary: inspectSummary(fallback),
        selectionSource: fallback.selectionSource || "active_element_fallback",
      });
      await persistSessionState(state.store, state, { status: "bridge_ready" });
      return workflowToAwaitingPayload(recovered);
    }

    if (Date.now() >= deadline) {
      break;
    }
  }

  if (!workflow || workflow.status === "waiting_for_selection") {
    const fallback = await resolveLatestSelection(
      state,
      cdp,
      waitForSelectionMs,
      timeoutMs === 0 ? waitForSelectionMs * 2 : timeoutMs,
    );
    await persistRecoveredSelection(state, workflowId, fallback);
    const recovered = await persistWorkflowState(state.store, state, workflowId, {
      status: "awaiting_user_instruction",
      phase: "awaiting_user_instruction",
      payload: fallback,
      selectedElement: fallback.selectedElement,
      position: fallback.position,
      page: fallback.page,
      summary: inspectSummary(fallback),
      selectionSource: fallback.selectionSource || "active_element_fallback",
    });
    return workflowToAwaitingPayload(recovered);
  }

  if (workflow.status === "browser_disconnected") {
    throw new Error("The browser inspect session disconnected before a selection was recorded.");
  }
  if (workflow.status === "error") {
    throw new Error(workflow.error || "The inspect workflow entered an error state.");
  }

  throw new Error(formatSelectionNotReadyMessage(timeoutMs, state));
}

export async function handleInspectAction(cdp, state, args, messageId) {
  const action = typeof args.action === "string" ? args.action : "capture";
  const waitForSelectionMs = clampInt(args.waitForSelectionMs, DEFAULT_MIN_WAIT_MS, 60000, DEFAULT_WAIT_MS);
  const timeoutMs = clampInt(args.timeoutMs, 0, 60000, action === "capture" ? 0 : DEFAULT_TIMEOUT_MS);

  if (action === "begin_capture") {
    const workflow = await createCaptureWorkflow(state);
    await armPageSelectionCapture(cdp, state, workflow.workflowId);
    return {
      phase: "waiting_for_selection",
      workflowId: workflow.workflowId,
      status: "waiting_for_selection",
      sequence: workflow.sequence,
    };
  }

  if (action === "get_status") {
    const workflow = await readWorkflow(state.store, args.workflowId);
    if (!workflow) {
      throw new Error(`Unknown inspect workflow: ${args.workflowId || "(missing workflowId)"}`);
    }
    return workflow.payload && isSelectionReady(workflow)
      ? workflowToAwaitingPayload(workflow)
      : {
          phase: workflow.phase || workflow.status,
          workflowId: workflow.workflowId,
          status: workflow.status,
          sequence: workflow.sequence,
          error: workflow.error || null,
        };
  }

  if (action === "await_selection") {
    if (typeof args.workflowId !== "string" || !args.workflowId.trim()) {
      throw new Error("inspect(action='await_selection') requires workflowId.");
    }
    return awaitWorkflowSelection(state, cdp, args.workflowId.trim(), waitForSelectionMs, timeoutMs);
  }

  if (action === "capture") {
    const workflow = await createCaptureWorkflow(state);
    await armPageSelectionCapture(cdp, state, workflow.workflowId);
    return awaitWorkflowSelection(state, cdp, workflow.workflowId, waitForSelectionMs, timeoutMs);
  }

  if (action !== "apply_instruction") {
    throw new Error(`Unsupported inspect action: ${action}`);
  }

  const workflowId =
    typeof args.workflowId === "string" && args.workflowId.trim()
      ? args.workflowId.trim()
      : state.activeWorkflowId;
  if (!workflowId) {
    throw new Error("inspect(action='apply_instruction') requires workflowId.");
  }

  const workflow = await readWorkflow(state.store, workflowId);
  if (!workflow || !workflow.payload) {
    throw new Error("There is no completed inspect selection for this workflow. Run begin_capture/await_selection first.");
  }
  if (!workflow.selectedElement && !workflow.payload?.selectedElement) {
    throw new Error("The inspect workflow does not have a selected element yet.");
  }
  if (typeof args.instruction !== "string" || !args.instruction.trim()) {
    return {
      phase: "awaiting_user_instruction",
      workflowId,
      selectedElement: workflow.payload.selectedElement,
      position: workflow.payload.position,
      page: workflow.payload.page,
      message: "No DOM instruction was provided yet. Describe the change you want to make.",
    };
  }

  const updated = await persistWorkflowState(state.store, state, workflowId, {
    status: "ready_to_apply",
    phase: "ready_to_apply",
    payload: workflow.payload,
    selectedElement: workflow.payload.selectedElement,
    position: workflow.payload.position,
    page: workflow.payload.page,
    summary: workflow.summary || inspectSummary(workflow.payload),
    selectionSource: workflow.selectionSource || workflow.payload.selectionSource || null,
    userInstruction: args.instruction.trim(),
  });
  await persistSessionState(state.store, state, { status: "bridge_ready" });
  for (const sessionState of state.targetsById.values()) {
    await clearPageSelectionCapture(cdp, sessionState);
  }
  logSignal("instruction_recorded", { workflowId, sequence: updated.sequence });

  return {
    phase: "ready_to_apply",
    workflowId,
    selectedElement: updated.payload.selectedElement,
    position: updated.payload.position,
    page: updated.payload.page,
    userInstruction: updated.userInstruction,
    selectionSource: updated.selectionSource || updated.payload.selectionSource || null,
    nextStep: {
      action: "apply",
      note: "Pass selectedElement, position, page, and userInstruction to the DOM mutation tool.",
      toolingHint: {
        messageId,
        requires: ["execute_javascript", "DOM"],
      },
    },
  };
}

async function recordSelectionForWorkflow(cdp, state, selection) {
  const payload = await materializeSelectionPayload(cdp, state, selection);
  const workflowId = state.activeWorkflowId;

  const currentSelection = await persistCurrentSelection(state.store, state, {
    workflowId: workflowId || null,
    status: "selection_received",
    targetId: selection.targetId || null,
    page: payload.page,
    selectedElement: payload.selectedElement,
    position: payload.position,
    payload,
    selectionSource: payload.selectionSource || "overlay_event",
  });

  if (workflowId) {
    const workflow = await persistWorkflowState(state.store, state, workflowId, {
      status: "selection_received",
      phase: "selection_received",
      targetId: selection.targetId || null,
      page: payload.page,
      selectedElement: payload.selectedElement,
      position: payload.position,
      payload,
      summary: inspectSummary(payload),
      selectionSource: payload.selectionSource || "overlay_event",
      error: null,
    });
    logSignal("selection_recorded", {
      workflowId,
      sequence: workflow.sequence,
      targetId: selection.targetId || null,
    });
  } else {
    logSignal("selection_recorded_without_workflow", {
      sequence: currentSelection.sequence,
      targetId: selection.targetId || null,
    });
  }

  await persistSessionState(state.store, state, {
    status: workflowId ? "selection_received" : "bridge_ready",
  });

  notifySelectionWaiters(state, selection);
  return payload;
}

function queueSelectionRecord(cdp, state, selection) {
  state.selectionRecorder = state.selectionRecorder
    .then(() => recordSelectionForWorkflow(cdp, state, selection))
    .catch(async (err) => {
      state.lastObservedError = err?.message || String(err);
      logSignal("selection_record_error", { error: state.lastObservedError });
      if (state.activeWorkflowId) {
        await persistWorkflowState(state.store, state, state.activeWorkflowId, {
          status: "error",
          phase: "error",
          error: state.lastObservedError,
        });
      }
      await persistSessionState(state.store, state, {
        status: "error",
        error: state.lastObservedError,
      });
      return null;
    });
  return state.selectionRecorder;
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
    safeSend(sessionCdp, "DOM.getDocument", {}, effectiveSessionId),
    safeSend(sessionCdp, "Page.enable", {}, effectiveSessionId),
    safeSend(sessionCdp, "Overlay.enable", {}, effectiveSessionId),
    safeSend(sessionCdp, "Runtime.enable", {}, effectiveSessionId),
  ]);
  const overlayEnabled = safeResults[3].ok;
  if (!overlayEnabled) {
    state.lastObservedError = `Overlay.enable unavailable for target ${targetInfo.targetId}: ${safeResults[3].error?.message || safeResults[3].error}`;
  }

  let frameId = null;
  try {
    const frameTree = await sessionCdp.send("Page.getFrameTree", {}, effectiveSessionId);
    frameId = frameTree?.frameTree?.frame?.id || null;
  } catch {
    // Ignore frame tree failures.
  }

  const sessionKey = effectiveSessionId || `direct:${targetInfo.targetId}`;
  state.targetsById.set(targetInfo.targetId, {
    targetId: targetInfo.targetId,
    sessionId: sessionKey,
    cdp: sessionCdp,
    frameId,
  });
  state.targetsBySessionId.set(sessionKey, targetInfo.targetId);
  logSignal("target_attached", { targetId: targetInfo.targetId, direct: useDirectSession });

  if (overlayEnabled) {
    const sessionState = state.targetsById.get(targetInfo.targetId);
    sessionCdp.onEvent((message) => {
      if (useDirectSession) {
        if (message.method !== "Overlay.inspectNodeRequested") {
          return;
        }
      } else if (message.sessionId !== sessionId) {
        return;
      }

      if (message.method !== "Overlay.inspectNodeRequested") {
        return;
      }
      state.lastSelectionEvent = {
        ...message.params,
        targetId: targetInfo.targetId,
        sessionId: sessionState.sessionId,
        eventTime: Date.now(),
      };
      void queueSelectionRecord(cdp, state, state.lastSelectionEvent);
    });
  }

  if (state.activeWorkflowId) {
    try {
      await installPageSelectionCapture(cdp, state, state.targetsById.get(targetInfo.targetId), state.activeWorkflowId);
      logSignal("page_capture_armed", { workflowId: state.activeWorkflowId, targetId: targetInfo.targetId });
    } catch (err) {
      state.lastObservedError = `page capture arm failed for ${targetInfo.targetId}: ${err?.message || err}`;
      logSignal("page_capture_arm_error", { workflowId: state.activeWorkflowId, targetId: targetInfo.targetId, error: state.lastObservedError });
    }
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

async function markActiveWorkflowDisconnected(state, message) {
  if (!state.activeWorkflowId) {
    await persistSessionState(state.store, state, {
      status: "browser_disconnected",
      error: message,
    });
    return;
  }
  await persistWorkflowState(state.store, state, state.activeWorkflowId, {
    status: "browser_disconnected",
    phase: "browser_disconnected",
    error: message,
  });
  await persistSessionState(state.store, state, {
    status: "browser_disconnected",
    error: message,
  });
  logSignal("browser_disconnected", { workflowId: state.activeWorkflowId, message });
}

export async function start() {
  const args = parseFlags(process.argv.slice(2));
  const debugUrl = args["browser-url"] || "http://127.0.0.1:9223";
  const upstreamBin = args["upstream-bin"] || "";

  const version = await fetchJson(`${debugUrl}/json/version`);
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error(`No webSocketDebuggerUrl from ${debugUrl}/json/version`);
  }

  const browserUrl = new URL(debugUrl);
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
    activeWorkflowId: null,
    selectionRecorder: Promise.resolve(),
    store: createInspectStore({
      debugHost: browserUrl.hostname,
      debugPort: browserUrl.port || "80",
    }),
    storeSequence: 0,
  };

  await initializeStoreState(state.store, state);

  let targetInfos = await loadTargetsFromTargetDomain(cdp, state);
  if (!targetInfos.length) {
    targetInfos = await loadTargetsFromDebugList(debugUrl, state);
  }
  if (!targetInfos.length) {
    throw new Error("No page target is available. Open a page in Chrome first and retry.");
  }

  for (const info of targetInfos) {
    if (info.type !== "page") {
      continue;
    }
    updateTargetInfo(state, info);
    try {
      await attachPageTarget(cdp, info, state);
    } catch (err) {
      state.lastObservedError = `attach page failed: ${err?.message || err}`;
    }
  }

  if (!state.targetsById.size) {
    throw new Error(`Failed to attach any page target for inspection. Last error: ${state.lastObservedError || "unknown"}`);
  }

  await persistSessionState(state.store, state, { status: "bridge_ready" });
  logSignal("bridge_ready", { targets: state.targetsById.size, store: state.store.inspectDir });

  cdp.onEvent((message) => {
    if (!state.targetDomainAvailable || !message?.method) {
      return;
    }

    if (message.method === "Target.targetCreated" && message.params?.targetInfo?.type === "page") {
      const info = message.params.targetInfo;
      updateTargetInfo(state, info);
      attachPageTarget(cdp, info, state).catch((err) => {
        state.lastObservedError = `attach page failed: ${err?.message || err}`;
      });
      return;
    }

    if (message.method === "Target.targetDestroyed" && message.params?.targetId) {
      const targetId = message.params.targetId;
      const session = state.targetsById.get(targetId);
      if (session?.sessionId) {
        state.targetsBySessionId.delete(session.sessionId);
      }
      state.targetsById.delete(targetId);
      state.targetInfosByTargetId.delete(targetId);
      logSignal("target_detached", { targetId });
      if (!state.targetsById.size) {
        void markActiveWorkflowDisconnected(state, "All page targets were detached.");
      }
      return;
    }

    if (message.method === "Target.targetInfoChanged" && message.params?.targetInfo) {
      updateTargetInfo(state, message.params.targetInfo);
      return;
    }

    if (message.sessionId && message.method === "Overlay.inspectNodeRequested") {
      const targetId = state.targetsBySessionId.get(message.sessionId);
      if (!targetId) {
        return;
      }
      state.lastSelectionEvent = {
        ...message.params,
        targetId,
        sessionId: message.sessionId,
        eventTime: Date.now(),
      };
      void queueSelectionRecord(cdp, state, state.lastSelectionEvent);
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
  child.on("exit", async (code) => {
    await markActiveWorkflowDisconnected(state, "The upstream MCP bridge exited.");
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

    if (message.method === "tools/call" && message.params?.name === "inspect_selected_element") {
      const args = message.params?.arguments || {};
      const waitForSelectionMs = clampInt(args.waitForSelectionMs, DEFAULT_MIN_WAIT_MS, 60000, DEFAULT_WAIT_MS);
      const timeoutMs = clampInt(args.timeoutMs, 0, 60000, DEFAULT_TIMEOUT_MS);

      try {
        let payload = null;
        const currentSelection = await readJsonIfPresent(state.store.currentSelectionPath);
        if (currentSelection?.payload?.selectedElement) {
          payload = currentSelection.payload;
        } else {
          payload = await resolveLatestSelection(state, cdp, waitForSelectionMs, timeoutMs);
        }
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
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
              message: err?.message || "failed to inspect selected element",
            },
          }),
        );
      }
      return;
    }

    if (message.method === "tools/call" && message.params?.name === "inspect") {
      const args = message.params?.arguments || {};
      try {
        const payload = await handleInspectAction(cdp, state, args, message.id);
        process.stdout.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
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
              message: err?.message || "failed to run inspect workflow",
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

  process.on("SIGINT", async () => {
    await markActiveWorkflowDisconnected(state, "The inspect bridge received SIGINT.");
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  start().catch((err) => {
    process.stderr.write(`${err?.message || err}\n`);
    process.exit(1);
  });
}
