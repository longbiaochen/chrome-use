#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
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

function parseArgs(argv) {
  const flags = {};
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = argv[idx + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    idx += 1;
  }
  return flags;
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

function getSessionRuntime(sessionState, fallbackCdp) {
  const activeCdp = sessionState?.cdp || fallbackCdp;
  const sessionId =
    sessionState?.sessionId && !String(sessionState.sessionId).startsWith("direct:")
      ? sessionState.sessionId
      : null;
  return { activeCdp, sessionId };
}

function logStep(message) {
  process.stderr.write(`[inspect-visual] ${message}\n`);
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
    server,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function runShellScript(scriptPath, args = []) {
  return execFileSync(scriptPath, args, { encoding: "utf8" }).trim();
}

function assertCondition(condition, message, details = null) {
  if (!condition) {
    const error = new Error(message);
    if (details) {
      error.details = details;
    }
    throw error;
  }
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

async function captureScreenshot(runtime, sessionState, outputPath) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, runtime.cdp);
  const screenshot = await activeCdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
}

async function reloadTarget(runtime, sessionState) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, runtime.cdp);
  await activeCdp.send("Page.reload", {}, sessionId);
}

async function setViewport(runtime, sessionState, width, height) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, runtime.cdp);
  await activeCdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId);
}

async function clearViewport(runtime, sessionState) {
  const { activeCdp, sessionId } = getSessionRuntime(sessionState, runtime.cdp);
  await activeCdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
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

async function navigateHash(runtime, sessionState, hash) {
  const escaped = JSON.stringify(hash);
  const result = await evaluateOnTarget(runtime, sessionState, `(() => {
    location.hash = ${escaped};
    return {
      hash: location.hash,
      url: location.href,
    };
  })()`);
  assertCondition(result?.hash === hash, `Failed to navigate to hash ${hash}.`, result);
}

async function readToolbarMetrics(runtime, sessionState) {
  return evaluateOnTarget(runtime, sessionState, `(() => {
    const toolbar = document.querySelector("[data-chrome-inspect-toolbar]");
    if (!toolbar) {
      return { present: false, url: location.href, title: document.title };
    }
    const status = toolbar.querySelector('[data-role="status"]');
    const inspectButton = toolbar.querySelector('button[data-role="inspect"]');
    const exitButton = toolbar.querySelector('button[data-role="exit"]');
    const toolbarRect = toolbar.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    const inspectRect = inspectButton.getBoundingClientRect();
    const exitRect = exitButton.getBoundingClientRect();
    const toolbarStyle = getComputedStyle(toolbar);
    const statusStyle = getComputedStyle(status);
    const inspectStyle = getComputedStyle(inspectButton);
    const exitStyle = getComputedStyle(exitButton);
    return {
      present: true,
      url: location.href,
      title: document.title,
      state: toolbar.dataset.state || null,
      statusText: status.textContent.trim(),
      toolbar: {
        top: toolbarRect.top,
        rightInset: window.innerWidth - toolbarRect.right,
        width: toolbarRect.width,
        height: toolbarRect.height,
        scrollHeight: toolbar.scrollHeight,
      },
      status: {
        width: statusRect.width,
        whiteSpace: statusStyle.whiteSpace,
        overflow: statusStyle.overflow,
        textOverflow: statusStyle.textOverflow,
      },
      inspectButton: {
        width: inspectRect.width,
        height: inspectRect.height,
        top: inspectRect.top,
        backgroundColor: inspectStyle.backgroundColor,
        active: inspectButton.dataset.active || null,
      },
      exitButton: {
        width: exitRect.width,
        height: exitRect.height,
        top: exitRect.top,
        backgroundColor: exitStyle.backgroundColor,
        active: exitButton.dataset.active || null,
      },
      layout: {
        buttonsWrap: Math.abs(inspectRect.top - exitRect.top) > 1,
        toolbarCompact: toolbarRect.height <= 44,
      },
    };
  })()`);
}

async function waitFor(conditionFn, timeoutMs, label) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await conditionFn();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

function selectTargetSession(runtime, urlFragment) {
  const normalizedFragment = urlFragment ? normalizeUrl(urlFragment) : "";
  for (const [targetId, info] of runtime.state.targetInfosByTargetId) {
    if (!info || !runtime.state.targetsById.has(targetId)) {
      continue;
    }
    const candidate = normalizeUrl(info.url || "");
    if (!normalizedFragment || candidate === normalizedFragment || candidate.startsWith(normalizedFragment)) {
      return runtime.state.targetsById.get(targetId);
    }
  }
  return runtime.state.targetsById.values().next().value || null;
}

function assertToolbarMetrics(metrics, {
  expectedState,
  expectedText,
} = {}) {
  assertCondition(metrics?.present, "Toolbar is missing.", metrics);
  if (expectedState) {
    assertCondition(metrics.state === expectedState, `Toolbar state mismatch: expected ${expectedState}, got ${metrics.state}.`, metrics);
  }
  if (expectedText) {
    assertCondition(metrics.statusText === expectedText, `Toolbar text mismatch: expected "${expectedText}", got "${metrics.statusText}".`, metrics);
  }
  assertCondition(metrics.toolbar.top <= 20, "Toolbar is not pinned near the top edge.", metrics);
  assertCondition(metrics.toolbar.rightInset <= 20, "Toolbar is not pinned near the right edge.", metrics);
  assertCondition(metrics.layout.toolbarCompact, "Toolbar is taller than the compact layout budget.", metrics);
  assertCondition(metrics.toolbar.scrollHeight <= metrics.toolbar.height + 1, "Toolbar content overflowed vertically.", metrics);
  assertCondition(metrics.status.whiteSpace === "nowrap", "Toolbar status is not constrained to a single line.", metrics);
  assertCondition(metrics.status.overflow === "hidden", "Toolbar status does not clip overflow.", metrics);
  assertCondition(metrics.inspectButton.width > metrics.exitButton.width, "Inspect button is not visually primary.", metrics);
  assertCondition(!metrics.layout.buttonsWrap, "Toolbar buttons wrapped onto multiple rows.", metrics);
}

async function recordStep(runtime, sessionState, outputDir, name, expectations = {}) {
  logStep(`Capturing ${name}`);
  const metrics = await waitFor(async () => {
    const current = await readToolbarMetrics(runtime, sessionState);
    if (!current?.present && expectations.present === false) {
      return current;
    }
    if (expectations.expectedState && current?.state !== expectations.expectedState) {
      return null;
    }
    return current;
  }, 8000, `${name} toolbar state`);

  if (expectations.present === false) {
    assertCondition(metrics.present === false, `Expected toolbar to be removed for ${name}.`, metrics);
    return {
      name,
      screenshot: null,
      metrics,
    };
  }

  assertToolbarMetrics(metrics, expectations);
  const screenshotPath = path.join(outputDir, `${name}.png`);
  await captureScreenshot(runtime, sessionState, screenshotPath);
  return {
    name,
    screenshot: screenshotPath,
    metrics,
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const outputDir = flags["output-dir"]
    ? path.resolve(String(flags["output-dir"]))
    : await mkdtemp(path.join(os.tmpdir(), "chrome-inspect-visual-"));
  await mkdir(outputDir, { recursive: true });

  const fixtureServer = await startFixtureServer();
  const startupUrl = `${fixtureServer.origin}/index.html`;
  const openUrlScript = path.join(__dirname, "open_url.sh");
  const debugUrl = runShellScript(openUrlScript, [startupUrl]) || getDefaultDebugUrl();

  logStep(`Fixture server: ${fixtureServer.origin}`);
  logStep(`Debug URL: ${debugUrl}`);

  const runtime = await connectInspectRuntime({ debugUrl, startupUrl });
  const results = [];

  try {
    const begin = await handleInspectAction(runtime.cdp, runtime.state, { action: "begin_capture" }, 1);
    const workflowId = begin.workflowId;
    assertCondition(Boolean(workflowId), "Failed to start inspect capture.", begin);

    let sessionState = await waitFor(async () => selectTargetSession(runtime, startupUrl), 5000, "fixture target attachment");
    logStep("Validating initial inspecting state");
    results.push(await recordStep(runtime, sessionState, outputDir, "01-initial-inspecting", {
      expectedState: "inspecting",
      expectedText: "Inspect mode active",
    }));

    logStep("Clicking Exit");
    await clickSelector(runtime, sessionState, '[data-chrome-inspect-toolbar] button[data-role="exit"]');
    results.push(await recordStep(runtime, sessionState, outputDir, "02-exited", {
      expectedState: "exited",
      expectedText: "Inspect exited",
    }));

    logStep("Reloading page while exited");
    await reloadTarget(runtime, sessionState);
    results.push(await recordStep(runtime, sessionState, outputDir, "03-exited-after-reload", {
      expectedState: "exited",
      expectedText: "Inspect exited",
    }));

    logStep("Re-entering inspect mode");
    await clickSelector(runtime, sessionState, '[data-chrome-inspect-toolbar] button[data-role="inspect"]');
    results.push(await recordStep(runtime, sessionState, outputDir, "04-inspecting-again", {
      expectedState: "inspecting",
      expectedText: "Inspect mode active",
    }));

    logStep("Triggering same-document navigation");
    await navigateHash(runtime, sessionState, "#details");
    results.push(await recordStep(runtime, sessionState, outputDir, "05-same-document-inspecting", {
      expectedState: "inspecting",
      expectedText: "Inspect mode active",
    }));

    logStep("Selecting the fixture target");
    await clickSelector(runtime, sessionState, "#fixture-target");
    const awaited = await handleInspectAction(runtime.cdp, runtime.state, {
      action: "await_selection",
      workflowId,
      waitForSelectionMs: 500,
      timeoutMs: 6000,
    }, 2);
    assertCondition(awaited?.phase === "awaiting_user_instruction", "Expected a completed selection payload.", awaited);
    results.push(await recordStep(runtime, sessionState, outputDir, "06-selected", {
      expectedState: "selected",
      expectedText: "Element selected",
    }));

    logStep("Navigating to the second fixture page");
    await clickSelector(runtime, sessionState, "#fixture-next-link");
    sessionState = await waitFor(async () => selectTargetSession(runtime, `${fixtureServer.origin}/next.html`), 8000, "next page target");
    results.push(await recordStep(runtime, sessionState, outputDir, "07-selected-after-navigation", {
      expectedState: "selected",
      expectedText: "Element selected",
    }));

    logStep("Triggering same-document navigation on the second page");
    await clickSelector(runtime, sessionState, "#fixture-notes-link");
    results.push(await recordStep(runtime, sessionState, outputDir, "08-selected-after-hash-nav", {
      expectedState: "selected",
      expectedText: "Element selected",
    }));

    logStep("Validating narrow viewport layout");
    await setViewport(runtime, sessionState, 360, 800);
    results.push(await recordStep(runtime, sessionState, outputDir, "09-narrow-viewport", {
      expectedState: "selected",
      expectedText: "Element selected",
    }));
    await clearViewport(runtime, sessionState);

    logStep("Clearing the workflow");
    const apply = await handleInspectAction(runtime.cdp, runtime.state, {
      action: "apply_instruction",
      workflowId,
      instruction: "Visual validation complete.",
    }, 3);
    assertCondition(apply?.phase === "ready_to_apply", "Expected apply_instruction to complete.", apply);
    results.push(await recordStep(runtime, sessionState, outputDir, "10-toolbar-cleared", {
      present: false,
    }));

    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputDir,
      fixtureOrigin: fixtureServer.origin,
      screenshots: results.map((entry) => ({ name: entry.name, screenshot: entry.screenshot })),
    }, null, 2)}\n`);
  } finally {
    try {
      await closeInspectRuntime(runtime.cdp, runtime.state);
    } finally {
      await fixtureServer.close();
    }
  }
}

main().catch(async (error) => {
  process.stderr.write(`${error?.message || error}\n`);
  if (error?.details) {
    process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  }
  process.exit(1);
});
