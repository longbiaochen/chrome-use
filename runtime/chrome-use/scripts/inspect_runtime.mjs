#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MIN_WAIT_MS = 500;
const DEFAULT_POLL_MS = 250;
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
  return {
    rootDir,
    inspectDir,
    workflowsDir,
    eventsDir,
    sessionPath,
    currentSelectionPath,
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
  if (!startupUrl || !Array.isArray(targetInfos) || !targetInfos.length) {
    return targetInfos;
  }

  const preferred = await readJsonIfPresent(store.preferredTargetPath);
  const normalizedStartupUrl = normalizeComparableUrl(startupUrl);
  const exactMatches = targetInfos.filter((info) => normalizeComparableUrl(info?.url) === normalizedStartupUrl);
  if (!exactMatches.length) {
    return targetInfos;
  }

  if (preferred?.targetId) {
    const preferredMatch = exactMatches.find((info) => info?.targetId === preferred.targetId);
    if (preferredMatch) {
      return [preferredMatch];
    }
  }

  return [exactMatches[0]];
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

function isSelectionReady(workflow) {
  return workflow?.status === "selection_received" || workflow?.status === "awaiting_user_instruction";
}

async function readWorkflow(store, workflowId) {
  if (!workflowId) {
    return null;
  }
  return readJsonIfPresent(store.workflowPath(workflowId));
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

  const [describeResult, boxResult, outerResult] = await Promise.all([
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
      mode: options.mode || "exited",
      cancelled: !!options.cancelled,
      captureActive: !!options.captureActive,
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

function buildPageSelectionCaptureSource(workflowId, captureToken, {
  mode = "inspecting",
  cancelled = false,
  captureActive = true,
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
    state.workflowId = ${JSON.stringify(workflowId)};
    state.captureToken = ${JSON.stringify(captureToken)};
    state.captureActive = ${captureActive ? "true" : "false"};
    if (!sameWorkflow) {
      state.selected = null;
      state.selectedElement = null;
      state.toolbarState = initialState;
      state.cancelled = initialState === states.exited;
      state.armedAt = Date.now();
    } else {
      state.toolbarState = initialState;
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
    state.toolbarStatus = null;
    state.toolbarInspectButton = null;
    state.toolbarExitButton = null;
    state.styleElement = null;
    state.heartbeatTimer = null;
    state.toolbarObserver = null;
    state.domReadyHandler = null;
    state.handleMove = null;
    state.handleClick = null;
    state.handleInspectClick = null;
    state.handleExitClick = null;
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
  top: 14px;
  right: 14px;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(420px, calc(100vw - 24px));
  padding: 6px 8px 6px 10px;
  border-radius: 999px;
  background: rgba(16, 16, 16, 0.92);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
  font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  backdrop-filter: blur(12px);
}
[data-chrome-inspect-toolbar] [data-role="status"] {
  min-width: 0;
  max-width: 180px;
  color: rgba(255, 255, 255, 0.92);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-chrome-inspect-toolbar] [data-role="actions"] {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
[data-chrome-inspect-toolbar] button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;
  color: #fff;
  background: rgba(255, 255, 255, 0.06);
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
[data-chrome-inspect-toolbar] button:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.12);
}
[data-chrome-inspect-toolbar] button[data-role="inspect"] {
  padding: 0 12px;
  background: #ff6600;
  border-color: rgba(255, 255, 255, 0.08);
}
[data-chrome-inspect-toolbar] button[data-role="inspect"][data-active="false"] {
  opacity: 0.92;
}
[data-chrome-inspect-toolbar] button[data-role="inspect"][data-active="true"] {
  background: #ff6600;
  border-color: rgba(255, 255, 255, 0.18);
}
[data-chrome-inspect-toolbar] button[data-role="exit"] {
  width: 28px;
  min-width: 28px;
  padding: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.72);
  border-color: rgba(255, 255, 255, 0.12);
}
[data-chrome-inspect-toolbar] button[data-role="exit"]:hover {
  color: #fff;
  border-color: rgba(204, 51, 68, 0.4);
  background: rgba(204, 51, 68, 0.16);
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

    state.statusTextForState = (toolbarState) => {
      if (toolbarState === states.idleSelected) {
        return "Element selected";
      }
      if (toolbarState === states.exited) {
        return "Inspect exited";
      }
      return "Inspect mode active";
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
      if (state.toolbarStatus) {
        state.toolbarStatus.textContent = state.statusTextForState(toolbarState);
      }
      if (state.toolbarInspectButton) {
        state.toolbarInspectButton.dataset.active = toolbarState === states.inspecting ? "true" : "false";
      }
      if (state.toolbarExitButton) {
        state.toolbarExitButton.dataset.active = toolbarState === states.exited ? "true" : "false";
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
      };
    };

    state.transitionTo = (nextToolbarState, { clearSelection = false, captureActive = state.captureActive } = {}) => {
      state.toolbarState = nextToolbarState;
      state.cancelled = nextToolbarState === states.exited;
      state.captureActive = !!captureActive;
      if (clearSelection) {
        state.selected = null;
        state.selectedElement = null;
      }
      state.applyMode();
      state.updateToolbar();
      state.updateHeartbeat();
      state.reportToolbarState("transition");
    };

    state.ensureToolbar = () => {
      state.ensureStyle();
      let toolbar = document.querySelector(toolbarSelector);
      if (!toolbar) {
        toolbar = document.createElement("div");
        toolbar.setAttribute("data-chrome-inspect-toolbar", "true");
        toolbar.innerHTML = \`
          <span data-role="status"></span>
          <div data-role="actions">
            <button type="button" data-role="inspect" data-chrome-inspect-action="inspect" aria-label="Inspect element">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.25"></circle>
                <path d="M10.5 10.5L14 14"></path>
              </svg>
              <span>Inspect</span>
            </button>
            <button type="button" data-role="exit" data-chrome-inspect-action="exit" aria-label="Exit inspect mode">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4L12 12"></path>
                <path d="M12 4L4 12"></path>
              </svg>
            </button>
          </div>
        \`;
        (document.body || document.documentElement).appendChild(toolbar);
      }
      state.toolbar = toolbar;
      state.toolbarStatus = toolbar.querySelector('[data-role="status"]');
      state.toolbarInspectButton = toolbar.querySelector('button[data-chrome-inspect-action="inspect"]');
      state.toolbarExitButton = toolbar.querySelector('button[data-chrome-inspect-action="exit"]');
      if (state.toolbarInspectButton && !state.toolbarInspectButton.__chromeInspectBound) {
        state.handleInspectClick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!state.captureActive) {
            state.updateToolbar();
            state.updateHeartbeat();
            state.reportToolbarState("inspect_requested_without_capture");
            return;
          }
          state.transitionTo(states.inspecting, { clearSelection: true, captureActive: true });
        };
        state.toolbarInspectButton.addEventListener("click", state.handleInspectClick, true);
        state.toolbarInspectButton.__chromeInspectBound = true;
      }
      if (state.toolbarExitButton && !state.toolbarExitButton.__chromeInspectBound) {
        state.handleExitClick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          state.transitionTo(states.exited, { clearSelection: true, captureActive: state.captureActive });
        };
        state.toolbarExitButton.addEventListener("click", state.handleExitClick, true);
        state.toolbarExitButton.__chromeInspectBound = true;
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
      state.transitionTo(states.idleSelected, { captureActive: false });
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
      if (state.toolbarInspectButton && state.handleInspectClick) {
        state.toolbarInspectButton.removeEventListener("click", state.handleInspectClick, true);
      }
      if (state.toolbarExitButton && state.handleExitClick) {
        state.toolbarExitButton.removeEventListener("click", state.handleExitClick, true);
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
  });
}

async function armPageSelectionCapture(cdp, state, workflow) {
  const workflowId = workflow.workflowId;
  const targetIds = [...state.targetsById.keys()];
  let armedAt = null;
  for (const targetId of targetIds) {
    try {
      const meta = await armCaptureForTarget(cdp, state, targetId, {
        workflowId,
        captureToken: workflow.captureToken,
        mode: "inspecting",
        cancelled: false,
        reason: "workflow_begin",
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

    for (const [targetId, sessionState] of state.targetsById) {
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
      const payload = await resolveSelectionByActiveElement(cdp, state, sessionState, pageInfo, workflow);
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

function workflowToAwaitingPayload(workflow) {
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
  if (isSelectionReady(workflow) && workflow.payload && isSelectionFreshForWorkflow({
    workflowId: workflow.workflowId,
    payload: workflow.payload,
    captureToken: workflow.captureToken || workflow.payload?.captureToken || null,
  }, workflow)) {
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
  await updateWorkflowMetrics(state.store, state, workflowId, {
    awaitStartedAt: timingNow(),
  });

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
        reason: "await_selection_ready",
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
    let heartbeatTargetId = null;
    for (const sessionState of state.targetsById.values()) {
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

    const fallback = await tryResolveLatestSelection(state, cdp, waitForSelectionMs, pollMs, workflow);
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
        metrics: {
          firstSelectionObservedAt: fallback.observedAt || timingNow(),
          firstSelectionSource: fallback.selectionSource || "active_element_fallback",
        },
      });
      if (state.activeWorkflowId === workflowId) {
        state.activeWorkflowId = null;
      }
      await applyToolbarStateToAllTargets(cdp, state, {
        workflowId,
        captureToken: recovered.captureToken || fallback.captureToken || null,
        mode: "idle_selected",
        cancelled: false,
        captureActive: false,
        reason: "await_selection_fallback",
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
      workflow,
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
      metrics: {
        firstSelectionObservedAt: fallback.observedAt || timingNow(),
        firstSelectionSource: fallback.selectionSource || "active_element_fallback",
      },
    });
    if (state.activeWorkflowId === workflowId) {
      state.activeWorkflowId = null;
    }
    await applyToolbarStateToAllTargets(cdp, state, {
      workflowId,
      captureToken: recovered.captureToken || fallback.captureToken || null,
      mode: "idle_selected",
      cancelled: false,
      captureActive: false,
      reason: "await_selection_terminal_fallback",
    });
    await persistSessionState(state.store, state, { status: "bridge_ready" });
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
  const workflowId = state.activeWorkflowId;
  const sessionState = selection.targetId ? state.targetsById.get(selection.targetId) : null;
  const captureMeta = selection.targetId ? state.captureMetaByTargetId.get(selection.targetId) : null;
  if (captureMeta?.captureToken && !payload.captureToken) {
    payload.captureToken = captureMeta.captureToken;
  }

  const currentSelection = await persistCurrentSelection(state.store, state, {
    workflowId: workflowId || null,
    status: "selection_received",
    targetId: selection.targetId || null,
    page: payload.page,
    selectedElement: payload.selectedElement,
    position: payload.position,
    payload,
    selectionSource: payload.selectionSource || "overlay_event",
    captureToken: payload.captureToken || selection.captureToken || null,
  });

  if (workflowId) {
    if (selection.targetId) {
      updateCaptureMetaForTarget(state, selection.targetId, {
        workflowId,
        captureToken: payload.captureToken || selection.captureToken || null,
        mode: "idle_selected",
        cancelled: false,
        captureActive: false,
      });
    }
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
      metrics: {
        firstSelectionObservedAt: payload.observedAt || timingNow(),
        firstSelectionSource: payload.selectionSource || "overlay_event",
      },
    });
    logSignal("selection_recorded", {
      workflowId,
      sequence: workflow.sequence,
      targetId: selection.targetId || null,
      selectionSource: payload.selectionSource || "overlay_event",
    });
    state.activeWorkflowId = null;
    await applyToolbarStateToAllTargets(cdp, state, {
      workflowId,
      captureToken: payload.captureToken || selection.captureToken || null,
      mode: "idle_selected",
      cancelled: false,
      captureActive: false,
      reason: "selection_recorded",
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
      updateCaptureMetaForTarget(state, targetInfo.targetId, {
        workflowId: signal.workflowId || state.activeWorkflowId || null,
        captureToken: signal.captureToken || state.captureMetaByTargetId.get(targetInfo.targetId)?.captureToken || null,
        mode: signal.mode || state.captureMetaByTargetId.get(targetInfo.targetId)?.mode || "exited",
        cancelled: !!signal.cancelled,
        captureActive: !!signal.captureActive,
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

  if (state.activeWorkflowId) {
    try {
      const workflow = await readWorkflow(state.store, state.activeWorkflowId);
      if (workflow?.captureToken) {
        await applyToolbarStateForTarget(cdp, state, targetInfo.targetId, {
          workflowId: state.activeWorkflowId,
          captureToken: workflow.captureToken,
          mode: "inspecting",
          cancelled: false,
          captureActive: true,
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
      mode: "exited",
      cancelled: false,
      captureActive: false,
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
  mode = "exited",
  cancelled = false,
  captureActive = false,
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
    { mode, cancelled, captureActive },
  );
  const meta = updateCaptureMetaForTarget(state, targetId, {
    workflowId,
    captureToken,
    armedAt: toolbar?.armedAt || timingNow(),
    mode,
    cancelled,
    captureActive,
  });
  logSignal("page_toolbar_synced", {
    targetId,
    workflowId,
    captureToken,
    mode,
    cancelled,
    captureActive,
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
  mode = "inspecting",
  cancelled = false,
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
    { mode, cancelled },
  );
  const meta = updateCaptureMetaForTarget(state, targetId, {
    workflowId,
    captureToken,
    armedAt: armResult.armedAt || timingNow(),
    mode,
    cancelled,
    captureActive: true,
  });
  logSignal("page_capture_armed", {
    workflowId,
    targetId,
    captureToken,
    reason,
    mode,
    cancelled,
  });
  return meta;
}

async function rearmCaptureForTargetIfActive(cdp, state, targetId, reason) {
  const meta = getActiveCaptureMetaForTarget(state, targetId);
  if (!meta) {
    const fallbackMeta = state.captureMetaByTargetId.get(targetId) || {};
    return applyToolbarStateForTarget(cdp, state, targetId, {
      workflowId: fallbackMeta.workflowId || null,
      captureToken: fallbackMeta.captureToken || null,
      mode: fallbackMeta.mode || "exited",
      cancelled: !!fallbackMeta.cancelled,
      captureActive: !!fallbackMeta.captureActive,
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
    mode: meta.mode || "inspecting",
    cancelled: !!meta.cancelled,
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
    targetInfos = await selectTargetInfosForStartupUrl(state.store, targetInfos, startupUrl);
    if (!targetInfos.length) {
      throw new Error("No page target is available. Open a page in Chrome first and retry.");
    }

    await Promise.all(targetInfos.map(async (info) => {
      if (info.type !== "page") {
        return;
      }
      await attachTargetIfNeeded(cdp, state, info);
    }));

    if (!state.targetsById.size) {
      throw new Error(`Failed to attach any page target for inspection. Last error: ${state.lastObservedError || "unknown"}`);
    }

    await persistSessionState(state.store, state, {
      startupUrl,
      status: state.activeWorkflowId ? restoredWorkflow?.status || "waiting_for_selection" : "bridge_ready",
    });
    state.runtimeMetrics.runtimeAttachedAt = timingNow();
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
