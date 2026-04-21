#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeInspectRuntime,
  connectInspectRuntime,
  getDefaultDebugUrl,
  handleInspectAction,
} from "./inspect_runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "..", "fixtures", "inspect-visual");

function assertCondition(condition, message, details = null) {
  if (!condition) {
    const error = new Error(message);
    if (details) {
      error.details = details;
    }
    throw error;
  }
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value || "";
  }
}

function runShellScript(scriptPath, args = []) {
  return execFileSync(scriptPath, args, { encoding: "utf8" }).trim();
}

function getSessionRuntime(sessionState, fallbackCdp) {
  const activeCdp = sessionState?.cdp || fallbackCdp;
  const sessionId =
    sessionState?.sessionId && !String(sessionState.sessionId).startsWith("direct:")
      ? sessionState.sessionId
      : null;
  return { activeCdp, sessionId };
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function waitFor(conditionFn, timeoutMs, label) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await conditionFn();
    if (lastValue) {
      return lastValue;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

async function startFixtureServer() {
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(requestUrl.pathname || "/");
      if (pathname === "/") {
        pathname = "/index.html";
      }
      const candidate = path.normalize(path.join(fixturesDir, pathname));
      if (!candidate.startsWith(fixturesDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const body = await readFile(candidate);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine fixture server address.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function selectTargetSession(runtime, urlFragment) {
  const normalizedFragment = urlFragment ? normalizeUrl(urlFragment) : "";
  let matchedSession = null;
  for (const [targetId, info] of runtime.state.targetInfosByTargetId) {
    if (!info || !runtime.state.targetsById.has(targetId)) {
      continue;
    }
    const candidate = normalizeUrl(info.url || "");
    if (!normalizedFragment || candidate === normalizedFragment || candidate.startsWith(normalizedFragment)) {
      matchedSession = runtime.state.targetsById.get(targetId);
    }
  }
  return matchedSession || runtime.state.targetsById.values().next().value || null;
}

async function evaluateOnTarget(runtime, sessionState, expression) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, runtime.cdp);
  const result = await activeCdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  return result?.result?.value ?? null;
}

async function clickSelector(runtime, sessionState, selector) {
  const escaped = JSON.stringify(selector);
  const result = await evaluateOnTarget(runtime, sessionState, `(() => {
    const element = document.querySelector(${escaped});
    if (!element) {
      return { clicked: false, reason: "not_found", selector: ${escaped} };
    }
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    element.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }));
    element.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    }));
    return {
      clicked: true,
      selector: ${escaped},
      x,
      y,
    };
  })()`);
  assertCondition(result?.clicked, `Failed to click selector ${selector}.`, result);
}

async function realClickSelector(runtime, sessionState, selector) {
  const escaped = JSON.stringify(selector);
  const result = await evaluateOnTarget(runtime, sessionState, `(() => {
    const element = document.querySelector(${escaped});
    if (!element) {
      return { ok: false, reason: "not_found", selector: ${escaped} };
    }
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return {
      ok: true,
      selector: ${escaped},
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`);
  assertCondition(result?.ok, `Could not resolve click point for ${selector}.`, result);

  const { activeCdp, sessionId } = getSessionRuntime(sessionState, runtime.cdp);
  await activeCdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: result.x,
    y: result.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  }, sessionId);
  await activeCdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: result.x,
    y: result.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  }, sessionId);
  await activeCdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: result.x,
    y: result.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  }, sessionId);
}

async function main() {
  const fixtureServer = await startFixtureServer();
  const startupUrl = `${fixtureServer.origin}/index.html`;
  const openUrlScript = path.join(__dirname, "open_url.sh");
  const debugUrl = runShellScript(openUrlScript, [startupUrl]) || getDefaultDebugUrl();

  let runtime = null;
  let runtimeClosed = false;
  try {
    runtime = await connectInspectRuntime({ debugUrl, startupUrl });
    const startupTarget = await waitFor(async () => {
      const list = await fetchJson(`${debugUrl}/json/list`);
      const normalizedStartup = normalizeUrl(startupUrl);
      return Array.isArray(list)
        ? list.find((item) => item?.type === "page" && normalizeUrl(item?.url || "") === normalizedStartup) || null
        : null;
    }, 5000, "fixture page target");

    const sessionState = await waitFor(
      async () => selectTargetSession(runtime, startupTarget?.url || startupUrl),
      5000,
      "fixture target attachment",
    );

    const begin = await handleInspectAction(runtime.cdp, runtime.state, { action: "begin_capture" }, 101);
    assertCondition(Boolean(begin?.workflowId), "Failed to begin capture workflow.", begin);

    const awaitPromise = handleInspectAction(runtime.cdp, runtime.state, {
      action: "await_selection",
      workflowId: begin.workflowId,
      waitForSelectionMs: 500,
      timeoutMs: 6000,
    }, 102);

    await delay(250);
    await realClickSelector(runtime, sessionState, '[data-chrome-inspect-toolbar] button[data-role="inspect"]');

    const earlyResolution = await Promise.race([
      awaitPromise.then((payload) => ({ resolved: true, payload })),
      delay(1200).then(() => ({ resolved: false })),
    ]);

    assertCondition(
      earlyResolution.resolved === false,
      "await_selection resolved before a real page target was clicked.",
      earlyResolution,
    );

    await realClickSelector(runtime, sessionState, "#fixture-target");
    const awaited = await awaitPromise;

    assertCondition(awaited?.phase === "awaiting_user_instruction", "Expected a completed selection payload.", awaited);
    assertCondition(
      String(awaited?.selectedElement?.elementPath || "").includes("section#fixture-target.target-card"),
      "await_selection should resolve with a node inside the real page target instead of the toolbar.",
      awaited,
    );

    process.stdout.write(`${JSON.stringify({
      ok: true,
      workflowId: begin.workflowId,
      page: awaited.page,
      selectedElement: awaited.selectedElement,
    }, null, 2)}\n`);
  } finally {
    try {
      if (runtime && !runtimeClosed) {
        await closeInspectRuntime(runtime.cdp, runtime.state);
        runtimeClosed = true;
      }
    } finally {
      await fixtureServer.close();
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  if (error?.details) {
    process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  }
  process.exit(1);
});
