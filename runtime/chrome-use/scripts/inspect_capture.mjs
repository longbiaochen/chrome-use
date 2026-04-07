#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  atomicWriteJson,
  closeInspectRuntime,
  connectInspectRuntime,
  createInspectStore,
  getDefaultDebugUrl,
  handleInspectAction,
  toCliSelectionPayload,
} from "./inspect_runtime.mjs";

const RUNTIME_IDLE_TIMEOUT_MS = 600000;

function printUsage() {
  console.error(`Usage:
  inspect-capture begin --project-root <path> [--url <url>]
  inspect-capture await --workflow-id <id> [--timeout-ms <ms>]
  inspect-capture latest
  inspect-capture apply --workflow-id <id> --instruction "<text>"
  inspect-capture once --project-root <path> [--timeout-ms <ms>] [--url <url>]`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let idx = 0; idx < rest.length; idx += 1) {
    const arg = rest[idx];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = rest[idx + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    idx += 1;
  }
  return { command, flags };
}

function readJsonIfPresent(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readLatestSelectionHistoryEntry(store) {
  if (!existsSync(store.selectionHistoryPath)) {
    return null;
  }
  try {
    const history = readFileSync(store.selectionHistoryPath, "utf8");
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
        // Ignore malformed history rows and continue scanning backward.
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readLatestPersistedSelection(store) {
  const currentSelection = readJsonIfPresent(store.currentSelectionPath);
  if (currentSelection?.payload?.selectedElement) {
    return currentSelection;
  }
  return readLatestSelectionHistoryEntry(store);
}

function summarizePersistedSelection(selection) {
  const payload = selection?.payload;
  if (!payload?.selectedElement) {
    return null;
  }
  const selector =
    payload.selectedElement.selectorHint ||
    payload.selectedElement.descriptionText ||
    payload.selectedElement.nodeName ||
    "element";
  const pageUrl = payload.page?.url || "(no url)";
  return `${selector} on ${pageUrl}`;
}

function toCliSelectionPayloadFromPersisted(selection, store) {
  const payload = selection?.payload;
  if (!payload?.selectedElement) {
    return null;
  }
  return {
    workflowId: selection.workflowId || null,
    observedAt: payload.observedAt || null,
    summary: selection.summary || summarizePersistedSelection(selection),
    selectionHistoryPath: store.selectionHistoryPath,
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

async function resolveLatestPageUrl(debugUrl) {
  try {
    const parsed = new URL(debugUrl);
    const payload = await fetchJson(`${parsed.origin}/json/list`);
    const pages = Array.isArray(payload) ? payload.filter((item) => item?.type === "page") : [];
    const latest = pages[pages.length - 1] || null;
    return latest?.url || "";
  } catch {
    return "";
  }
}

async function resolveSessionStartupUrl(debugUrl) {
  const liveUrl = await resolveLatestPageUrl(debugUrl);
  if (liveUrl) {
    return liveUrl;
  }
  const parsed = new URL(debugUrl);
  const store = createInspectStore({
    debugHost: parsed.hostname,
    debugPort: parsed.port || "80",
  });
  const session = readJsonIfPresent(store.sessionPath);
  return session?.startupUrl || "";
}

function runScript(scriptPath, args = [], env = process.env) {
  return execFileSync(scriptPath, args, {
    env,
    encoding: "utf8",
  }).trim();
}

function resolveAndOpenTarget({ scriptDir, projectRoot, explicitUrl }) {
  const env = {
    ...process.env,
  };
  if (projectRoot) {
    env.CHROME_INSPECT_PROJECT_ROOT = projectRoot;
  }
  const startupUrl = runScript(
    path.join(scriptDir, "resolve_startup_url.sh"),
    explicitUrl ? [explicitUrl] : [],
    env,
  );
  const debugUrl = runScript(
    path.join(scriptDir, "open_url.sh"),
    startupUrl ? [startupUrl] : [],
    env,
  );
  return { startupUrl, debugUrl };
}

function ensureCommandRequirements(command, flags) {
  if (!command) {
    printUsage();
    throw new Error("Missing inspect-capture subcommand.");
  }
  if (command === "await" || command === "apply") {
    if (!flags["workflow-id"]) {
      throw new Error(`inspect-capture ${command} requires --workflow-id.`);
    }
  }
  if (command === "apply" && !flags.instruction) {
    throw new Error("inspect-capture apply requires --instruction.");
  }
  if (!["begin", "await", "latest", "apply", "once", "__daemon"].includes(command)) {
    throw new Error(`Unsupported inspect-capture subcommand: ${command}`);
  }
}

function runtimeSocketPath(store) {
  return path.join(store.inspectDir, "runtime.sock");
}

function readRuntimeHandle(store) {
  return readJsonIfPresent(store.runtimePath);
}

function runtimeLaunchLabel(store) {
  const scope = path.basename(store.inspectDir).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `com.chromeuse.inspect.${scope}`;
}

async function persistRuntimeHandle(store, handle) {
  await atomicWriteJson(store.runtimePath, handle);
  return handle;
}

function clearRuntimeHandle(store, pid = null) {
  try {
    if (!existsSync(store.runtimePath)) {
      return;
    }
    if (pid !== null) {
      const current = JSON.parse(readFileSync(store.runtimePath, "utf8"));
      if (current?.pid !== pid) {
        return;
      }
    }
    unlinkSync(store.runtimePath);
  } catch {
    // Best-effort cleanup only.
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logSignal(event, details = {}) {
  process.stderr.write(`[chrome-inspect] ${JSON.stringify({
    event,
    time: new Date().toISOString(),
    ...details,
  })}\n`);
}

async function waitForRuntimeReady(store, predicate = () => true, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = readRuntimeHandle(store);
    if (handle?.socketPath && existsSync(handle.socketPath) && predicate(handle)) {
      return handle;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function launchRuntimeServerWithLaunchctl({ scriptPath, debugUrl, startupUrl, store }) {
  const label = runtimeLaunchLabel(store);
  try {
    execFileSync("launchctl", ["remove", label], { stdio: "ignore" });
  } catch {
    // Ignore missing pre-existing jobs.
  }
  execFileSync("launchctl", [
    "submit",
    "-l",
    label,
    "--",
    process.execPath,
    scriptPath,
    "__daemon",
    "--browser-url",
    debugUrl,
    "--startup-url",
    startupUrl,
  ], {
    stdio: "ignore",
  });
  return label;
}

async function connectSocket(socketPath, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const onError = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", onError);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`Timed out connecting to inspect runtime at ${socketPath}`));
    });
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

async function sendRuntimeCommand(handle, command, args = {}) {
  const socket = await connectSocket(handle.socketPath);
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      socket.end();
      try {
        const response = JSON.parse(line);
        if (!response.ok) {
          reject(new Error(response.error || "Unknown inspect runtime error"));
          return;
        }
        resolve(response.result);
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify({ command, args })}\n`);
  });
}

async function shutdownRuntimeServer(handle) {
  try {
    await sendRuntimeCommand(handle, "shutdown", {});
  } catch {
    // Best-effort shutdown only.
  }
}

async function ensureRuntimeServer({
  scriptPath,
  store,
  debugUrl,
  startupUrl,
}) {
  const existing = readRuntimeHandle(store);
  if (existing?.pid && isPidAlive(existing.pid) && existing.socketPath && existsSync(existing.socketPath)) {
    if (existing.debugUrl === debugUrl) {
      return existing;
    }
    await shutdownRuntimeServer(existing);
    clearRuntimeHandle(store, existing.pid);
  } else if (existing?.pid) {
    clearRuntimeHandle(store, existing.pid);
  }

  if (process.platform === "darwin") {
    launchRuntimeServerWithLaunchctl({ scriptPath, debugUrl, startupUrl, store });
  } else {
    const child = spawn(
      process.execPath,
      [scriptPath, "__daemon", "--browser-url", debugUrl, "--startup-url", startupUrl],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
  }
  const handle = await waitForRuntimeReady(
    store,
    (candidate) => candidate?.debugUrl === debugUrl,
  );
  if (!handle) {
    throw new Error("Inspect runtime daemon did not become ready in time.");
  }
  return handle;
}

async function runInlineCommand({ debugUrl, startupUrl, command, args }) {
  const runtime = await connectInspectRuntime({ debugUrl, startupUrl });
  try {
    return await handleInspectAction(runtime.cdp, runtime.state, {
      action: command,
      ...args,
    }, 1);
  } finally {
    await closeInspectRuntime(runtime.cdp, runtime.state);
  }
}

async function runDaemonMode(flags) {
  const debugUrl = typeof flags["browser-url"] === "string" ? flags["browser-url"] : getDefaultDebugUrl();
  const startupUrl = typeof flags["startup-url"] === "string" ? flags["startup-url"] : "";
  const parsed = new URL(debugUrl);
  const store = createInspectStore({
    debugHost: parsed.hostname,
    debugPort: parsed.port || "80",
  });
  const socketPath = runtimeSocketPath(store);
  clearRuntimeHandle(store);
  try {
    unlinkSync(socketPath);
  } catch {
    // Ignore missing socket files.
  }

  const runtime = await connectInspectRuntime({ debugUrl, startupUrl });
  let shuttingDown = false;
  let idleTimer = null;
  let pendingRequests = 0;

  const refreshIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    if (shuttingDown || pendingRequests > 0) {
      return;
    }
    idleTimer = setTimeout(() => {
      void shutdown("idle_timeout");
    }, RUNTIME_IDLE_TIMEOUT_MS);
  };

  const shutdown = async (reason) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    server.close();
    clearRuntimeHandle(store, process.pid);
    try {
      unlinkSync(socketPath);
    } catch {
      // Ignore missing socket files.
    }
    logSignal("runtime_daemon_shutdown", { reason });
    await closeInspectRuntime(runtime.cdp, runtime.state);
    process.exit(0);
  };

  const server = net.createServer((socket) => {
    pendingRequests += 1;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = "";
      try {
        const request = JSON.parse(line);
        const command = request.command;
        const args = request.args || {};
        let result;
        if (command === "shutdown") {
          socket.write(`${JSON.stringify({ ok: true, result: { shuttingDown: true } })}\n`);
          socket.end();
          pendingRequests -= 1;
          refreshIdleTimer();
          await shutdown("explicit_shutdown");
          return;
        }
        result = await handleInspectAction(runtime.cdp, runtime.state, {
          action: command,
          ...args,
        }, 1);
        await persistRuntimeHandle(store, {
          pid: process.pid,
          socketPath,
          debugUrl,
          startupUrl,
          readyAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });
        socket.write(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (err) {
        socket.write(`${JSON.stringify({ ok: false, error: err?.message || String(err) })}\n`);
      } finally {
        socket.end();
      }
    });
    socket.on("close", () => {
      pendingRequests = Math.max(0, pendingRequests - 1);
      refreshIdleTimer();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  await persistRuntimeHandle(store, {
    pid: process.pid,
    socketPath,
    debugUrl,
    startupUrl,
    readyAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  process.on("SIGINT", () => {
    void shutdown("sigint");
  });
  process.on("SIGTERM", () => {
    void shutdown("sigterm");
  });
  refreshIdleTimer();
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  ensureCommandRequirements(command, flags);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = fileURLToPath(import.meta.url);
  const projectRoot = typeof flags["project-root"] === "string" ? flags["project-root"] : "";
  const explicitUrl = typeof flags.url === "string" ? flags.url : "";
  const timeoutMs =
    typeof flags["timeout-ms"] === "string" ? Number.parseInt(flags["timeout-ms"], 10) : 0;
  const explicitDebugUrl =
    typeof flags["browser-url"] === "string" ? flags["browser-url"] : getDefaultDebugUrl();

  if (command === "__daemon") {
    await runDaemonMode({
      "browser-url": explicitDebugUrl,
      "startup-url": typeof flags["startup-url"] === "string" ? flags["startup-url"] : "",
    });
    return;
  }

  let startupUrl = explicitUrl;
  let debugUrl = explicitDebugUrl;

  if (command === "latest") {
    const latestUrl = new URL(explicitDebugUrl);
    const latestStore = createInspectStore({
      debugHost: latestUrl.hostname,
      debugPort: latestUrl.port || "80",
    });
    const latest = readLatestPersistedSelection(latestStore);
    const payload = toCliSelectionPayloadFromPersisted(latest, latestStore);
    if (!payload) {
      throw new Error("There is no persisted inspect selection yet. Run begin_capture/await_selection first.");
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (command === "begin" || command === "once") {
    const resolved = resolveAndOpenTarget({ scriptDir, projectRoot, explicitUrl });
    startupUrl = resolved.startupUrl;
    debugUrl = resolved.debugUrl || debugUrl;
  } else {
    startupUrl = explicitUrl || await resolveSessionStartupUrl(debugUrl);
  }

  const parsed = new URL(debugUrl);
  const store = createInspectStore({
    debugHost: parsed.hostname,
    debugPort: parsed.port || "80",
  });

  if (command === "begin") {
    const handle = await ensureRuntimeServer({ scriptPath, store, debugUrl, startupUrl });
    const result = await sendRuntimeCommand(handle, "begin_capture", {});
    process.stdout.write(`${JSON.stringify({
      workflowId: result.workflowId,
      status: result.status,
      phase: result.phase,
      url: startupUrl || null,
    })}\n`);
    return;
  }

  if (command === "await") {
    const args = {
      workflowId: flags["workflow-id"],
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 0,
      waitForSelectionMs: 500,
    };
    let handle;
    try {
      handle = await ensureRuntimeServer({ scriptPath, store, debugUrl, startupUrl });
    } catch (err) {
      logSignal("runtime_startup_fallback", {
        command: "await_selection",
        error: err?.message || String(err),
      });
      const result = await runInlineCommand({
        debugUrl,
        startupUrl,
        command: "await_selection",
        args,
      });
      process.stdout.write(`${JSON.stringify(toCliSelectionPayload(result))}\n`);
      return;
    }
    const result = await sendRuntimeCommand(handle, "await_selection", args);
    process.stdout.write(`${JSON.stringify(toCliSelectionPayload(result))}\n`);
    return;
  }

  if (command === "apply") {
    const args = {
      workflowId: flags["workflow-id"],
      instruction: flags.instruction,
    };
    try {
      const handle = await ensureRuntimeServer({ scriptPath, store, debugUrl, startupUrl });
      const result = await sendRuntimeCommand(handle, "apply_instruction", args);
      process.stdout.write(`${JSON.stringify({
        workflowId: result.workflowId,
        phase: result.phase,
        userInstruction: result.userInstruction || flags.instruction,
      })}\n`);
      return;
    } catch (err) {
      logSignal("runtime_reconnect_fallback", {
        command: "apply_instruction",
        error: err?.message || String(err),
      });
      const result = await runInlineCommand({
        debugUrl,
        startupUrl,
        command: "apply_instruction",
        args,
      });
      process.stdout.write(`${JSON.stringify({
        workflowId: result.workflowId,
        phase: result.phase,
        userInstruction: result.userInstruction || flags.instruction,
      })}\n`);
      return;
    }
  }

  const runtime = await connectInspectRuntime({ debugUrl, startupUrl });
  try {
    const { cdp, state } = runtime;
    const begin = await handleInspectAction(cdp, state, { action: "begin_capture" }, 4);
    console.error(
      `Inspect armed for ${startupUrl || "the current page"}. Click an element in dedicated Chrome, then wait for JSON output.`,
    );
    const result = await handleInspectAction(
      cdp,
      state,
      {
        action: "await_selection",
        workflowId: begin.workflowId,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 0,
        waitForSelectionMs: 500,
      },
      5,
    );
    process.stdout.write(`${JSON.stringify(toCliSelectionPayload(result))}\n`);
  } finally {
    await closeInspectRuntime(runtime.cdp, runtime.state);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
