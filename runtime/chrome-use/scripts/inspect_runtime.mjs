#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  watch as fsWatch,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MIN_WAIT_MS = 500;
const DEFAULT_POLL_MS = 250;
const TARGET_RECONCILE_MS = 1000;
const DEFAULT_TRUNCATE = 400;
const CDP_METHOD_NOT_FOUND_CODE = -32601;
const BRIDGE_OWNER_VERSION = 1;
const PAGE_TOOLBAR_STATE_SIGNAL_PREFIX = "__chromeInspectToolbarState:";

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

function inspectSummary(payload) {
  const { selectedElement, page, position } = payload;
  const label = selectedElement.selectorHint || selectedElement.descriptionText || "(unknown)";
  const id = selectedElement.id || "(no id)";
  const title = page.title || "(no title)";
  return `${label} (${selectedElement.nodeName || "UNKNOWN"}) [id:${id}] on ${title} at ${page.url || "(no url)"} ` +
    `at ${position.x !== null ? position.x.toFixed(2) : "?"}x${position.y !== null ? position.y.toFixed(2) : "?"}, ` +
    `${position.width !== null ? position.width.toFixed(2) : "?"}×${position.height !== null ? position.height.toFixed(2) : "?"}`;
}

function inspectSelectionBadgeSummary(payload) {
  if (!payload?.selectedElement) {
    return "";
  }
  const selector =
    payload.selectedElement.selectorHint ||
    payload.selectedElement.descriptionText ||
    payload.selectedElement.nodeName ||
    "element";
  const snippet = String(payload.selectedElement.snippet || "")
    .replace(/\s+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .trim();
  const text = safeTruncate(snippet, 72);
  return text ? `${selector} - ${text}` : selector;
}

function formatPagePathForToolbar(rawUrl) {
  if (!rawUrl) {
    return "Current page";
  }
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname || "/";
    return pathname.startsWith("/") ? pathname : `/${pathname}`;
  } catch {
    const normalized = String(rawUrl).trim();
    if (!normalized) {
      return "Current page";
    }
    return normalized.replace(/^[a-z]+:\/\/[^/]+/i, "") || normalized;
  }
}

function formatElementPathForToolbar(selectedElement) {
  if (!selectedElement) {
    return "element";
  }
  const explicitPath = safeTruncate(String(selectedElement.elementPath || "").trim(), 160);
  if (explicitPath) {
    return explicitPath;
  }
  const tag = selectedElement.nodeName
    ? String(selectedElement.nodeName).toLowerCase()
    : "element";
  const aria = safeTruncate(String(selectedElement.ariaLabel || "").trim(), 32);
  if (aria) {
    return `${tag} [${aria}]`;
  }
  const selectorHint = String(selectedElement.selectorHint || "").trim();
  if (selectorHint && selectorHint !== tag) {
    return safeTruncate(`${tag} ${selectorHint}`, 40);
  }
  return tag;
}

function formatSelectedTextForToolbar(payload) {
  if (!payload?.selectedElement) {
    return "Selection captured.";
  }
  const snippet = String(payload.selectedElement.snippet || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (snippet) {
    return safeTruncate(snippet, 120);
  }
  const label = payload.selectedElement.ariaLabel || payload.selectedElement.descriptionText || payload.selectedElement.selectorHint;
  if (label) {
    return safeTruncate(String(label).trim(), 120);
  }
  return formatElementPathForToolbar(payload.selectedElement);
}

function buildToolbarSelectionDetails(payload) {
  if (!payload?.selectedElement) {
    return {
      selected: "",
      content: "",
      page: "",
      element: "",
    };
  }
  return {
    selected: inspectSelectionBadgeSummary(payload),
    content: formatSelectedTextForToolbar(payload),
    page: formatPagePathForToolbar(payload.page?.url),
    element: formatElementPathForToolbar(payload.selectedElement),
  };
}

function buildToolbarSelectionDetailsFromMeta(meta) {
  if (!meta) {
    return {
      selected: "",
      content: "",
      page: "",
      element: "",
    };
  }
  const tag = meta.tagName ? String(meta.tagName).toLowerCase() : "element";
  const id = meta.id ? `#${meta.id}` : "";
  const classSuffix = meta.className
    ? `.${String(meta.className).split(/\s+/).filter(Boolean).join(".")}`
    : "";
  return {
    selected: safeTruncate(`${tag}${id}${classSuffix}` || tag, 120),
    content: "",
    page: "",
    element: safeTruncate(`${tag}${id}${classSuffix}` || tag, 160),
  };
}

async function deriveElementPath(activeCdp, sessionId, nodeId, backendNodeId) {
  const resolveResult = await safeSend(
    activeCdp,
    "DOM.resolveNode",
    nodeId ? { nodeId } : { backendNodeId },
    sessionId,
  );
  const objectId = resolveResult.result?.object?.objectId;
  if (!resolveResult.ok || !objectId) {
    return null;
  }

  const callResult = await safeSend(
    activeCdp,
    "Runtime.callFunctionOn",
    {
      objectId,
      awaitPromise: true,
      returnByValue: true,
      functionDeclaration: `function() {
        const shorten = (value, max) => {
          const text = String(value || "").trim();
          if (!text) return "";
          return text.length <= max ? text : text.slice(0, max) + "...";
        };
        const describe = (element) => {
          if (!(element instanceof Element)) return "";
          const tag = (element.tagName || "element").toLowerCase();
          const id = element.id ? "#" + element.id : "";
          const classes = typeof element.className === "string"
            ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".")
            : "";
          const classSuffix = classes ? "." + classes : "";
          return shorten(tag + id + classSuffix, 48);
        };
        const parts = [];
        let current = this;
        let depth = 0;
        while (current instanceof Element && depth < 6) {
          const part = describe(current);
          if (part) parts.unshift(part);
          if (current.id) break;
          current = current.parentElement;
          depth += 1;
        }
        return parts.join(" > ");
      }`,
    },
    sessionId,
  );

  await safeSend(activeCdp, "Runtime.releaseObject", { objectId }, sessionId);
  if (!callResult.ok) {
    return null;
  }
  const value = String(callResult.result?.result?.value || "").trim();
  return value || null;
}

async function readLatestSelectionHistoryEntry(store) {
  try {
    const history = await readFile(store.selectionHistoryPath, "utf8");
    const lines = history
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      try {
        const candidate = JSON.parse(lines[idx]);
        if (candidate?.payload?.selectedElement) {
          return candidate;
        }
      } catch {
        // Ignore malformed entries and continue scanning backward.
      }
    }
    return null;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function inspectSelectionBadgeSummaryFromMeta(meta) {
  if (!meta) {
    return "";
  }
  const tag = meta.tagName ? String(meta.tagName).toLowerCase() : "element";
  const id = meta.id ? `#${meta.id}` : "";
  const classSuffix = meta.className
    ? `.${String(meta.className).split(/\s+/).filter(Boolean).join(".")}`
    : "";
  return `${tag}${id}${classSuffix}`;
}

function timingNow() {
  return new Date().toISOString();
}

function logTiming(event, startedAt, details = {}) {
  const startMs = parseTimeMs(startedAt);
  const elapsedMs = startMs === null ? null : Math.max(0, Date.now() - startMs);
  logSignal(event, {
    elapsedMs,
    ...details,
  });
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
  const selectionHistoryPath = path.join(eventsDir, "selection-history.jsonl");
  return {
    rootDir,
    inspectDir,
    workflowsDir,
    eventsDir,
    sessionPath,
    currentSelectionPath,
    selectionHistoryPath,
    ownerPath: path.join(inspectDir, "bridge-owner.json"),
    runtimePath: path.join(inspectDir, "runtime.json"),
    preferredTargetPath: path.join(inspectDir, "preferred-target.json"),
    workflowPath(workflowId) {
      return path.join(workflowsDir, `${workflowId}.json`);
    },
  };
}

function normalizeComparableUrl(value) {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return String(value);
  }
}

export async function selectTargetInfosForStartupUrl(store, targetInfos, startupUrl) {
  if (!Array.isArray(targetInfos) || !targetInfos.length) {
    return targetInfos;
  }

  const latestTarget = targetInfos[targetInfos.length - 1] || null;
  if (!startupUrl) {
    return latestTarget ? [latestTarget] : targetInfos;
  }

  const preferred = await readJsonIfPresent(store.preferredTargetPath);
  const normalizedStartupUrl = normalizeComparableUrl(startupUrl);
  const exactMatches = targetInfos.filter((info) => normalizeComparableUrl(info?.url) === normalizedStartupUrl);
  if (!exactMatches.length) {
    return latestTarget ? [latestTarget] : targetInfos;
  }

  if (preferred?.targetId) {
    const preferredMatch = exactMatches.find((info) => info?.targetId === preferred.targetId);
    if (preferredMatch) {
      return [preferredMatch];
    }
  }

  return [exactMatches[exactMatches.length - 1]];
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

async function appendJsonl(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(data)}\n`);
}

function logSignal(event, details = {}) {
  process.stderr.write(`[chrome-inspect] ${JSON.stringify({
    event,
    time: new Date().toISOString(),
    ...details,
  })}\n`);
}

export function getDefaultDebugUrl() {
  const host = process.env.CHROME_USE_DEBUG_HOST || "127.0.0.1";
  const port = process.env.CHROME_USE_DEBUG_PORT || "9223";
  return `http://${host}:${port}`;
}

async function initializeStoreState(store, state) {
  await ensureInspectStore(store);
  const session = (await readJsonIfPresent(store.sessionPath)) || {};
  state.storeSequence = Number.isFinite(Number(session.sequence)) ? Number(session.sequence) : 0;
  state.activeWorkflowId = typeof session.activeWorkflowId === "string" ? session.activeWorkflowId : null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function isBridgeOwnerOrphaned(owner, isAlive = isPidAlive) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  if (owner.ppid === 1) {
    return true;
  }
  if (!Number.isInteger(owner.ppid) || owner.ppid <= 0) {
    return false;
  }
  return !isAlive(owner.ppid);
}

async function killOwnedProcess(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err?.code !== "ESRCH") {
      throw err;
    }
  }
}

async function sleepUntilProcessExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isPidAlive(pid);
}

async function readBridgeOwner(store) {
  return readJsonIfPresent(store.ownerPath);
}

async function persistBridgeOwner(store, owner) {
  await atomicWriteJson(store.ownerPath, owner);
  return owner;
}

function clearBridgeOwnerSync(store, ownerPid = null) {
  try {
    if (!existsSync(store.ownerPath)) {
      return;
    }
    if (ownerPid !== null) {
      const current = JSON.parse(readFileSync(store.ownerPath, "utf8"));
      if (current?.pid !== ownerPid) {
        return;
      }
    }
    unlinkSync(store.ownerPath);
  } catch {
    // Ignore best-effort cleanup failures.
  }
}

async function clearBridgeOwner(store, ownerPid = null) {
  clearBridgeOwnerSync(store, ownerPid);
}

export async function claimBridgeOwnership(
  store,
  {
    debugUrl,
    startupUrl = "",
    processInfo = {
      pid: process.pid,
      ppid: process.ppid,
      startedAt: new Date().toISOString(),
    },
  },
  {
    isProcessAlive = isPidAlive,
    isOwnerOrphaned = isBridgeOwnerOrphaned,
    terminateProcess = killOwnedProcess,
    waitForExit = sleepUntilProcessExit,
  } = {},
) {
  const existingOwner = await readBridgeOwner(store);
  if (existingOwner?.pid && existingOwner.pid !== processInfo.pid) {
    const ownerAlive = isProcessAlive(existingOwner.pid);
    if (ownerAlive) {
      if (!isOwnerOrphaned(existingOwner, isProcessAlive)) {
        throw new Error(
          `Another inspect bridge is already running for ${debugUrl} (pid ${existingOwner.pid}).`,
        );
      }
      await terminateProcess(existingOwner.pid);
      if (existingOwner.upstreamPid && existingOwner.upstreamPid !== existingOwner.pid) {
        await terminateProcess(existingOwner.upstreamPid);
      }
      const ownerExited = await waitForExit(existingOwner.pid);
      if (existingOwner.upstreamPid && existingOwner.upstreamPid !== existingOwner.pid) {
        const upstreamExited = await waitForExit(existingOwner.upstreamPid);
        if (!upstreamExited) {
          throw new Error(`Could not reclaim inspect bridge ownership from upstream pid ${existingOwner.upstreamPid}.`);
        }
      }
      if (!ownerExited) {
        throw new Error(`Could not reclaim inspect bridge ownership from pid ${existingOwner.pid}.`);
      }
    }
    await clearBridgeOwner(store, existingOwner.pid);
  }

  const owner = {
    version: BRIDGE_OWNER_VERSION,
    pid: processInfo.pid,
    ppid: processInfo.ppid,
    startedAt: processInfo.startedAt,
    debugUrl,
    startupUrl,
    upstreamPid: null,
    claimedAt: new Date().toISOString(),
  };
  await persistBridgeOwner(store, owner);
  return owner;
}

async function refreshBridgeOwner(store, owner, patch = {}) {
  const nextOwner = {
    ...owner,
    ...patch,
  };
  await persistBridgeOwner(store, nextOwner);
  return nextOwner;
}

function isWorkflowCaptureInProgress(workflow) {
  if (!workflow) {
    return false;
  }
  return workflow.status === "waiting_for_selection";
}

export async function restoreActiveWorkflowState(store, state, owner = null) {
  if (!state.activeWorkflowId) {
    return null;
  }

  const workflow = await readWorkflow(store, state.activeWorkflowId);
  const ownerValid = !!owner && owner.pid === process.pid;
  if (isWorkflowCaptureInProgress(workflow) && ownerValid) {
    return workflow;
  }

  state.activeWorkflowId = null;
  return workflow;
}

async function nextSequence(state) {
  state.storeSequence += 1;
  return state.storeSequence;
}

async function persistSessionState(store, state, patch = {}) {
  const previous = (await readJsonIfPresent(store.sessionPath)) || {};
  const sequence = await nextSequence(state);
  const currentOwner = state.bridgeOwner || (await readBridgeOwner(store));
  const session = {
    sequence,
    updatedAt: new Date().toISOString(),
    activeWorkflowId: state.activeWorkflowId || null,
    status: patch.status || previous.status || "bridge_ready",
    lastError: patch.error || previous.lastError || null,
    startupUrl:
      patch.startupUrl !== undefined
        ? patch.startupUrl
        : previous.startupUrl || state.startupUrl || null,
    owner: currentOwner || null,
    targets: [...state.targetInfosByTargetId.values()],
  };
  await atomicWriteJson(store.sessionPath, session);
  return session;
}

function mergeWorkflowMetrics(previousMetrics = {}, patchMetrics = {}) {
  const next = {
    ...previousMetrics,
  };
  for (const [key, value] of Object.entries(patchMetrics)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
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
    captureToken:
      patch.captureToken !== undefined ? patch.captureToken : (previous.captureToken || null),
    armedAt: patch.armedAt !== undefined ? patch.armedAt : (previous.armedAt || null),
    metrics: mergeWorkflowMetrics(previous.metrics || {}, patch.metrics || {}),
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
  await appendJsonl(store.selectionHistoryPath, event);
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
    captureToken: payload.captureToken || null,
  });
}

async function finalizeWorkflowSelection(cdp, state, workflow, payload, targetId = null) {
  const currentSelection = await persistCurrentSelection(state.store, state, {
    workflowId: workflow.workflowId,
    status: "selection_received",
    targetId: targetId || null,
    page: payload.page,
    selectedElement: payload.selectedElement,
    position: payload.position,
    payload,
    selectionSource: payload.selectionSource || "overlay_event",
    captureToken: payload.captureToken || workflow.captureToken || null,
  });

  if (targetId) {
    updateCaptureMetaForTarget(state, targetId, {
      workflowId: workflow.workflowId,
      captureToken: payload.captureToken || workflow.captureToken || null,
      mode: "idle_selected",
      cancelled: false,
      captureActive: false,
      selectedDetails: buildToolbarSelectionDetails(payload),
    });
  }

  const finalized = await persistWorkflowState(state.store, state, workflow.workflowId, {
    status: "selection_received",
    phase: "selection_received",
    targetId: targetId || null,
    page: payload.page,
    selectedElement: payload.selectedElement,
    position: payload.position,
    payload,
    summary: inspectSummary(payload),
    selectionSource: payload.selectionSource || "overlay_event",
    error: null,
    captureToken: workflow.captureToken || payload.captureToken || null,
    metrics: {
      firstSelectionObservedAt: payload.observedAt || timingNow(),
      firstSelectionSource: payload.selectionSource || "overlay_event",
    },
  });

  logSignal("selection_recorded", {
    workflowId: finalized.workflowId,
    sequence: finalized.sequence,
    targetId: targetId || null,
    selectionSource: payload.selectionSource || "overlay_event",
  });

  state.activeWorkflowId = null;
  await applyToolbarStateToAllTargets(cdp, state, {
    workflowId: finalized.workflowId,
    captureToken: finalized.captureToken || payload.captureToken || null,
    mode: "idle_selected",
    cancelled: false,
    captureActive: false,
    selectedDetails: buildToolbarSelectionDetails(payload),
    collapsed: false,
    reason: "selection_recorded",
  });
  await persistSessionState(state.store, state, { status: "bridge_ready" });

  return { currentSelection, workflow: finalized };
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

async function readLatestPersistedSelection(store) {
  const currentSelection = await readJsonIfPresent(store.currentSelectionPath);
  if (currentSelection?.payload?.selectedElement) {
    return currentSelection;
  }
  return readLatestSelectionHistoryEntry(store);
}

export function isCurrentSelectionFreshForWorkflow(currentSelection, workflowId) {
  if (!currentSelection?.payload?.selectedElement) {
    return false;
  }
  if (!workflowId) {
    return true;
  }
  return currentSelection.workflowId === workflowId;
}

function parseTimeMs(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSelectionFreshForWorkflow(currentSelection, workflow) {
  if (!currentSelection?.payload?.selectedElement) {
    return false;
  }
  if (!workflow) {
    return isCurrentSelectionFreshForWorkflow(currentSelection, null);
  }
  if (!isCurrentSelectionFreshForWorkflow(currentSelection, workflow.workflowId)) {
    return false;
  }
  if (workflow.captureToken && currentSelection.captureToken && workflow.captureToken !== currentSelection.captureToken) {
    return false;
  }
  if (workflow.captureToken && !currentSelection.captureToken) {
    const observedAt = parseTimeMs(currentSelection.payload?.observedAt);
    const armedAt = parseTimeMs(workflow.armedAt);
    if (armedAt !== null && observedAt !== null && observedAt < armedAt) {
      return false;
    }
  }
  if (workflow.armedAt && currentSelection.payload?.observedAt) {
    const observedAt = parseTimeMs(currentSelection.payload.observedAt);
    const armedAt = parseTimeMs(workflow.armedAt);
    if (observedAt !== null && armedAt !== null && observedAt < armedAt) {
      return false;
    }
  }
  return true;
}

async function updateWorkflowMetrics(store, state, workflowId, patch = {}) {
  return persistWorkflowState(store, state, workflowId, {
    metrics: patch,
  });
}

export function isRetryableSelectionMaterializationError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Document needs to be requested first");
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
  const domCacheKey = sessionState?.sessionId || selection?.targetId || "root";
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

  await ensureDomReady(activeCdp, sessionId, state, domCacheKey);

  let nodeId = selection.nodeId;
  if (!nodeId && backendNodeId) {
    const pushed = await sendDomCommandWithRecovery(
      activeCdp,
      sessionId,
      state,
      domCacheKey,
      "DOM.pushNodesByBackendIdsToFrontend",
      { backendNodeIds: [backendNodeId] },
    );
    nodeId = pushed?.nodeIds?.[0];
  }
  if (!nodeId) {
    nodeId = backendNodeId;
  }

  const [describeResult, boxResult, outerResult, elementPath] = await Promise.all([
    sendDomCommandWithRecovery(activeCdp, sessionId, state, domCacheKey, "DOM.describeNode", { nodeId }),
    sendDomCommandWithRecovery(activeCdp, sessionId, state, domCacheKey, "DOM.getBoxModel", { nodeId }).catch(() => null),
    sendDomCommandWithRecovery(activeCdp, sessionId, state, domCacheKey, "DOM.getOuterHTML", { nodeId }).catch(async () => {
      try {
        return await sendDomCommandWithRecovery(
          activeCdp,
          sessionId,
          state,
          domCacheKey,
          "DOM.getOuterHTML",
          { backendNodeId },
        );
      } catch {
        return null;
      }
    }),
    deriveElementPath(activeCdp, sessionId, nodeId, backendNodeId).catch(() => null),
  ]);

  const node = describeResult?.node || {};
  const nodeName = node.nodeName || "UNKNOWN";
  const id = getAttr(node, "id");
  const className = getAttr(node, "class") || "";
  const model = boxResult?.model || null;
  const snippet = safeTruncate(outerResult?.outerHTML || "", DEFAULT_TRUNCATE);

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
      elementPath: elementPath || null,
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
    captureToken: selection.captureToken || null,
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

async function updatePageToolbarState(cdp, sessionState, options = {}) {
  if (!sessionState) {
    return false;
  }
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  const expression = buildPageSelectionCaptureSource(
    options.workflowId || null,
    options.captureToken || null,
    {
      mode: options.mode || "idle",
      cancelled: !!options.cancelled,
      captureActive: !!options.captureActive,
      selectedDetails: options.selectedDetails || null,
      collapsed: options.collapsed ?? null,
    },
  );
  try {
    const result = await activeCdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    return !!result?.result?.value;
  } catch {
    return false;
  }
}

async function syncOverlayModeForToolbarSignal(cdp, sessionState, signal) {
  if (!sessionState || !signal) {
    return;
  }
  const nextMode = signal.captureActive && signal.mode === "inspecting"
    ? "searchForNode"
    : "none";
  const result = await setInspectModeForSession(cdp, sessionState, nextMode);
  if (!result.ok) {
    throw new Error(result.error?.message || result.error || `Overlay sync failed for mode ${nextMode}`);
  }
}

async function ensureDomReady(activeCdp, sessionId, state, domCacheKey) {
  if (!activeCdp) {
    throw new Error("No active CDP session is available.");
  }
  const cacheKey = domCacheKey || sessionId || "root";
  if (state.domReadyBySessionKey.has(cacheKey)) {
    return;
  }
  await activeCdp.send("DOM.enable", {}, sessionId);
  await activeCdp.send("DOM.getDocument", { depth: 0, pierce: false }, sessionId);
  state.domReadyBySessionKey.add(cacheKey);
}

async function sendDomCommandWithRecovery(activeCdp, sessionId, state, domCacheKey, method, params = {}) {
  try {
    await ensureDomReady(activeCdp, sessionId, state, domCacheKey);
    return await activeCdp.send(method, params, sessionId);
  } catch (err) {
    if (!isRetryableSelectionMaterializationError(err)) {
      throw err;
    }
    const cacheKey = domCacheKey || sessionId || "root";
    state.domReadyBySessionKey.delete(cacheKey);
    await ensureDomReady(activeCdp, sessionId, state, cacheKey);
    return activeCdp.send(method, params, sessionId);
  }
}

async function setInspectModeForSession(cdp, sessionState, mode) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  const highlightConfig = {
    showInfo: true,
    showStyles: true,
    showRulers: false,
    contentColor: { r: 255, g: 102, b: 0, a: 0.15 },
    paddingColor: { r: 255, g: 170, b: 102, a: 0.2 },
    borderColor: { r: 255, g: 102, b: 0, a: 0.5 },
    marginColor: { r: 255, g: 204, b: 153, a: 0.2 },
  };
  const params = mode === "none"
    ? { mode: "none", highlightConfig }
    : {
        mode: "searchForNode",
        highlightConfig,
      };
  return safeSend(activeCdp, "Overlay.setInspectMode", params, sessionId);
}

function buildPageSelectionCaptureSource(workflowId, captureToken, {
  mode = "idle",
  cancelled = false,
  captureActive = true,
  selectedDetails = null,
  collapsed = null,
} = {}) {
  return `(() => {
    const key = "__chromeInspectAgentState";
    const styleId = "chrome-inspect-toolbar-style";
    const toolbarSelector = "[data-chrome-inspect-toolbar]";
    const states = {
      inspecting: "inspecting",
      idleSelected: "idle_selected",
      idle: "idle",
      exited: "exited",
    };
    const initialState = (() => {
      const requested = ${JSON.stringify(mode)};
      if (
        requested === states.idleSelected ||
        requested === states.exited ||
        requested === states.inspecting ||
        requested === states.idle
      ) {
        return requested;
      }
      return ${cancelled ? "states.exited" : "states.idle"};
    })();
    const state = window[key] || (window[key] = {});
    const sameWorkflow = state.workflowId === ${JSON.stringify(workflowId)} &&
      state.captureToken === ${JSON.stringify(captureToken)};
    const incomingSelectedDetails = ${JSON.stringify(selectedDetails || {
      selected: "",
      content: "",
      page: "",
      element: "",
    })};
    const requestedCollapsed = ${collapsed === null ? "null" : (collapsed ? "true" : "false")};
    state.workflowId = ${JSON.stringify(workflowId)};
    state.captureToken = ${JSON.stringify(captureToken)};
    state.captureActive = ${captureActive ? "true" : "false"};
    if (!sameWorkflow) {
      state.selected = null;
      state.selectedElement = null;
      state.selectedDetails = incomingSelectedDetails || { selected: "", content: "", page: "", element: "" };
      state.toolbarState = initialState;
      state.toolbarCollapsed = requestedCollapsed === null ? initialState === states.idle : !!requestedCollapsed;
      state.cancelled = initialState === states.exited;
      state.armedAt = Date.now();
    } else {
      state.selectedDetails = incomingSelectedDetails || state.selectedDetails || {
        selected: "",
        content: "",
        page: "",
        element: "",
      };
      state.toolbarState = initialState;
      state.toolbarCollapsed = requestedCollapsed === null
        ? (typeof state.toolbarCollapsed === "boolean" ? state.toolbarCollapsed : initialState === states.idle)
        : !!requestedCollapsed;
      state.cancelled = initialState === states.exited;
      state.armedAt = state.armedAt || Date.now();
    }

    if (typeof state.cleanup === "function") {
      state.cleanup();
    }

    state.highlighted = null;
    state.previousOutline = "";
    state.previousOutlineOffset = "";
    state.toolbar = null;
    state.toolbarBody = null;
    state.toolbarToggleButton = null;
    state.toolbarSelected = null;
    state.toolbarContent = null;
    state.toolbarPage = null;
    state.toolbarElement = null;
    state.styleElement = null;
    state.heartbeatTimer = null;
    state.toolbarObserver = null;
    state.domReadyHandler = null;
    state.handleMove = null;
    state.handleClick = null;
    state.handleToggleClick = null;
    state.previousCursor = document.documentElement.style.cursor || "";
    state.listenerInstalled = false;

    state.removeHighlight = () => {
      if (state.highlighted) {
        state.highlighted.style.outline = state.previousOutline || "";
        state.highlighted.style.outlineOffset = state.previousOutlineOffset || "";
      }
      state.highlighted = null;
      state.previousOutline = "";
      state.previousOutlineOffset = "";
    };

    state.ensureStyle = () => {
      let style = document.getElementById(styleId);
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        style.textContent = \`
[data-chrome-inspect-toolbar] {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 2147483647;
  display: grid;
  justify-items: end;
  gap: 4px;
  width: auto;
  max-width: min(420px, calc(100vw - 40px));
  padding: 0;
  border-radius: 16px;
  background: transparent;
  color: #fff;
  font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  box-sizing: border-box;
}
[data-chrome-inspect-toolbar] [data-role="row"] {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  width: 100%;
}
[data-chrome-inspect-toolbar][data-state="idle_selected"][data-collapsed="false"] [data-role="row"] {
  width: min(304px, calc(100vw - 40px));
}
[data-chrome-inspect-toolbar] [data-role="body"] {
  display: none;
  gap: 8px;
  width: min(304px, calc(100vw - 40px));
  padding: 12px;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(16, 16, 16, 0.9);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
  backdrop-filter: blur(12px);
  box-sizing: border-box;
}
[data-chrome-inspect-toolbar][data-state="idle_selected"][data-collapsed="false"] [data-role="body"] {
  display: grid;
}
[data-chrome-inspect-toolbar] [data-role="label"] {
  color: rgba(255, 255, 255, 0.58);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
[data-chrome-inspect-toolbar] button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: auto;
  min-width: 0;
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 18px;
  cursor: pointer;
  color: #fff;
  background: rgba(255, 102, 0, 0.96);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.18);
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, opacity 120ms ease, box-shadow 120ms ease;
  box-sizing: border-box;
}
[data-chrome-inspect-toolbar] button:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.72);
  outline-offset: 2px;
}
[data-chrome-inspect-toolbar] button:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.22);
}
[data-chrome-inspect-toolbar] button[data-role="inspect"] {
  padding: 0 12px;
  background: rgba(255, 102, 0, 0.96);
  border-color: rgba(255, 255, 255, 0.12);
}
[data-chrome-inspect-toolbar][data-collapsed="true"] button[data-role="inspect"] {
  width: 36px;
  min-width: 36px;
  padding: 0;
  border-radius: 12px;
}
[data-chrome-inspect-toolbar][data-state="idle_selected"][data-collapsed="false"] button[data-role="inspect"] {
  flex: 1 1 auto;
  width: 100%;
}
[data-chrome-inspect-toolbar] button[data-role="inspect"][data-active="false"] {
  opacity: 1;
}
[data-chrome-inspect-toolbar] button[data-role="inspect"][data-active="true"] {
  background: rgba(255, 102, 0, 1);
  border-color: rgba(255, 255, 255, 0.18);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
}
[data-chrome-inspect-toolbar] button[data-role="close"] {
  width: 36px;
  min-width: 36px;
  padding: 0;
  border-radius: 12px;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(16, 16, 16, 0.88);
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.16);
}
[data-chrome-inspect-toolbar] button[data-role="close"]:hover {
  background: rgba(32, 32, 32, 0.96);
}
[data-chrome-inspect-toolbar][data-collapsed="true"] button[data-role="close"] {
  display: none;
}
[data-chrome-inspect-toolbar][data-collapsed="true"] button[data-role="inspect"] span {
  display: none;
}
[data-chrome-inspect-toolbar] button svg {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
[data-chrome-inspect-toolbar] [data-role="selection-value"] {
  display: block;
  color: rgba(255, 255, 255, 0.96);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
  word-break: break-word;
}
[data-chrome-inspect-toolbar] [data-role="selection-page"],
[data-chrome-inspect-toolbar] [data-role="selection-element"] {
  display: block;
  margin-top: 4px;
  color: rgba(255, 255, 255, 0.76);
  font-weight: 500;
  font-size: 11px;
  line-height: 1.35;
  word-break: break-word;
}
\`;
        (document.head || document.documentElement).appendChild(style);
      }
      state.styleElement = style;
    };

    state.isToolbarElement = (node) => {
      return node instanceof Element && !!node.closest(toolbarSelector);
    };

    state.resolveToolbarState = () => {
      if (
        state.toolbarState === states.idleSelected ||
        state.toolbarState === states.exited ||
        state.toolbarState === states.inspecting ||
        state.toolbarState === states.idle
      ) {
        return state.toolbarState;
      }
      if (!state.captureActive && state.selected) {
        return states.idleSelected;
      }
      if (state.cancelled) {
        return states.exited;
      }
      if (!state.captureActive) {
        return states.idle;
      }
      return states.inspecting;
    };

    state.reportToolbarState = (reason) => {
      try {
        const toolbarState = state.resolveToolbarState();
        console.info(${JSON.stringify(PAGE_TOOLBAR_STATE_SIGNAL_PREFIX)} + JSON.stringify({
          workflowId: state.workflowId || null,
          captureToken: state.captureToken || null,
          mode: toolbarState,
          cancelled: toolbarState === states.exited,
          captureActive: !!state.captureActive,
          reason: reason || "unknown",
        }));
      } catch {}
    };

    state.updateToolbar = () => {
      if (!state.toolbar || !state.toolbar.isConnected) {
        state.ensureToolbar();
      }
      if (!state.toolbar) return;
      const toolbarState = state.resolveToolbarState();
      state.toolbar.dataset.state = toolbarState;
      state.toolbar.dataset.collapsed = state.toolbarCollapsed ? "true" : "false";
      if (state.toolbarSelected) {
        state.toolbarSelected.textContent = toolbarState === states.idleSelected && !state.toolbarCollapsed
          ? (state.selectedDetails?.selected || "Selection captured.")
          : "";
      }
      if (state.toolbarContent) {
        state.toolbarContent.textContent = toolbarState === states.idleSelected && !state.toolbarCollapsed
          ? (state.selectedDetails?.content || "")
          : "";
      }
      if (state.toolbarPage) {
        state.toolbarPage.textContent = toolbarState === states.idleSelected && !state.toolbarCollapsed
          ? (state.selectedDetails?.page || "")
          : "";
      }
      if (state.toolbarElement) {
        state.toolbarElement.textContent = toolbarState === states.idleSelected && !state.toolbarCollapsed
          ? (state.selectedDetails?.element || "")
          : "";
      }
      if (state.toolbarToggleButton) {
        const isInspecting = toolbarState === states.inspecting;
        state.toolbarToggleButton.dataset.active = isInspecting ? "true" : "false";
        state.toolbarToggleButton.querySelector("span").textContent = isInspecting
          ? "Inspecting"
          : (state.toolbarCollapsed ? "" : "Press this button to inspect");
      }
    };

    state.updateHeartbeat = () => {
      const toolbarState = state.resolveToolbarState();
      state.heartbeat = {
        at: Date.now(),
        workflowId: state.workflowId || null,
        captureToken: state.captureToken || null,
        captureActive: !!state.captureActive,
        hoveredTagName: state.highlighted ? state.highlighted.tagName : null,
        hoveredId: state.highlighted && state.highlighted.id ? state.highlighted.id : null,
        hoveredClassName: state.highlighted && typeof state.highlighted.className === "string"
          ? state.highlighted.className
          : null,
        selected: state.selected || null,
        cancelled: toolbarState === states.exited,
        mode: toolbarState,
        collapsed: !!state.toolbarCollapsed,
      };
    };

    state.transitionTo = (
      nextToolbarState,
      { clearSelection = false, captureActive = state.captureActive, collapsed = null } = {},
    ) => {
      state.toolbarState = nextToolbarState;
      state.cancelled = nextToolbarState === states.exited;
      state.captureActive = !!captureActive;
      state.toolbarCollapsed = collapsed === null
        ? (nextToolbarState === states.idle)
        : !!collapsed;
      if (clearSelection) {
        state.selected = null;
        state.selectedElement = null;
        state.selectedDetails = { selected: "", content: "", page: "", element: "" };
      }
      state.applyMode();
      state.updateToolbar();
      state.updateHeartbeat();
      state.reportToolbarState("transition");
    };

    state.closeToolbar = () => {
      state.toolbarState = states.exited;
      state.cancelled = true;
      state.captureActive = false;
      state.toolbarCollapsed = true;
      state.updateHeartbeat();
      state.reportToolbarState("closed");
      state.cleanup();
    };

    state.ensureToolbar = () => {
      state.ensureStyle();
      let toolbar = document.querySelector(toolbarSelector);
      if (!toolbar) {
        toolbar = document.createElement("div");
        toolbar.setAttribute("data-chrome-inspect-toolbar", "true");
        toolbar.innerHTML = \`
          <div data-role="row">
            <button type="button" data-role="inspect" data-chrome-inspect-action="toggle" aria-label="Toggle inspect mode">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.25"></circle>
                <path d="M10.5 10.5L14 14"></path>
              </svg>
              <span>Press this button to inspect</span>
            </button>
            <button type="button" data-role="close" data-chrome-inspect-action="close" aria-label="Close inspect toolbar">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4L12 12"></path>
                <path d="M12 4L4 12"></path>
              </svg>
            </button>
          </div>
          <div data-role="body" aria-live="polite">
            <div>
              <span data-role="label">Selected</span>
              <span data-role="selection-value" data-field="selected"></span>
            </div>
            <div>
              <span data-role="label">Content</span>
              <span data-role="selection-value" data-field="content"></span>
            </div>
            <div>
              <span data-role="label">Page</span>
              <span data-role="selection-page"></span>
            </div>
            <div>
              <span data-role="label">Element</span>
              <span data-role="selection-element"></span>
            </div>
          </div>
        \`;
        (document.body || document.documentElement).appendChild(toolbar);
      }
      state.toolbar = toolbar;
      state.toolbarBody = toolbar.querySelector('[data-role="body"]');
      state.toolbarToggleButton = toolbar.querySelector('button[data-chrome-inspect-action="toggle"]');
      state.toolbarCloseButton = toolbar.querySelector('button[data-chrome-inspect-action="close"]');
      state.toolbarSelected = toolbar.querySelector('[data-field="selected"]');
      state.toolbarContent = toolbar.querySelector('[data-field="content"]');
      state.toolbarPage = toolbar.querySelector('[data-role="selection-page"]');
      state.toolbarElement = toolbar.querySelector('[data-role="selection-element"]');
      if (state.toolbarToggleButton && !state.toolbarToggleButton.__chromeInspectBound) {
        state.handleToggleClick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (state.resolveToolbarState() === states.inspecting) {
            state.transitionTo(states.idle, { clearSelection: false, captureActive: false, collapsed: false });
            return;
          }
          state.transitionTo(states.inspecting, { clearSelection: true, captureActive: true, collapsed: false });
        };
        state.toolbarToggleButton.addEventListener("click", state.handleToggleClick, true);
        state.toolbarToggleButton.__chromeInspectBound = true;
      }
      if (state.toolbarCloseButton && !state.toolbarCloseButton.__chromeInspectBound) {
        state.handleCloseClick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          state.closeToolbar();
        };
        state.toolbarCloseButton.addEventListener("click", state.handleCloseClick, true);
        state.toolbarCloseButton.__chromeInspectBound = true;
      }
      state.updateToolbar();
      return toolbar;
    };

    state.handleMove = (event) => {
      if (!state.captureActive || state.resolveToolbarState() !== states.inspecting) return;
      const el = event.target instanceof Element ? event.target : null;
      if (!el || state.isToolbarElement(el)) return;
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
      if (!state.captureActive || state.resolveToolbarState() !== states.inspecting) return;
      const el = event.target instanceof Element ? event.target : null;
      if (!el || state.isToolbarElement(el)) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      state.selectedElement = el;
      state.selected = {
        workflowId: state.workflowId,
        captureToken: state.captureToken,
        at: Date.now(),
        tagName: el.tagName,
        id: el.id || null,
        className: typeof el.className === "string" ? el.className : null,
        clientX: typeof event.clientX === "number" ? event.clientX : null,
        clientY: typeof event.clientY === "number" ? event.clientY : null
      };
      state.selectedSummary = [
        String(el.tagName || "element").toLowerCase(),
        el.id ? "#" + el.id : "",
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).join(".")
          : "",
      ].filter(Boolean).join("");
      const textContent = String(el.innerText || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const locationPath = (() => {
        try {
          const pathname = location.pathname || "/";
          return pathname.startsWith("/") ? pathname : "/" + pathname;
        } catch {
          return "Current page";
        }
      })();
      state.selectedDetails = {
        selected: state.selectedSummary || "Selection captured.",
        content: textContent ? textContent.slice(0, 120) : (state.selectedSummary || "Selection captured."),
        page: locationPath,
        element: (() => {
          const parts = [];
          let current = el;
          let depth = 0;
          while (current instanceof Element && depth < 6) {
            const tag = String(current.tagName || "element").toLowerCase();
            const id = current.id ? "#" + current.id : "";
            const classSuffix = typeof current.className === "string" && current.className.trim()
              ? "." + current.className.trim().split(/\\s+/).slice(0, 2).join(".")
              : "";
            parts.unshift((tag + id + classSuffix).slice(0, 48));
            if (current.id) {
              break;
            }
            current = current.parentElement;
            depth += 1;
          }
          return parts.join(" > ");
        })(),
      };
      state.transitionTo(states.idleSelected, { captureActive: false, collapsed: false });
    };

    state.applyMode = () => {
      const root = document.documentElement;
      if (state.captureActive && state.resolveToolbarState() === states.inspecting) {
        root.style.cursor = "crosshair";
        if (!state.listenerInstalled) {
          document.addEventListener("mousemove", state.handleMove, true);
          document.addEventListener("click", state.handleClick, true);
          state.listenerInstalled = true;
        }
      } else {
        root.style.cursor = state.previousCursor || "";
        if (state.listenerInstalled) {
          document.removeEventListener("mousemove", state.handleMove, true);
          document.removeEventListener("click", state.handleClick, true);
          state.listenerInstalled = false;
        }
        state.removeHighlight();
      }
    };

    state.ensureToolbarMounted = () => {
      state.ensureToolbar();
      if (!state.toolbarObserver) {
        state.toolbarObserver = new MutationObserver(() => {
          if (!state.toolbar || !state.toolbar.isConnected) {
            state.ensureToolbar();
          }
        });
        state.toolbarObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
    };

    state.mount = () => {
      state.ensureToolbarMounted();
      state.applyMode();
      state.updateToolbar();
      state.updateHeartbeat();
      state.reportToolbarState("mount");
    };

    state.cleanup = () => {
      if (state.listenerInstalled) {
        document.removeEventListener("mousemove", state.handleMove, true);
        document.removeEventListener("click", state.handleClick, true);
      }
      if (state.toolbarToggleButton && state.handleToggleClick) {
        state.toolbarToggleButton.removeEventListener("click", state.handleToggleClick, true);
      }
      if (state.toolbarCloseButton && state.handleCloseClick) {
        state.toolbarCloseButton.removeEventListener("click", state.handleCloseClick, true);
      }
      if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
      if (state.toolbarObserver) state.toolbarObserver.disconnect();
      if (state.domReadyHandler) document.removeEventListener("DOMContentLoaded", state.domReadyHandler);
      state.removeHighlight();
      if (state.toolbar && state.toolbar.isConnected) state.toolbar.remove();
      if (state.styleElement && state.styleElement.isConnected) state.styleElement.remove();
      document.documentElement.style.cursor = state.previousCursor || "";
      state.listenerInstalled = false;
      state.toolbar = null;
      state.toolbarCloseButton = null;
      state.toolbarObserver = null;
      state.heartbeatTimer = null;
      state.styleElement = null;
      state.domReadyHandler = null;
    };

    if (document.readyState === "loading") {
      state.domReadyHandler = () => state.mount();
      document.addEventListener("DOMContentLoaded", state.domReadyHandler, { once: true });
    } else {
      state.mount();
    }

    state.heartbeatTimer = window.setInterval(() => state.updateHeartbeat(), 1000);
    state.updateHeartbeat();
    return { workflowId: state.workflowId, captureToken: state.captureToken, armedAt: state.armedAt };
  })()`;
}

async function installPageSelectionCapture(cdp, state, sessionState, workflowId, captureToken, options = {}) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  const expression = buildPageSelectionCaptureSource(workflowId, captureToken, options);

  const priorScriptId = state.pageCaptureScriptByTargetId.get(sessionState.targetId);
  if (priorScriptId) {
    await safeSend(activeCdp, "Page.removeScriptToEvaluateOnNewDocument", { identifier: priorScriptId }, sessionId);
    state.pageCaptureScriptByTargetId.delete(sessionState.targetId);
  }

  const bootstrapResult = await safeSend(
    activeCdp,
    "Page.addScriptToEvaluateOnNewDocument",
    { source: expression },
    sessionId,
  );
  if (bootstrapResult.ok && bootstrapResult.result?.identifier) {
    state.pageCaptureScriptByTargetId.set(sessionState.targetId, bootstrapResult.result.identifier);
  }

  const armedResult = await activeCdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );

  const shouldInspect = options.captureActive !== false && options.mode === "inspecting";
  const inspectModeResult = await setInspectModeForSession(cdp, sessionState, shouldInspect ? "searchForNode" : "none");
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

  const armedValue = armedResult?.result?.value || {};
  return {
    workflowId,
    captureToken,
    armedAt: armedValue.armedAt ? new Date(armedValue.armedAt).toISOString() : timingNow(),
  };
}

async function clearPageSelectionCapture(cdp, state, sessionState) {
  const scriptId = state.pageCaptureScriptByTargetId.get(sessionState.targetId);
  if (scriptId) {
    const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
    await safeSend(activeCdp, "Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }, sessionId);
    state.pageCaptureScriptByTargetId.delete(sessionState.targetId);
  }
  await setInspectModeForSession(cdp, sessionState, "none");
}

export async function reflectSelectionOnPage(cdp, sessionState, workflowId, payload) {
  if (!sessionState || !workflowId || !payload?.selectedElement) {
    return false;
  }
  return updatePageToolbarState(cdp, sessionState, {
    workflowId,
    captureToken: payload.captureToken || null,
    mode: "idle_selected",
    cancelled: false,
    captureActive: false,
    selectedDetails: buildToolbarSelectionDetails(payload),
    collapsed: false,
  });
}

async function armPageSelectionCapture(cdp, state, workflow) {
  const workflowId = workflow.workflowId;
  state.inspectTargetId = selectInspectTargetId(state);
  const targetIds = [...state.targetsById.keys()];
  let armedAt = null;
  for (const targetId of targetIds) {
    try {
      const isInspectTarget = targetId === state.inspectTargetId;
      const meta = isInspectTarget
        ? await armCaptureForTarget(cdp, state, targetId, {
            workflowId,
            captureToken: workflow.captureToken,
            mode: "idle",
            cancelled: false,
            collapsed: true,
            reason: "workflow_begin",
          })
        : await applyToolbarStateForTarget(cdp, state, targetId, {
            workflowId: null,
            captureToken: null,
            mode: "idle",
            cancelled: false,
            captureActive: false,
            selectedDetails: null,
            collapsed: true,
            reason: "workflow_begin_idle",
          });
      armedAt = meta?.armedAt || armedAt;
    } catch (err) {
      state.lastObservedError = `page capture arm failed for ${targetId}: ${err?.message || err}`;
      logSignal("page_capture_arm_error", { workflowId, targetId, error: state.lastObservedError });
    }
  }
  return armedAt;
}

async function resolveSelectionByPageClick(cdp, state, sessionState, pageInfo, workflow) {
  const workflowId = workflow.workflowId;
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  const domCacheKey = sessionState?.sessionId || sessionState?.targetId || "root";

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
    throw new Error("Page selection was cancelled from the inspect toolbar. Start capture again to select an element.");
  }

  let nodeId = null;
  let backendNodeId = null;
  if (typeof meta.clientX === "number" && typeof meta.clientY === "number") {
    try {
      const hit = await sendDomCommandWithRecovery(
        activeCdp,
        sessionId,
        state,
        domCacheKey,
        "DOM.getNodeForLocation",
        {
          x: Math.round(meta.clientX),
          y: Math.round(meta.clientY),
          includeUserAgentShadowDOM: true,
          ignorePointerEventsNone: true,
        },
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
        const request = await sendDomCommandWithRecovery(
          activeCdp,
          sessionId,
          state,
          domCacheKey,
          "DOM.requestNode",
          { objectId },
        );
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
    captureToken: meta.captureToken || workflow.captureToken || null,
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
            captureToken: s.captureToken || null,
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

async function resolveSelectionByActiveElement(cdp, state, sessionState, pageInfo, workflow = null) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
  const domCacheKey = sessionState?.sessionId || sessionState?.targetId || "root";

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
    const request = await sendDomCommandWithRecovery(
      activeCdp,
      sessionId,
      state,
      domCacheKey,
      "DOM.requestNode",
      { objectId },
    );
    nodeId = request?.nodeId;
  } catch {
    return null;
  }
  if (!nodeId) {
    return null;
  }

  let described = null;
  try {
    described = await sendDomCommandWithRecovery(
      activeCdp,
      sessionId,
      state,
      domCacheKey,
      "DOM.describeNode",
      { nodeId },
    );
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
    captureToken: workflow?.captureToken || null,
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

export async function materializeSelectionPayloadWithRecovery(cdp, state, selection) {
  try {
    return await materializeSelectionPayload(cdp, state, selection);
  } catch (err) {
    if (!isRetryableSelectionMaterializationError(err)) {
      throw err;
    }
    const sessionState = selection?.targetId ? state.targetsById.get(selection.targetId) : null;
    const domCacheKey = sessionState?.sessionId || selection?.targetId || "root";
    state.domReadyBySessionKey.delete(domCacheKey);
    const { activeCdp, sessionId } = getSessionRuntime(sessionState, cdp);
    await ensureDomReady(activeCdp, sessionId, state, domCacheKey);
    return materializeSelectionPayload(cdp, state, selection);
  }
}

function isSelectionEventFreshForWorkflow(selection, workflow) {
  if (!selection || !workflow) {
    return false;
  }
  if (selection.workflowId && selection.workflowId !== workflow.workflowId) {
    return false;
  }
  if (workflow.captureToken && selection.captureToken && workflow.captureToken !== selection.captureToken) {
    return false;
  }
  if (workflow.armedAt && selection.eventTime) {
    const armedAtMs = parseTimeMs(workflow.armedAt);
    if (armedAtMs !== null && selection.eventTime < armedAtMs) {
      return false;
    }
  }
  return true;
}

function getSelectionCandidateTargetIds(state, workflow = null) {
  const candidates = [
    state.lastSelectionEvent?.targetId || null,
    workflow?.targetId || null,
    state.inspectTargetId || null,
    state.preferredTargetId || null,
  ].filter((targetId) => targetId && state.targetsById.has(targetId));

  const unique = [];
  const seen = new Set();
  for (const targetId of candidates) {
    if (seen.has(targetId)) {
      continue;
    }
    seen.add(targetId);
    unique.push(targetId);
  }

  return unique.length ? unique : [...state.targetsById.keys()];
}

async function resolveLiveSelectionIfFresh(state, cdp, workflow) {
  if (!workflow) {
    return null;
  }
  if (!isSelectionEventFreshForWorkflow(state.lastSelectionEvent, workflow)) {
    return null;
  }
  const payload = await materializeSelectionPayloadWithRecovery(cdp, state, state.lastSelectionEvent);
  if (!payload.captureToken) {
    payload.captureToken = workflow.captureToken || null;
  }
  return payload;
}

async function resolveLatestSelection(state, cdp, waitForSelectionMs, timeoutMs, workflow = null) {
  const workflowId = workflow?.workflowId || state.activeWorkflowId;
  const currentSelection = await readJsonIfPresent(state.store.currentSelectionPath);
  if (isSelectionFreshForWorkflow(currentSelection, workflow)) {
    return currentSelection.payload;
  }

  const start = Date.now();
  const deadline = timeoutMs > 0 ? start + timeoutMs : Number.POSITIVE_INFINITY;

  while (Date.now() < deadline) {
    const livePayload = await resolveLiveSelectionIfFresh(state, cdp, workflow);
    if (livePayload) {
      return livePayload;
    }
    const selection = await waitForSelection(
      state,
      Math.min(waitForSelectionMs, Math.max(0, deadline - Date.now())),
      start,
    );
    if (selection && isSelectionEventFreshForWorkflow(selection, workflow)) {
      return materializeSelectionPayloadWithRecovery(cdp, state, selection);
    }

    for (const targetId of getSelectionCandidateTargetIds(state, workflow)) {
      const sessionState = state.targetsById.get(targetId);
      if (!sessionState) {
        continue;
      }
      const pageInfo = state.targetInfosByTargetId.get(targetId) || {};
      if (workflow) {
        const pageClickPayload = await resolveSelectionByPageClick(
          cdp,
          state,
          sessionState,
          pageInfo,
          workflow,
        );
        if (pageClickPayload) {
          return pageClickPayload;
        }
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

async function tryResolveLatestSelection(state, cdp, waitForSelectionMs, timeoutMs, workflow = null) {
  try {
    return await resolveLatestSelection(state, cdp, waitForSelectionMs, timeoutMs, workflow);
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
  const createdAt = timingNow();
  const workflow = await persistWorkflowState(state.store, state, workflowId, {
    status: "waiting_for_selection",
    phase: "waiting_for_selection",
    captureToken: randomUUID(),
    metrics: {
      workflowCreatedAt: createdAt,
      runtimeAttachedAt: state.runtimeMetrics?.runtimeAttachedAt || null,
      startupUrlResolvedAt: state.runtimeMetrics?.startupUrlResolvedAt || null,
    },
  });
  await persistSessionState(state.store, state, { status: "waiting_for_selection" });
  logSignal("workflow_created", { workflowId, sequence: workflow.sequence });
  return workflow;
}

function workflowToAwaitingPayload(workflow, store = null) {
  const payload = workflow.payload;
  return {
    phase: "awaiting_user_instruction",
    workflowId: workflow.workflowId,
    status: "awaiting_user_instruction",
    summary: workflow.summary || inspectSummary(payload),
    observedAt: payload.observedAt || null,
    selectedElement: payload.selectedElement,
    position: payload.position,
    page: payload.page,
    selectionSource: workflow.selectionSource || payload.selectionSource || null,
    selectionHistoryPath: store?.selectionHistoryPath || null,
    nextStep: {
      action: "apply_instruction",
      workflowId: workflow.workflowId,
      instruction: "How should I edit it?",
    },
  };
}

function persistedSelectionToAwaitingPayload(selection, store = null) {
  const payload = selection?.payload;
  if (!payload?.selectedElement) {
    return null;
  }
  return {
    phase: "awaiting_user_instruction",
    workflowId: selection.workflowId || null,
    status: "awaiting_user_instruction",
    summary: inspectSummary(payload),
    observedAt: payload.observedAt || null,
    selectedElement: payload.selectedElement,
    position: payload.position,
    page: payload.page,
    selectionSource: selection.selectionSource || payload.selectionSource || null,
    selectionHistoryPath: store?.selectionHistoryPath || null,
    nextStep: {
      action: "apply_instruction",
      workflowId: selection.workflowId || null,
      instruction: "How should I edit it?",
    },
  };
}

async function awaitWorkflowSelection(state, cdp, workflowId, waitForSelectionMs, timeoutMs) {
  let workflow = await readWorkflow(state.store, workflowId);
  if (!workflow) {
    throw new Error(`Unknown inspect workflow: ${workflowId}`);
  }
  if (isSelectionReady(workflow) && workflow.payload && isSelectionFreshForWorkflow({
    workflowId: workflow.workflowId,
    payload: workflow.payload,
    captureToken: workflow.captureToken || workflow.payload?.captureToken || null,
  }, workflow)) {
    return workflowToAwaitingPayload(workflow, state.store);
  }
  if (workflow.status === "ready_to_apply" && workflow.payload) {
    return workflowToAwaitingPayload(workflow, state.store);
  }
  if (workflow.status === "browser_disconnected") {
    throw new Error("The browser inspect session disconnected before a selection was recorded.");
  }
  if (workflow.status === "error") {
    throw new Error(workflow.error || "The inspect workflow entered an error state.");
  }

  logSignal("waiting_for_selection", { workflowId, timeoutMs });
  await updateWorkflowMetrics(state.store, state, workflowId, {
    awaitStartedAt: timingNow(),
  });

  const pollMs = Math.max(DEFAULT_POLL_MS, Math.min(waitForSelectionMs, 1000));
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  while (true) {
    const remaining = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : 0;
    const chunkTimeout = Number.isFinite(deadline) ? Math.min(pollMs, remaining) : pollMs;

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
    if (isSelectionReady(workflow) && workflow?.payload && isSelectionFreshForWorkflow({
      workflowId: workflow.workflowId,
      payload: workflow.payload,
      captureToken: workflow.captureToken || workflow.payload?.captureToken || null,
    }, workflow)) {
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
      if (state.activeWorkflowId === workflowId) {
        state.activeWorkflowId = null;
      }
      await applyToolbarStateToAllTargets(cdp, state, {
        workflowId,
        captureToken: finalized.captureToken || finalized.payload?.captureToken || null,
        mode: "idle_selected",
        cancelled: false,
        captureActive: false,
        selectedDetails: buildToolbarSelectionDetails(finalized.payload),
        collapsed: false,
        reason: "await_selection_ready",
      });
      await persistSessionState(state.store, state, { status: "bridge_ready" });
      return workflowToAwaitingPayload(finalized, state.store);
    }

    if (workflow?.status === "browser_disconnected") {
      throw new Error("The browser inspect session disconnected before a selection was recorded.");
    }
    if (workflow?.status === "error") {
      throw new Error(workflow.error || "The inspect workflow entered an error state.");
    }

    let heartbeat = null;
    let heartbeatTargetId = null;
    for (const targetId of getSelectionCandidateTargetIds(state, workflow)) {
      const sessionState = state.targetsById.get(targetId);
      if (!sessionState) {
        continue;
      }
      const captureState = await readPageCaptureHeartbeat(cdp, sessionState, workflowId);
      if (!captureState) {
        continue;
      }
      heartbeat = captureState;
      heartbeatTargetId = sessionState.targetId;
      break;
    }
    if (heartbeat) {
      if (heartbeatTargetId) {
        updateCaptureMetaForTarget(state, heartbeatTargetId, {
          workflowId,
          captureToken: heartbeat.captureToken || state.captureMetaByTargetId.get(heartbeatTargetId)?.captureToken || null,
          mode: heartbeat.heartbeat?.mode || (heartbeat.cancelled ? "exited" : "inspecting"),
          cancelled: !!heartbeat.cancelled,
        });
      }
      if (heartbeat.selected && heartbeatTargetId) {
        const sessionState = state.targetsById.get(heartbeatTargetId);
        const pageInfo = state.targetInfosByTargetId.get(heartbeatTargetId) || {};
        if (sessionState) {
          const pageClickPayload = await resolveSelectionByPageClick(
            cdp,
            state,
            sessionState,
            pageInfo,
            workflow,
          );
          if (pageClickPayload) {
            const finalized = await finalizeWorkflowSelection(
              cdp,
              state,
              workflow,
              pageClickPayload,
              heartbeatTargetId,
            );
            return workflowToAwaitingPayload(finalized.workflow, state.store);
          }
        }
      }
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

    if (Number.isFinite(deadline) && Date.now() >= deadline) {
      break;
    }
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
    await reconcilePageTargets(cdp, state);
    const workflow = await createCaptureWorkflow(state);
    const armStartedAt = timingNow();
    const armedAt = await armPageSelectionCapture(cdp, state, workflow);
    const armedWorkflow = await persistWorkflowState(state.store, state, workflow.workflowId, {
      armedAt: armedAt || timingNow(),
      metrics: {
        inspectModeArmedAt: armedAt || timingNow(),
      },
    });
    logTiming("inspect_mode_arm_timing", armStartedAt, { workflowId: workflow.workflowId });
    return {
      phase: "waiting_for_selection",
      workflowId: armedWorkflow.workflowId,
      status: "waiting_for_selection",
      sequence: armedWorkflow.sequence,
    };
  }

  if (action === "get_status") {
    const workflow = await readWorkflow(state.store, args.workflowId);
    if (!workflow) {
      throw new Error(`Unknown inspect workflow: ${args.workflowId || "(missing workflowId)"}`);
    }
    return workflow.payload && isSelectionReady(workflow)
      ? workflowToAwaitingPayload(workflow, state.store)
      : {
          phase: workflow.phase || workflow.status,
          workflowId: workflow.workflowId,
          status: workflow.status,
          sequence: workflow.sequence,
          error: workflow.error || null,
        };
  }

  if (action === "get_latest_selection") {
    const latestSelection = await readLatestPersistedSelection(state.store);
    const payload = persistedSelectionToAwaitingPayload(latestSelection, state.store);
    if (!payload) {
      throw new Error("There is no persisted inspect selection yet. Run begin_capture/await_selection first.");
    }
    return payload;
  }

  if (action === "await_selection") {
    if (typeof args.workflowId !== "string" || !args.workflowId.trim()) {
      throw new Error("inspect(action='await_selection') requires workflowId.");
    }
    return awaitWorkflowSelection(state, cdp, args.workflowId.trim(), waitForSelectionMs, timeoutMs);
  }

  if (action === "capture") {
    await reconcilePageTargets(cdp, state);
    const workflow = await createCaptureWorkflow(state);
    const armedAt = await armPageSelectionCapture(cdp, state, workflow);
    await persistWorkflowState(state.store, state, workflow.workflowId, {
      armedAt: armedAt || timingNow(),
      metrics: {
        inspectModeArmedAt: armedAt || timingNow(),
      },
    });
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
  if (state.activeWorkflowId === workflowId) {
    state.activeWorkflowId = null;
  }
  await persistSessionState(state.store, state, { status: "bridge_ready" });
  await applyToolbarStateToAllTargets(cdp, state, {
    workflowId,
    captureToken: workflow.captureToken || workflow.payload.captureToken || null,
    mode: "idle_selected",
    cancelled: false,
    captureActive: false,
    selectedDetails: buildToolbarSelectionDetails(workflow.payload),
    collapsed: false,
    reason: "instruction_recorded",
  });
  logSignal("instruction_recorded", { workflowId, sequence: updated.sequence });

  return {
    phase: "ready_to_apply",
    workflowId,
    selectedElement: updated.payload.selectedElement,
    position: updated.payload.position,
    page: updated.payload.page,
    userInstruction: updated.userInstruction,
    selectionSource: updated.selectionSource || updated.payload.selectionSource || null,
    selectionHistoryPath: state.store.selectionHistoryPath,
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
  const payload = await materializeSelectionPayloadWithRecovery(cdp, state, selection);
  const activeWorkflowId = state.activeWorkflowId;
  const captureMeta = selection.targetId ? state.captureMetaByTargetId.get(selection.targetId) : null;
  const boundWorkflowId = selection.workflowId || captureMeta?.workflowId || null;
  const boundCaptureToken = selection.captureToken || captureMeta?.captureToken || null;
  let workflow = null;
  let workflowId = null;

  if (activeWorkflowId) {
    workflow = await readWorkflow(state.store, activeWorkflowId);
    const activeCaptureToken = workflow?.captureToken || null;
    const isFreshSelection = !!workflow &&
      boundWorkflowId === workflow.workflowId &&
      !!boundCaptureToken &&
      boundCaptureToken === activeCaptureToken;
    if (!isFreshSelection) {
      logSignal("selection_ignored_for_inactive_workflow", {
        activeWorkflowId,
        selectionWorkflowId: boundWorkflowId,
        activeCaptureToken,
        selectionCaptureToken: boundCaptureToken,
        targetId: selection.targetId || null,
      });
      return null;
    }
    workflowId = workflow.workflowId;
  }

  if (boundCaptureToken && !payload.captureToken) {
    payload.captureToken = boundCaptureToken;
  }

  if (workflowId) {
    await finalizeWorkflowSelection(cdp, state, workflow, payload, selection.targetId || null);
  } else {
    const currentSelection = await persistCurrentSelection(state.store, state, {
      workflowId: null,
      status: "selection_received",
      targetId: selection.targetId || null,
      page: payload.page,
      selectedElement: payload.selectedElement,
      position: payload.position,
      payload,
      selectionSource: payload.selectionSource || "overlay_event",
      captureToken: payload.captureToken || selection.captureToken || null,
    });
    if (selection.targetId) {
      updateCaptureMetaForTarget(state, selection.targetId, {
        workflowId: null,
        captureToken: payload.captureToken || boundCaptureToken || null,
        mode: "idle_selected",
        cancelled: false,
        captureActive: false,
        selectedDetails: buildToolbarSelectionDetails(payload),
      });
      await applyToolbarStateForTarget(cdp, state, selection.targetId, {
        workflowId: null,
        captureToken: payload.captureToken || boundCaptureToken || null,
        mode: "idle_selected",
        cancelled: false,
        captureActive: false,
        selectedDetails: buildToolbarSelectionDetails(payload),
        reason: "selection_recorded_without_workflow",
      });
    }
    logSignal("selection_recorded_without_workflow", {
      sequence: currentSelection.sequence,
      targetId: selection.targetId || null,
    });
    await persistSessionState(state.store, state, {
      status: "bridge_ready",
    });
  }

  notifySelectionWaiters(state, selection);
  return payload;
}

function queueSelectionRecord(cdp, state, selection) {
  state.selectionRecorder = state.selectionRecorder
    .then(() => recordSelectionForWorkflow(cdp, state, selection))
    .catch(async (err) => {
      state.lastObservedError = err?.message || String(err);
      const retryable = isRetryableSelectionMaterializationError(err);
      logSignal(retryable ? "selection_record_retryable_error" : "selection_record_error", {
        error: state.lastObservedError,
      });
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

  const sessionState = state.targetsById.get(targetInfo.targetId);
  sessionCdp.onEvent((message) => {
    if (!useDirectSession && message.sessionId !== sessionId) {
      return;
    }

    if (message.method === "Overlay.inspectNodeRequested") {
      if (!overlayEnabled) {
        return;
      }
      void setInspectModeForSession(cdp, sessionState, "none").catch((err) => {
        state.lastObservedError = `overlay disable failed for ${targetInfo.targetId}: ${err?.message || err}`;
        logSignal("overlay_disable_error", {
          targetId: targetInfo.targetId,
          error: state.lastObservedError,
        });
      });
      state.lastSelectionEvent = {
        ...message.params,
        targetId: targetInfo.targetId,
        sessionId: sessionState.sessionId,
        eventTime: Date.now(),
        workflowId: state.captureMetaByTargetId.get(targetInfo.targetId)?.workflowId || null,
        captureToken: state.captureMetaByTargetId.get(targetInfo.targetId)?.captureToken || null,
      };
      void queueSelectionRecord(cdp, state, state.lastSelectionEvent);
      return;
    }

    if (message.method === "Runtime.consoleAPICalled") {
      const signal = parseToolbarStateSignal(message);
      if (!signal) {
        return;
      }
      const nextMeta = updateCaptureMetaForTarget(state, targetInfo.targetId, {
        workflowId: signal.workflowId || state.activeWorkflowId || null,
        captureToken: signal.captureToken || state.captureMetaByTargetId.get(targetInfo.targetId)?.captureToken || null,
        mode: signal.mode || state.captureMetaByTargetId.get(targetInfo.targetId)?.mode || "exited",
        cancelled: !!signal.cancelled,
        captureActive: !!signal.captureActive,
        collapsed: typeof signal.collapsed === "boolean"
          ? signal.collapsed
          : state.captureMetaByTargetId.get(targetInfo.targetId)?.collapsed,
      });
      void syncOverlayModeForToolbarSignal(cdp, sessionState, nextMeta).catch((err) => {
        state.lastObservedError = `overlay sync failed for ${targetInfo.targetId}: ${err?.message || err}`;
        logSignal("overlay_sync_error", {
          targetId: targetInfo.targetId,
          error: state.lastObservedError,
        });
      });
      return;
    }

    if (message.method === "Page.frameNavigated") {
      const frame = message.params?.frame || null;
      if (!frame) {
        return;
      }
      const isTopFrame = !frame.parentId || frame.id === sessionState.frameId || !sessionState.frameId;
      if (!isTopFrame) {
        return;
      }
      sessionState.frameId = frame.id || sessionState.frameId || null;
      void rearmCaptureForTargetIfActive(cdp, state, targetInfo.targetId, "frame_navigated");
      return;
    }

    if (message.method === "Page.loadEventFired") {
      void rearmCaptureForTargetIfActive(cdp, state, targetInfo.targetId, "load_event_fired");
      return;
    }

    if (message.method === "Page.navigatedWithinDocument") {
      const frameId = message.params?.frameId || null;
      if (frameId && sessionState.frameId && frameId !== sessionState.frameId) {
        return;
      }
      void rearmCaptureForTargetIfActive(cdp, state, targetInfo.targetId, "same_document_navigation");
    }
  });

  if (state.activeWorkflowId && targetInfo.targetId === state.inspectTargetId) {
    try {
      const workflow = await readWorkflow(state.store, state.activeWorkflowId);
      if (workflow?.captureToken) {
        await applyToolbarStateForTarget(cdp, state, targetInfo.targetId, {
          workflowId: state.activeWorkflowId,
          captureToken: workflow.captureToken,
          mode: "idle",
          cancelled: false,
          captureActive: false,
          collapsed: true,
          reason: "target_attached",
        });
      }
    } catch (err) {
      state.lastObservedError = `page capture arm failed for ${targetInfo.targetId}: ${err?.message || err}`;
      logSignal("page_capture_arm_error", { workflowId: state.activeWorkflowId, targetId: targetInfo.targetId, error: state.lastObservedError });
    }
  } else {
    await applyToolbarStateForTarget(cdp, state, targetInfo.targetId, {
      workflowId: null,
      captureToken: null,
      mode: "idle",
      cancelled: false,
      captureActive: false,
      collapsed: true,
      reason: "target_attached_idle",
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

function mergeTargetInfoLists(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const info of list || []) {
      if (!info?.targetId || info.type !== "page") {
        continue;
      }
      merged.set(info.targetId, info);
    }
  }
  return [...merged.values()];
}

function updateTargetInfo(state, info) {
  if (!info?.targetId) {
    return;
  }
  if (state.targetInfosByTargetId.has(info.targetId)) {
    state.targetInfosByTargetId.delete(info.targetId);
  }
  state.targetInfosByTargetId.set(info.targetId, {
    targetId: info.targetId,
    title: info.title || null,
    url: info.url || null,
    type: info.type || null,
  });
}

function selectInspectTargetId(state) {
  if (state.preferredTargetId && state.targetsById.has(state.preferredTargetId)) {
    return state.preferredTargetId;
  }
  const targetIds = [...state.targetInfosByTargetId.keys()].filter((targetId) => state.targetsById.has(targetId));
  return targetIds[targetIds.length - 1] || [...state.targetsById.keys()][0] || null;
}

function updateCaptureMetaForTarget(state, targetId, patch) {
  if (!targetId) {
    return null;
  }
  const previous = state.captureMetaByTargetId.get(targetId) || {};
  const next = {
    ...previous,
    ...patch,
  };
  state.captureMetaByTargetId.set(targetId, next);
  return next;
}

async function applyToolbarStateForTarget(cdp, state, targetId, {
  workflowId = null,
  captureToken = null,
  mode = "idle",
  cancelled = false,
  captureActive = false,
  selectedDetails = null,
  collapsed = null,
  reason = "manual",
} = {}) {
  const sessionState = state.targetsById.get(targetId);
  if (!sessionState) {
    return null;
  }
  const toolbar = await installPageSelectionCapture(
    cdp,
    state,
    sessionState,
    workflowId,
    captureToken,
    { mode, cancelled, captureActive, selectedDetails, collapsed },
  );
  const meta = updateCaptureMetaForTarget(state, targetId, {
    workflowId,
    captureToken,
    armedAt: toolbar?.armedAt || timingNow(),
    mode,
    cancelled,
    captureActive,
    selectedDetails,
    collapsed,
  });
  logSignal("page_toolbar_synced", {
    targetId,
    workflowId,
    captureToken,
    mode,
    cancelled,
    captureActive,
    selectedDetails,
    collapsed,
    reason,
  });
  return meta;
}

async function applyToolbarStateToAllTargets(cdp, state, options = {}) {
  for (const targetId of state.targetsById.keys()) {
    try {
      await applyToolbarStateForTarget(cdp, state, targetId, options);
    } catch (err) {
      state.lastObservedError = `page toolbar sync failed for ${targetId}: ${err?.message || err}`;
      logSignal("page_toolbar_sync_error", {
        targetId,
        reason: options.reason || "manual",
        error: state.lastObservedError,
      });
    }
  }
}

function parseToolbarStateSignal(message) {
  if (!message?.params?.args || !Array.isArray(message.params.args)) {
    return null;
  }
  for (const arg of message.params.args) {
    const value = typeof arg?.value === "string" ? arg.value : "";
    if (!value.startsWith(PAGE_TOOLBAR_STATE_SIGNAL_PREFIX)) {
      continue;
    }
    try {
      return JSON.parse(value.slice(PAGE_TOOLBAR_STATE_SIGNAL_PREFIX.length));
    } catch {
      return null;
    }
  }
  return null;
}

function getActiveCaptureMetaForTarget(state, targetId) {
  if (!targetId || !state.activeWorkflowId) {
    return null;
  }
  const meta = state.captureMetaByTargetId.get(targetId);
  if (!meta || meta.workflowId !== state.activeWorkflowId || !meta.captureToken || !meta.captureActive) {
    return null;
  }
  return meta;
}

async function armCaptureForTarget(cdp, state, targetId, {
  workflowId,
  captureToken,
  mode = "idle",
  cancelled = false,
  collapsed = null,
  reason = "manual",
} = {}) {
  const sessionState = state.targetsById.get(targetId);
  if (!sessionState || !workflowId || !captureToken) {
    return null;
  }
  const armResult = await installPageSelectionCapture(
    cdp,
    state,
    sessionState,
    workflowId,
    captureToken,
    { mode, cancelled, collapsed },
  );
  const meta = updateCaptureMetaForTarget(state, targetId, {
    workflowId,
    captureToken,
    armedAt: armResult.armedAt || timingNow(),
    mode,
    cancelled,
    captureActive: mode === "inspecting",
    collapsed,
  });
  logSignal("page_capture_armed", {
    workflowId,
    targetId,
    captureToken,
    reason,
    mode,
    cancelled,
    collapsed,
  });
  return meta;
}

async function rearmCaptureForTargetIfActive(cdp, state, targetId, reason) {
  const meta = getActiveCaptureMetaForTarget(state, targetId);
  if (!meta) {
    const fallbackMeta = state.captureMetaByTargetId.get(targetId) || {};
    const shouldCollapse = reason !== "same_document_navigation" &&
      (fallbackMeta.mode === "idle" || fallbackMeta.mode === "idle_selected" || !fallbackMeta.mode);
    return applyToolbarStateForTarget(cdp, state, targetId, {
      workflowId: fallbackMeta.workflowId || null,
      captureToken: fallbackMeta.captureToken || null,
      mode: fallbackMeta.mode || "idle",
      cancelled: !!fallbackMeta.cancelled,
      captureActive: !!fallbackMeta.captureActive,
      selectedDetails: fallbackMeta.selectedDetails || null,
      collapsed: shouldCollapse ? true : (fallbackMeta.collapsed ?? null),
      reason,
    });
  }
  const existing = state.rearmPendingByTargetId.get(targetId);
  if (existing) {
    return existing;
  }
  const pending = armCaptureForTarget(cdp, state, targetId, {
    workflowId: meta.workflowId,
    captureToken: meta.captureToken,
    mode: meta.mode === "idle_selected" ? "idle_selected" : "idle",
    cancelled: !!meta.cancelled,
    collapsed: meta.mode === "idle_selected" ? false : true,
    reason,
  }).finally(() => {
    state.rearmPendingByTargetId.delete(targetId);
  });
  state.rearmPendingByTargetId.set(targetId, pending);
  return pending;
}

function detachTrackedTarget(state, targetId, rootCdp) {
  if (!targetId) {
    return;
  }
  const sessionState = state.targetsById.get(targetId);
  if (sessionState?.cdp && sessionState.cdp !== rootCdp && !sessionState.cdp.isClosed()) {
    sessionState.cdp.close();
  }
  state.targetsById.delete(targetId);
  state.targetInfosByTargetId.delete(targetId);
  state.captureMetaByTargetId.delete(targetId);
  state.pageCaptureScriptByTargetId.delete(targetId);
  state.attachingTargetIds.delete(targetId);
  state.rearmPendingByTargetId.delete(targetId);
  if (state.inspectTargetId === targetId) {
    state.inspectTargetId = null;
  }
  if (state.preferredTargetId === targetId) {
    state.preferredTargetId = null;
  }
  if (sessionState?.sessionId) {
    state.targetsBySessionId.delete(sessionState.sessionId);
  }
}

async function attachTargetIfNeeded(cdp, state, info) {
  if (!info?.targetId || info.type !== "page") {
    return;
  }
  updateTargetInfo(state, info);
  if (state.targetsById.has(info.targetId) || state.attachingTargetIds.has(info.targetId)) {
    return;
  }
  state.attachingTargetIds.add(info.targetId);
  try {
    await attachPageTarget(cdp, info, state);
  } catch (err) {
    state.lastObservedError = `attach page failed: ${err?.message || err}`;
  } finally {
    state.attachingTargetIds.delete(info.targetId);
  }
}

async function reconcilePageTargets(cdp, state) {
  if (!state?.debugUrl) {
    return [];
  }
  if (state.reconcileTargetsPending) {
    return state.reconcileTargetsPending;
  }
  state.reconcileTargetsPending = (async () => {
    let targetDomainInfos = [];
    if (state.targetDomainAvailable) {
      const result = await safeSend(cdp, "Target.getTargets");
      if (result.ok) {
        targetDomainInfos = result.result?.targetInfos || [];
      }
    }
    let debugListInfos = [];
    try {
      debugListInfos = await loadTargetsFromDebugList(state.debugUrl, state);
    } catch {
      debugListInfos = [];
    }
    const targetInfos = mergeTargetInfoLists(targetDomainInfos, debugListInfos);
    await Promise.all(targetInfos.map(async (info) => {
      updateTargetInfo(state, info);
      await attachTargetIfNeeded(cdp, state, info);
    }));
    return targetInfos;
  })().finally(() => {
    state.reconcileTargetsPending = null;
  });
  return state.reconcileTargetsPending;
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
    metrics: {
      disconnectedAt: timingNow(),
    },
  });
  state.activeWorkflowId = null;
  await persistSessionState(state.store, state, {
    status: "browser_disconnected",
    error: message,
  });
  logSignal("browser_disconnected", { message });
}

async function closeAttachedSessions(cdp, state) {
  if (state?.targetRefreshTimer) {
    clearInterval(state.targetRefreshTimer);
    state.targetRefreshTimer = null;
  }
  if (cdp && !cdp.isClosed()) {
    cdp.close();
  }
  for (const sessionState of state.targetsById.values()) {
    if (sessionState?.cdp && sessionState.cdp !== cdp && !sessionState.cdp.isClosed()) {
      sessionState.cdp.close();
    }
  }
}

export async function connectInspectRuntime({
  debugUrl = getDefaultDebugUrl(),
  startupUrl = "",
} = {}) {
  const attachStartedAt = timingNow();
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
    attachingTargetIds: new Set(),
    lastSelectionEvent: null,
    lastObservedError: null,
    targetDomainAvailable: false,
    activeWorkflowId: null,
    selectionRecorder: Promise.resolve(),
    domReadyBySessionKey: new Set(),
    captureMetaByTargetId: new Map(),
    pageCaptureScriptByTargetId: new Map(),
    rearmPendingByTargetId: new Map(),
    preferredTargetId: null,
    inspectTargetId: null,
    store: createInspectStore({
      debugHost: browserUrl.hostname,
      debugPort: browserUrl.port || "80",
    }),
    storeSequence: 0,
    startupUrl,
    runtimeMetrics: {
      startupUrlResolvedAt: timingNow(),
      runtimeAttachedAt: null,
    },
    bridgeOwner: null,
    shuttingDown: null,
    debugUrl,
    reconcileTargetsPending: null,
    targetRefreshTimer: null,
  };

  try {
    cdp.onEvent((message) => {
      if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
        const info = message.params?.targetInfo;
        if (!info) {
          return;
        }
        updateTargetInfo(state, info);
        void attachTargetIfNeeded(cdp, state, info);
        return;
      }
      if (message.method === "Target.targetDestroyed") {
        detachTrackedTarget(state, message.params?.targetId, cdp);
        return;
      }
      if (message.method === "Target.detachedFromTarget") {
        const targetId = state.targetsBySessionId.get(message.params?.sessionId);
        if (targetId) {
          detachTrackedTarget(state, targetId, cdp);
        }
      }
    });

    await initializeStoreState(state.store, state);
    state.bridgeOwner = await claimBridgeOwnership(state.store, {
      debugUrl,
      startupUrl,
      processInfo: {
        pid: process.pid,
        ppid: process.ppid,
        startedAt: new Date().toISOString(),
      },
    });

    const restoredWorkflow = await restoreActiveWorkflowState(state.store, state, state.bridgeOwner);

    let targetInfos = await loadTargetsFromTargetDomain(cdp, state);
    if (!targetInfos.length) {
      targetInfos = await loadTargetsFromDebugList(debugUrl, state);
    }
    if (!targetInfos.length) {
      throw new Error("No page target is available. Open a page in Chrome first and retry.");
    }
    const preferredTargetInfos = await selectTargetInfosForStartupUrl(state.store, targetInfos, startupUrl);
    state.preferredTargetId = preferredTargetInfos?.[0]?.targetId || null;

    await Promise.all(targetInfos.map(async (info) => {
      if (info.type !== "page") {
        return;
      }
      await attachTargetIfNeeded(cdp, state, info);
    }));
    await reconcilePageTargets(cdp, state);

    if (!state.targetsById.size) {
      throw new Error(`Failed to attach any page target for inspection. Last error: ${state.lastObservedError || "unknown"}`);
    }

    await persistSessionState(state.store, state, {
      startupUrl,
      status: state.activeWorkflowId ? restoredWorkflow?.status || "waiting_for_selection" : "bridge_ready",
    });
    state.runtimeMetrics.runtimeAttachedAt = timingNow();
    state.targetRefreshTimer = setInterval(() => {
      void reconcilePageTargets(cdp, state);
    }, TARGET_RECONCILE_MS);
    logTiming("runtime_attach_completed", attachStartedAt, {
      debugUrl,
      targets: state.targetsById.size,
    });
    logSignal("bridge_ready", { targets: state.targetsById.size, store: state.store.inspectDir });

    return {
      cdp,
      state,
      debugUrl,
      startupUrl,
      restoredWorkflow,
    };
  } catch (err) {
    clearBridgeOwnerSync(state.store, state.bridgeOwner?.pid || process.pid);
    await closeAttachedSessions(cdp, state);
    throw err;
  }
}

export async function closeInspectRuntime(cdp, state, { clearOwner = true } = {}) {
  if (clearOwner) {
    clearBridgeOwnerSync(state.store, state.bridgeOwner?.pid || process.pid);
  }
  await closeAttachedSessions(cdp, state);
}

export function toCliSelectionPayload(payload) {
  return {
    workflowId: payload.workflowId,
    observedAt: payload.observedAt || null,
    summary: payload.summary || null,
    selectionHistoryPath: payload.selectionHistoryPath || null,
    page: {
      url: payload.page?.url || null,
      title: payload.page?.title || null,
    },
    selectedElement: {
      nodeName: payload.selectedElement?.nodeName || null,
      selectorHint: payload.selectedElement?.selectorHint || null,
      id: payload.selectedElement?.id || "",
      className: payload.selectedElement?.className || "",
      ariaLabel: payload.selectedElement?.ariaLabel || "",
      snippet: payload.selectedElement?.snippet || "",
    },
    position: {
      x: payload.position?.x ?? null,
      y: payload.position?.y ?? null,
      width: payload.position?.width ?? null,
      height: payload.position?.height ?? null,
    },
  };
}
