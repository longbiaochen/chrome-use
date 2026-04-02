import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";

import {
  atomicWriteJson,
  createFrameParser,
  createInspectStore,
  handleInspectAction,
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
      targetInfosByTargetId: new Map(),
      targetsById: new Map(),
      selectionWaiters: [],
      lastObservedError: null,
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
