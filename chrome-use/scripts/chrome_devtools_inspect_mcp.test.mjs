import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";

import {
  atomicWriteJson,
  claimBridgeOwnership,
  createFrameParser,
  createInspectStore,
  getDefaultDebugUrl,
  handleInspectAction,
  isCurrentSelectionFreshForWorkflow,
  isRetryableSelectionMaterializationError,
  materializeSelectionPayloadWithRecovery,
  reflectSelectionOnPage,
  restoreActiveWorkflowState,
  selectTargetInfosForStartupUrl,
  toCliSelectionPayload,
  waitForFileSignal,
} from "./chrome_devtools_inspect_mcp.mjs";

async function makeState() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "chrome-inspect-state-"));
  const store = createInspectStore({
    rootDir,
    debugHost: "127.0.0.1",
    debugPort: "9223",
  });
  await mkdir(store.workflowsDir, { recursive: true });
  await mkdir(store.eventsDir, { recursive: true });
  return {
    rootDir,
    state: {
      store,
      storeSequence: 0,
      activeWorkflowId: null,
      bridgeOwner: null,
      domReadyBySessionKey: new Set(),
      targetInfosByTargetId: new Map(),
      targetsById: new Map(),
      targetsBySessionId: new Map(),
      selectionWaiters: [],
      lastObservedError: null,
      startupUrl: "",
      selectionRecorder: Promise.resolve(),
    },
  };
}

function samplePayload() {
  return {
    selectedElement: {
      backendNodeId: 42,
      nodeName: "BUTTON",
      id: "submit",
      className: "primary",
      ariaLabel: null,
      descriptionText: "BUTTON #submit .primary",
      selectorHint: "#submit",
      snippet: "<button id=\"submit\" class=\"primary\">Save</button>",
    },
    position: {
      x: 10,
      y: 20,
      width: 120,
      height: 40,
      quads: [],
    },
    page: {
      title: "Example",
      url: "http://127.0.0.1:8000/",
      pageId: "page-1",
      frameId: "frame-1",
    },
    selectionSource: "overlay_event",
    observedAt: "2026-04-01T00:00:00.000Z",
  };
}

test("getDefaultDebugUrl respects environment overrides", () => {
  const priorHost = process.env.CHROME_USE_DEBUG_HOST;
  const priorPort = process.env.CHROME_USE_DEBUG_PORT;
  process.env.CHROME_USE_DEBUG_HOST = "127.0.0.2";
  process.env.CHROME_USE_DEBUG_PORT = "9444";
  assert.equal(getDefaultDebugUrl(), "http://127.0.0.2:9444");
  if (priorHost === undefined) {
    delete process.env.CHROME_USE_DEBUG_HOST;
  } else {
    process.env.CHROME_USE_DEBUG_HOST = priorHost;
  }
  if (priorPort === undefined) {
    delete process.env.CHROME_USE_DEBUG_PORT;
  } else {
    process.env.CHROME_USE_DEBUG_PORT = priorPort;
  }
});

test("toCliSelectionPayload returns the normalized selection contract", () => {
  const payload = toCliSelectionPayload({
    workflowId: "wf-1",
    observedAt: "2026-04-01T00:00:00.000Z",
    summary: "button selected",
    page: {
      url: "http://127.0.0.1:8000/",
      title: "Example",
    },
    selectedElement: {
      nodeName: "BUTTON",
      selectorHint: "#submit",
      id: "submit",
      className: "primary",
      ariaLabel: "Submit form",
      snippet: "<button id=\"submit\">Save</button>",
    },
    position: {
      x: 10,
      y: 20,
      width: 120,
      height: 40,
      quads: [],
    },
  });

  assert.deepEqual(payload, {
    workflowId: "wf-1",
    observedAt: "2026-04-01T00:00:00.000Z",
    summary: "button selected",
    page: {
      url: "http://127.0.0.1:8000/",
      title: "Example",
    },
    selectedElement: {
      nodeName: "BUTTON",
      selectorHint: "#submit",
      id: "submit",
      className: "primary",
      ariaLabel: "Submit form",
      snippet: "<button id=\"submit\">Save</button>",
    },
    position: {
      x: 10,
      y: 20,
      width: 120,
      height: 40,
    },
  });
});

test("createFrameParser decodes split MCP frames", async () => {
  const seen = [];
  const parser = createFrameParser((message) => seen.push(message));
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
  parser(Buffer.from(frame.slice(0, 20)));
  parser(Buffer.from(frame.slice(20)));
  assert.deepEqual(seen, [{ jsonrpc: "2.0", id: 7, method: "tools/list" }]);
});

test("atomicWriteJson writes valid JSON atomically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "chrome-inspect-atomic-"));
  const filePath = path.join(tempDir, "state.json");
  await atomicWriteJson(filePath, { ok: true, count: 1 });
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(parsed, { ok: true, count: 1 });
  await rm(tempDir, { recursive: true, force: true });
});

test("waitForFileSignal resolves after file update", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "chrome-inspect-watch-"));
  const filePath = path.join(tempDir, "workflow.json");
  const waiter = waitForFileSignal({
    filePath,
    predicate: (candidate) => candidate?.status === "selection_received",
    timeoutMs: 2000,
    pollMs: 50,
  });

  setTimeout(() => {
    void atomicWriteJson(filePath, { status: "selection_received", sequence: 3 });
  }, 100);

  const result = await waiter;
  assert.equal(result.status, "selection_received");
  assert.equal(result.sequence, 3);
  await rm(tempDir, { recursive: true, force: true });
});

test("workflow lifecycle supports begin, await, get_status, and apply_instruction", async () => {
  const { rootDir, state } = await makeState();

  const begin = await handleInspectAction(null, state, { action: "begin_capture" }, 1);
  assert.equal(begin.phase, "waiting_for_selection");
  assert.equal(begin.status, "waiting_for_selection");
  assert.ok(begin.workflowId);

  const payload = samplePayload();
  setTimeout(() => {
    void atomicWriteJson(state.store.workflowPath(begin.workflowId), {
      workflowId: begin.workflowId,
      sequence: 2,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:01.000Z",
      status: "selection_received",
      phase: "selection_received",
      payload,
      selectedElement: payload.selectedElement,
      position: payload.position,
      page: payload.page,
      summary: "button selected",
      selectionSource: payload.selectionSource,
      userInstruction: null,
      error: null,
      targetId: "page-1",
    });
  }, 100);

  const awaited = await handleInspectAction(
    null,
    state,
    { action: "await_selection", workflowId: begin.workflowId, timeoutMs: 2000, waitForSelectionMs: 500 },
    2,
  );
  assert.equal(awaited.phase, "awaiting_user_instruction");
  assert.equal(awaited.workflowId, begin.workflowId);
  assert.equal(awaited.selectedElement.id, "submit");

  const status = await handleInspectAction(null, state, { action: "get_status", workflowId: begin.workflowId }, 3);
  assert.equal(status.phase, "awaiting_user_instruction");

  const ready = await handleInspectAction(
    null,
    state,
    { action: "apply_instruction", workflowId: begin.workflowId, instruction: "Change text to Submit now" },
    4,
  );
  assert.equal(ready.phase, "ready_to_apply");
  assert.equal(ready.userInstruction, "Change text to Submit now");

  const finalWorkflow = JSON.parse(await readFile(state.store.workflowPath(begin.workflowId), "utf8"));
  assert.equal(finalWorkflow.status, "ready_to_apply");
  assert.equal(finalWorkflow.userInstruction, "Change text to Submit now");

  await rm(rootDir, { recursive: true, force: true });
});

test("restoreActiveWorkflowState clears terminal persisted workflows", async () => {
  const { rootDir, state } = await makeState();
  state.activeWorkflowId = "wf-stale";

  await atomicWriteJson(state.store.workflowPath("wf-stale"), {
    workflowId: "wf-stale",
    sequence: 2,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:01.000Z",
    status: "browser_disconnected",
    phase: "browser_disconnected",
    payload: null,
    selectedElement: null,
    position: null,
    page: null,
    summary: null,
    selectionSource: null,
    userInstruction: null,
    error: "The inspect bridge received SIGINT.",
    targetId: null,
  });

  const restored = await restoreActiveWorkflowState(state.store, state);
  assert.equal(restored.status, "browser_disconnected");
  assert.equal(state.activeWorkflowId, null);

  await rm(rootDir, { recursive: true, force: true });
});

test("restoreActiveWorkflowState clears in-progress workflows without a valid owner", async () => {
  const { rootDir, state } = await makeState();
  state.activeWorkflowId = "wf-stale";

  await atomicWriteJson(state.store.workflowPath("wf-stale"), {
    workflowId: "wf-stale",
    sequence: 2,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:01.000Z",
    status: "waiting_for_selection",
    phase: "waiting_for_selection",
    payload: null,
    selectedElement: null,
    position: null,
    page: null,
    summary: null,
    selectionSource: null,
    userInstruction: null,
    error: null,
    targetId: null,
  });

  const restored = await restoreActiveWorkflowState(state.store, state, null);
  assert.equal(restored.status, "waiting_for_selection");
  assert.equal(state.activeWorkflowId, null);

  await rm(rootDir, { recursive: true, force: true });
});

test("restoreActiveWorkflowState keeps in-progress workflows for the current owner", async () => {
  const { rootDir, state } = await makeState();
  state.activeWorkflowId = "wf-live";

  await atomicWriteJson(state.store.workflowPath("wf-live"), {
    workflowId: "wf-live",
    sequence: 2,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:01.000Z",
    status: "waiting_for_selection",
    phase: "waiting_for_selection",
    payload: null,
    selectedElement: null,
    position: null,
    page: null,
    summary: null,
    selectionSource: null,
    userInstruction: null,
    error: null,
    targetId: null,
  });

  const restored = await restoreActiveWorkflowState(state.store, state, { pid: process.pid });
  assert.equal(restored.status, "waiting_for_selection");
  assert.equal(state.activeWorkflowId, "wf-live");

  await rm(rootDir, { recursive: true, force: true });
});

test("isCurrentSelectionFreshForWorkflow rejects stale workflow selections", () => {
  const currentSelection = {
    workflowId: "wf-old",
    payload: samplePayload(),
  };

  assert.equal(isCurrentSelectionFreshForWorkflow(currentSelection, "wf-new"), false);
  assert.equal(isCurrentSelectionFreshForWorkflow(currentSelection, "wf-old"), true);
  assert.equal(isCurrentSelectionFreshForWorkflow(currentSelection, null), true);
});

test("isRetryableSelectionMaterializationError only matches transient DOM bootstrap failures", () => {
  assert.equal(
    isRetryableSelectionMaterializationError(new Error("Document needs to be requested first")),
    true,
  );
  assert.equal(
    isRetryableSelectionMaterializationError(new Error("Could not match the selected element to a live page target.")),
    false,
  );
});

test("materializeSelectionPayloadWithRecovery primes DOM after bootstrap failure", async () => {
  const { rootDir, state } = await makeState();
  const sent = [];
  let firstPush = true;
  const mockCdp = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      if (method === "DOM.enable" || method === "DOM.getDocument") {
        return {};
      }
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        if (firstPush) {
          firstPush = false;
          throw new Error("Document needs to be requested first");
        }
        return { nodeIds: [42] };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            nodeName: "BUTTON",
            attributes: ["id", "submit", "class", "primary"],
          },
        };
      }
      if (method === "DOM.getBoxModel") {
        return {
          model: {
            content: [10, 20, 130, 20, 130, 60, 10, 60],
          },
        };
      }
      if (method === "DOM.getOuterHTML") {
        return { outerHTML: "<button id=\"submit\" class=\"primary\">Save</button>" };
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  };

  state.targetsById.set("page-1", {
    targetId: "page-1",
    sessionId: "session-1",
    cdp: null,
    frameId: "frame-1",
  });
  state.targetInfosByTargetId.set("page-1", {
    targetId: "page-1",
    title: "Example",
    url: "http://127.0.0.1:8000/",
    type: "page",
  });

  const payload = await materializeSelectionPayloadWithRecovery(mockCdp, state, {
    backendNodeId: 99,
    targetId: "page-1",
    sessionId: "session-1",
    frameId: "frame-1",
    eventTime: Date.now(),
  });

  assert.equal(payload.selectedElement.id, "submit");
  assert.ok(sent.some((call) => call.method === "DOM.getDocument"));
  assert.equal(
    sent.filter((call) => call.method === "DOM.pushNodesByBackendIdsToFrontend").length,
    2,
  );

  await rm(rootDir, { recursive: true, force: true });
});

test("claimBridgeOwnership replaces dead or orphaned owners and blocks live owners", async () => {
  const { rootDir, state } = await makeState();

  await atomicWriteJson(state.store.ownerPath, {
    pid: 3000,
    ppid: 2999,
    debugUrl: "http://127.0.0.1:9223",
    startupUrl: "http://127.0.0.1:8000/",
  });
  const deadOwner = await claimBridgeOwnership(
    state.store,
    {
      debugUrl: "http://127.0.0.1:9223",
      startupUrl: "http://127.0.0.1:8000/",
      processInfo: { pid: 4000, ppid: 3999, startedAt: "2026-04-01T00:00:00.000Z" },
    },
    {
      isProcessAlive: (pid) => pid === 4000,
    },
  );
  assert.equal(deadOwner.pid, 4000);

  const killed = [];
  await atomicWriteJson(state.store.ownerPath, {
    pid: 5000,
    ppid: 1,
    upstreamPid: 5001,
    debugUrl: "http://127.0.0.1:9223",
    startupUrl: "http://127.0.0.1:8000/",
  });
  const orphanOwner = await claimBridgeOwnership(
    state.store,
    {
      debugUrl: "http://127.0.0.1:9223",
      startupUrl: "http://127.0.0.1:8000/",
      processInfo: { pid: 6000, ppid: 5999, startedAt: "2026-04-01T00:00:01.000Z" },
    },
    {
      isProcessAlive: (pid) => pid === 5000 || pid === 5001 || pid === 6000,
      terminateProcess: async (pid) => {
        killed.push(pid);
      },
      waitForExit: async () => true,
    },
  );
  assert.equal(orphanOwner.pid, 6000);
  assert.deepEqual(killed, [5000, 5001]);

  await atomicWriteJson(state.store.ownerPath, {
    pid: 7000,
    ppid: 6999,
    debugUrl: "http://127.0.0.1:9223",
    startupUrl: "http://127.0.0.1:8000/",
  });
  await assert.rejects(
    claimBridgeOwnership(
      state.store,
      {
        debugUrl: "http://127.0.0.1:9223",
        startupUrl: "http://127.0.0.1:8000/",
        processInfo: { pid: 8000, ppid: 7999, startedAt: "2026-04-01T00:00:02.000Z" },
      },
      {
        isProcessAlive: (pid) => pid === 7000 || pid === 6999 || pid === 8000,
      },
    ),
    /already running/,
  );

  await rm(rootDir, { recursive: true, force: true });
});

test("await_selection ignores stale current-selection records from another workflow", async () => {
  const { rootDir, state } = await makeState();
  const begin = await handleInspectAction(null, state, { action: "begin_capture" }, 1);

  await atomicWriteJson(state.store.currentSelectionPath, {
    workflowId: "wf-old",
    payload: samplePayload(),
  });

  await assert.rejects(
    handleInspectAction(
      null,
      state,
      { action: "await_selection", workflowId: begin.workflowId, timeoutMs: 25, waitForSelectionMs: 25 },
      2,
    ),
    /No selected element is available yet/,
  );

  await rm(rootDir, { recursive: true, force: true });
});

test("begin_capture arms Chrome inspect mode and apply_instruction clears it", async () => {
  const { rootDir, state } = await makeState();
  const sent = [];
  const mockCdp = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return { result: { value: { workflowId: "wf", armedAt: Date.now() } } };
      }
      return {};
    },
  };

  state.targetsById.set("page-1", {
    targetId: "page-1",
    sessionId: "session-1",
    cdp: null,
    frameId: "frame-1",
  });

  const begin = await handleInspectAction(mockCdp, state, { action: "begin_capture" }, 1);
  assert.equal(begin.phase, "waiting_for_selection");
  assert.ok(sent.some((call) =>
    call.method === "Overlay.setInspectMode" && call.params?.mode === "searchForNode" && call.sessionId === "session-1"));

  const payload = samplePayload();
  await atomicWriteJson(state.store.workflowPath(begin.workflowId), {
    workflowId: begin.workflowId,
    sequence: 2,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:01.000Z",
    status: "awaiting_user_instruction",
    phase: "awaiting_user_instruction",
    payload,
    selectedElement: payload.selectedElement,
    position: payload.position,
    page: payload.page,
    summary: "button selected",
    selectionSource: payload.selectionSource,
    userInstruction: null,
    error: null,
    targetId: "page-1",
  });

  await handleInspectAction(
    mockCdp,
    state,
    { action: "apply_instruction", workflowId: begin.workflowId, instruction: "Change text" },
    2,
  );

  assert.ok(sent.some((call) =>
    call.method === "Overlay.setInspectMode" && call.params?.mode === "none" && call.sessionId === "session-1"));

  await rm(rootDir, { recursive: true, force: true });
});

test("reflectSelectionOnPage flips the page banner to selected state", async () => {
  const sent = [];
  const mockCdp = {
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return { result: { value: true } };
      }
      return {};
    },
  };

  const updated = await reflectSelectionOnPage(
    mockCdp,
    {
      targetId: "page-1",
      sessionId: "session-1",
      cdp: null,
      frameId: "frame-1",
    },
    "wf-1",
    samplePayload(),
  );

  assert.equal(updated, true);
  assert.ok(sent.some((call) =>
    call.method === "Runtime.evaluate" &&
    call.sessionId === "session-1" &&
    call.params?.expression?.includes("Element selected. Return to the agent for the next step.") &&
    call.params?.expression?.includes("#1a9c5a")));
});

test("selectTargetInfosForStartupUrl prefers the recorded startup target", async () => {
  const { rootDir, state } = await makeState();
  await atomicWriteJson(state.store.preferredTargetPath, {
    targetId: "target-2",
    url: "http://127.0.0.1:8000/",
    recordedAt: "2026-04-01T00:00:00.000Z",
  });

  const selected = await selectTargetInfosForStartupUrl(
    state.store,
    [
      { targetId: "target-1", type: "page", url: "http://127.0.0.1:8000/" },
      { targetId: "target-2", type: "page", url: "http://127.0.0.1:8000/" },
      { targetId: "target-3", type: "page", url: "https://mail.xmu.edu.cn/" },
    ],
    "http://127.0.0.1:8000/",
  );

  assert.deepEqual(selected.map((item) => item.targetId), ["target-2"]);
  await rm(rootDir, { recursive: true, force: true });
});

test("selectTargetInfosForStartupUrl falls back to the first exact startup match", async () => {
  const { rootDir, state } = await makeState();

  const selected = await selectTargetInfosForStartupUrl(
    state.store,
    [
      { targetId: "target-1", type: "page", url: "http://127.0.0.1:8000/" },
      { targetId: "target-2", type: "page", url: "http://127.0.0.1:8000/" },
      { targetId: "target-3", type: "page", url: "https://mail.xmu.edu.cn/" },
    ],
    "http://127.0.0.1:8000/",
  );

  assert.deepEqual(selected.map((item) => item.targetId), ["target-1"]);
  await rm(rootDir, { recursive: true, force: true });
});
