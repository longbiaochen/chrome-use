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

async function openExtraTab(runtime, targetUrl) {
  return runtime.cdp.send("Target.createTarget", { url: targetUrl });
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
    const inspectButton = toolbar.querySelector('button[data-role="inspect"]');
    const closeButton = toolbar.querySelector('button[data-role="close"]');
    const row = toolbar.querySelector('[data-role="row"]');
    const body = toolbar.querySelector('[data-role="body"]');
    const selectionSelected = toolbar.querySelector('[data-field="selected"]');
    const selectionContent = toolbar.querySelector('[data-field="content"]');
    const selectionPage = toolbar.querySelector('[data-role="selection-page"]');
    const selectionElement = toolbar.querySelector('[data-role="selection-element"]');
    const toolbarRect = toolbar.getBoundingClientRect();
    const inspectRect = inspectButton.getBoundingClientRect();
    const closeRect = closeButton ? closeButton.getBoundingClientRect() : null;
    const rowRect = row ? row.getBoundingClientRect() : null;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const toolbarStyle = getComputedStyle(toolbar);
    const inspectStyle = getComputedStyle(inspectButton);
    const bodyStyle = body ? getComputedStyle(body) : null;
    const bodyRect = body ? body.getBoundingClientRect() : null;
    return {
      present: true,
      url: location.href,
      title: document.title,
      state: toolbar.dataset.state || null,
      collapsed: toolbar.dataset.collapsed || null,
      hidden: toolbar.hidden,
      toolbar: {
        top: toolbarRect.top,
        rightInset: viewportWidth - toolbarRect.right,
        width: toolbarRect.width,
        height: toolbarRect.height,
        scrollHeight: toolbar.scrollHeight,
      },
      row: {
        width: rowRect ? rowRect.width : 0,
        right: rowRect ? rowRect.right : 0,
      },
      inspectButton: {
        width: inspectRect.width,
        height: inspectRect.height,
        top: inspectRect.top,
        right: inspectRect.right,
        backgroundColor: inspectStyle.backgroundColor,
        active: inspectButton.dataset.active || null,
        text: inspectButton.textContent.trim(),
        borderRadius: inspectStyle.borderRadius,
      },
      closeButton: {
        present: !!closeButton,
        width: closeRect ? closeRect.width : 0,
        height: closeRect ? closeRect.height : 0,
        display: closeButton ? getComputedStyle(closeButton).display : "none",
      },
      body: {
        display: bodyStyle ? bodyStyle.display : "none",
        width: bodyRect ? bodyRect.width : 0,
        right: bodyRect ? bodyRect.right : 0,
        borderRadius: bodyStyle ? bodyStyle.borderRadius : "0px",
      },
      selection: {
        selected: selectionSelected ? selectionSelected.textContent.trim() : "",
        content: selectionContent ? selectionContent.textContent.trim() : "",
        page: selectionPage ? selectionPage.textContent.trim() : "",
        element: selectionElement ? selectionElement.textContent.trim() : "",
      },
      layout: {
        buttonIsCompactSquare: Math.abs(inspectRect.width - inspectRect.height) <= 4,
        buttonHasLabelRoom: inspectRect.width > (inspectRect.height + 40),
        buttonFitsWithinToolbar: inspectRect.width <= (toolbarRect.width + 1),
        buttonBodyRightAligned: !bodyRect || Math.abs(inspectRect.right - bodyRect.right) <= 1.5,
        rowBodyWidthAligned: !bodyRect || Math.abs(rowRect.width - bodyRect.width) <= 1.5,
      },
      toolbarStyle: {
        gap: toolbarStyle.rowGap || toolbarStyle.gap || null,
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

function selectTargetSessionById(runtime, targetId) {
  if (!targetId) {
    return null;
  }
  return runtime.state.targetsById.get(targetId) || null;
}

function assertToolbarMetrics(metrics, {
  expectedState,
  expectedButtonText,
  expectedBody = false,
  expectedCollapsed,
} = {}) {
  assertCondition(metrics?.present, "Toolbar is missing.", metrics);
  if (expectedState) {
    assertCondition(metrics.state === expectedState, `Toolbar state mismatch: expected ${expectedState}, got ${metrics.state}.`, metrics);
  }
  if (expectedCollapsed !== undefined) {
    assertCondition(
      metrics.collapsed === (expectedCollapsed ? "true" : "false"),
      `Toolbar collapsed mismatch: expected ${expectedCollapsed}, got ${metrics.collapsed}.`,
      metrics,
    );
  }
  if (expectedButtonText !== undefined) {
    assertCondition(
      metrics.inspectButton.text === expectedButtonText,
      `Toolbar button mismatch: expected "${expectedButtonText}", got "${metrics.inspectButton.text}".`,
      metrics,
    );
  }
  if (expectedBody) {
    assertCondition(metrics.body.display !== "none", "Selection panel body is hidden.", metrics);
    assertCondition(metrics.selection.selected.length > 0, "Selected summary is empty.", metrics);
    assertCondition(metrics.selection.content.length > 0, "Selected content is empty.", metrics);
    assertCondition(metrics.selection.page.length > 0, "Selected page is empty.", metrics);
    assertCondition(metrics.selection.element.length > 0, "Selected element path is empty.", metrics);
    assertCondition(metrics.body.width <= metrics.toolbar.width + 1, "Selection body exceeds panel width.", metrics);
  } else {
    assertCondition(metrics.body.display === "none", "Selection panel body should be hidden.", metrics);
  }
  assertCondition(metrics.toolbar.top <= 28, "Toolbar is not pinned near the top edge.", metrics);
  assertCondition(metrics.toolbar.rightInset >= 16, "Toolbar is too close to the right edge.", metrics);
  assertCondition(metrics.toolbar.rightInset <= 24, "Toolbar is not pinned near the right edge.", metrics);
  assertCondition(metrics.toolbar.width <= 360, "Toolbar is wider than the intended panel width.", metrics);
  assertCondition(metrics.toolbar.scrollHeight <= metrics.toolbar.height + 1, "Toolbar content overflowed vertically.", metrics);
  assertCondition(metrics.layout.buttonFitsWithinToolbar, "Inspect button overflowed the toolbar width.", metrics);
  if (expectedCollapsed === true) {
    assertCondition(metrics.layout.buttonIsCompactSquare, "Collapsed inspect button is not square enough.", metrics);
    assertCondition(metrics.inspectButton.borderRadius === "12px", "Collapsed button radius drifted from the baseline.", metrics);
    assertCondition(metrics.closeButton.display === "none", "Close button should stay hidden in collapsed mode.", metrics);
  }
  if (expectedCollapsed === false) {
    assertCondition(metrics.layout.buttonHasLabelRoom, "Expanded inspect button did not grow to fit its label.", metrics);
    assertCondition(metrics.inspectButton.height >= 36 && metrics.inspectButton.height <= 40, "Expanded button height drifted from the compact control range.", metrics);
    assertCondition(metrics.inspectButton.borderRadius === "18px", "Expanded button radius drifted from the baseline.", metrics);
    assertCondition(metrics.closeButton.present, "Close button is missing in expanded mode.", metrics);
    assertCondition(metrics.closeButton.display !== "none", "Close button should be visible in expanded mode.", metrics);
    assertCondition(metrics.closeButton.width === 36 && metrics.closeButton.height === 36, "Close button size drifted from the compact square baseline.", metrics);
  }
  if (expectedBody) {
    assertCondition(metrics.body.borderRadius === "16px", "Details panel radius drifted from the baseline.", metrics);
    assertCondition(metrics.layout.rowBodyWidthAligned, "Top action row and details panel no longer share the same width.", metrics);
  }
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

async function waitForTargetUrl(runtime, sessionState, expectedPrefix, label) {
  const normalized = normalizeUrl(expectedPrefix);
  return waitFor(async () => {
    const metrics = await readToolbarMetrics(runtime, sessionState);
    const currentUrl = normalizeUrl(metrics?.url || "");
    return currentUrl.startsWith(normalized) ? metrics : null;
  }, 8000, label);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const outputDir = flags["output-dir"]
    ? path.resolve(String(flags["output-dir"]))
    : await mkdtemp(path.join(os.tmpdir(), "chrome-inspect-visual-"));
  await mkdir(outputDir, { recursive: true });

  const fixtureServer = await startFixtureServer();
  const startupUrl = `${fixtureServer.origin}/index.html`;
  const secondaryUrl = `${fixtureServer.origin}/next.html`;
  const openUrlScript = path.join(__dirname, "open_url.sh");
  const debugUrl = runShellScript(openUrlScript, [startupUrl]) || getDefaultDebugUrl();

  logStep(`Fixture server: ${fixtureServer.origin}`);
  logStep(`Debug URL: ${debugUrl}`);

  let runtime = await connectInspectRuntime({ debugUrl, startupUrl });
  let runtimeClosed = false;
  const results = [];

  try {
    const extraTab = await openExtraTab(runtime, secondaryUrl);
    const begin = await handleInspectAction(runtime.cdp, runtime.state, { action: "begin_capture" }, 1);
    const workflowId = begin.workflowId;
    assertCondition(Boolean(workflowId), "Failed to start inspect capture.", begin);

    let sessionState = await waitFor(async () => selectTargetSession(runtime, startupUrl), 5000, "fixture target attachment");
    const secondarySessionState = await waitFor(
      async () => selectTargetSessionById(runtime, extraTab?.targetId),
      5000,
      "secondary target attachment",
    );
    logStep("Validating initial idle state");
    results.push(await recordStep(runtime, sessionState, outputDir, "01-initial-idle", {
      expectedState: "idle",
      expectedButtonText: "",
      expectedCollapsed: true,
    }));
    logStep("Validating secondary tab idle injection");
    results.push(await recordStep(runtime, secondarySessionState, outputDir, "02-secondary-tab-idle", {
      expectedState: "idle",
      expectedButtonText: "",
      expectedCollapsed: true,
    }));

    logStep("Entering inspect mode");
    await clickSelector(runtime, sessionState, '[data-chrome-inspect-toolbar] button[data-role="inspect"]');
    results.push(await recordStep(runtime, sessionState, outputDir, "03-inspecting", {
      expectedState: "inspecting",
      expectedButtonText: "Inspecting",
      expectedCollapsed: false,
    }));

    logStep("Reloading page while idle workflow remains injected");
    await reloadTarget(runtime, sessionState);
    results.push(await recordStep(runtime, sessionState, outputDir, "04-idle-after-reload", {
      expectedState: "idle",
      expectedButtonText: "",
      expectedCollapsed: true,
    }));

    logStep("Re-entering inspect mode");
    await clickSelector(runtime, sessionState, '[data-chrome-inspect-toolbar] button[data-role="inspect"]');
    results.push(await recordStep(runtime, sessionState, outputDir, "05-inspecting-again", {
      expectedState: "inspecting",
      expectedButtonText: "Inspecting",
      expectedCollapsed: false,
    }));

    logStep("Triggering same-document navigation");
    await navigateHash(runtime, sessionState, "#details");
    results.push(await recordStep(runtime, sessionState, outputDir, "06-same-document-idle", {
      expectedState: "idle",
      expectedButtonText: "",
      expectedCollapsed: true,
    }));

    logStep("Entering inspect mode after same-document navigation");
    await clickSelector(runtime, sessionState, '[data-chrome-inspect-toolbar] button[data-role="inspect"]');
    results.push(await recordStep(runtime, sessionState, outputDir, "07-same-document-inspecting", {
      expectedState: "inspecting",
      expectedButtonText: "Inspecting",
      expectedCollapsed: false,
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
    assertCondition(Boolean(awaited?.selectionHistoryPath), "Expected selection history path in await payload.", awaited);
    const firstHistory = await readFile(awaited.selectionHistoryPath, "utf8");
    assertCondition(firstHistory.trim().length > 0, "Selection history file is empty after first capture.");
    results.push(await recordStep(runtime, sessionState, outputDir, "08-selected", {
      expectedState: "idle_selected",
      expectedButtonText: "Press this button to inspect",
      expectedBody: true,
      expectedCollapsed: false,
    }));

    logStep("Navigating to the second fixture page");
    await clickSelector(runtime, sessionState, "#fixture-next-link");
    await waitForTargetUrl(runtime, sessionState, `${fixtureServer.origin}/next.html`, "same-tab next page navigation");
    results.push(await recordStep(runtime, sessionState, outputDir, "09-selected-after-navigation", {
      expectedState: "idle_selected",
      expectedButtonText: "",
      expectedBody: false,
      expectedCollapsed: true,
    }));

    logStep("Triggering same-document navigation on the second page");
    await clickSelector(runtime, sessionState, "#fixture-notes-link");
    results.push(await recordStep(runtime, sessionState, outputDir, "10-selected-after-hash-nav", {
      expectedState: "idle_selected",
      expectedButtonText: "",
      expectedBody: false,
      expectedCollapsed: true,
    }));

    logStep("Re-entering inspect mode without a workflow");
    await clickSelector(runtime, sessionState, '[data-chrome-inspect-toolbar] button[data-role="inspect"]');
    results.push(await recordStep(runtime, sessionState, outputDir, "11-manual-reenter-inspecting", {
      expectedState: "inspecting",
      expectedButtonText: "Inspecting",
      expectedCollapsed: false,
    }));

    logStep("Selecting a target without creating a workflow");
    await clickSelector(runtime, sessionState, ".panel");
    results.push(await recordStep(runtime, sessionState, outputDir, "12-manual-reenter-selected", {
      expectedState: "idle_selected",
      expectedButtonText: "Press this button to inspect",
      expectedBody: true,
      expectedCollapsed: false,
    }));

    logStep("Starting a new capture on the second page");
    const secondBegin = await handleInspectAction(runtime.cdp, runtime.state, { action: "begin_capture" }, 3);
    assertCondition(Boolean(secondBegin?.workflowId), "Expected second capture workflow.", secondBegin);
    results.push(await recordStep(runtime, sessionState, outputDir, "13-second-capture-idle", {
      expectedState: "idle",
      expectedButtonText: "",
      expectedCollapsed: true,
    }));

    logStep("Entering inspect mode for the second capture");
    await clickSelector(runtime, sessionState, '[data-chrome-inspect-toolbar] button[data-role="inspect"]');
    results.push(await recordStep(runtime, sessionState, outputDir, "14-second-capture-inspecting", {
      expectedState: "inspecting",
      expectedButtonText: "Inspecting",
      expectedCollapsed: false,
    }));

    logStep("Validating narrow viewport layout");
    await setViewport(runtime, sessionState, 360, 800);
    results.push(await recordStep(runtime, sessionState, outputDir, "15-narrow-viewport", {
      expectedState: "inspecting",
      expectedButtonText: "Inspecting",
      expectedCollapsed: false,
    }));
    await clearViewport(runtime, sessionState);

    logStep("Selecting a target on the second page");
    await clickSelector(runtime, sessionState, ".panel");
    const secondAwaited = await handleInspectAction(runtime.cdp, runtime.state, {
      action: "await_selection",
      workflowId: secondBegin.workflowId,
      waitForSelectionMs: 500,
      timeoutMs: 6000,
    }, 4);
    assertCondition(secondAwaited?.phase === "awaiting_user_instruction", "Expected a completed second selection payload.", secondAwaited);
    assertCondition(Boolean(secondAwaited?.selectionHistoryPath), "Expected selection history path in second await payload.", secondAwaited);
    const secondHistory = await readFile(secondAwaited.selectionHistoryPath, "utf8");
    assertCondition(secondHistory.trim().split("\n").length >= 2, "Selection history did not append a second record.");
    const latestBeforeApply = await handleInspectAction(runtime.cdp, runtime.state, {
      action: "get_latest_selection",
    }, 40);
    assertCondition(
      normalizeUrl(latestBeforeApply?.page?.url) === normalizeUrl(secondAwaited?.page?.url),
      "Latest selection should point at the second page before apply.",
      latestBeforeApply,
    );
    assertCondition(
      latestBeforeApply?.selectedElement?.selectorHint === secondAwaited?.selectedElement?.selectorHint,
      "Latest selection should expose the second selector before apply.",
      latestBeforeApply,
    );
    assertCondition(
      latestBeforeApply?.selectedElement?.snippet === secondAwaited?.selectedElement?.snippet,
      "Latest selection should expose the second snippet before apply.",
      latestBeforeApply,
    );
    results.push(await recordStep(runtime, sessionState, outputDir, "16-second-selected", {
      expectedState: "idle_selected",
      expectedButtonText: "Press this button to inspect",
      expectedBody: true,
      expectedCollapsed: false,
    }));

    logStep("Clearing the workflow");
    const apply = await handleInspectAction(runtime.cdp, runtime.state, {
      action: "apply_instruction",
      workflowId: secondBegin.workflowId,
      instruction: "Visual validation complete.",
    }, 5);
    assertCondition(apply?.phase === "ready_to_apply", "Expected apply_instruction to complete.", apply);
    results.push(await recordStep(runtime, sessionState, outputDir, "17-toolbar-after-apply", {
      expectedState: "idle_selected",
      expectedButtonText: "Press this button to inspect",
      expectedBody: true,
      expectedCollapsed: false,
    }));
    await closeInspectRuntime(runtime.cdp, runtime.state);
    runtimeClosed = true;
    runtime = await connectInspectRuntime({ debugUrl, startupUrl });
    runtimeClosed = false;
    const latestAfterApply = await handleInspectAction(runtime.cdp, runtime.state, {
      action: "get_latest_selection",
    }, 41);
    assertCondition(
      normalizeUrl(latestAfterApply?.page?.url) === normalizeUrl(secondAwaited?.page?.url),
      "Latest selection should still point at the second page after reconnect.",
      latestAfterApply,
    );
    assertCondition(
      latestAfterApply?.selectedElement?.selectorHint === secondAwaited?.selectedElement?.selectorHint,
      "Latest selection should still expose the second selector after reconnect.",
      latestAfterApply,
    );
    assertCondition(
      latestAfterApply?.selectedElement?.snippet === secondAwaited?.selectedElement?.snippet,
      "Latest selection should still expose the second snippet after reconnect.",
      latestAfterApply,
    );

    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputDir,
      fixtureOrigin: fixtureServer.origin,
      screenshots: results.map((entry) => ({ name: entry.name, screenshot: entry.screenshot })),
    }, null, 2)}\n`);
  } finally {
    try {
      if (!runtimeClosed) {
        await closeInspectRuntime(runtime.cdp, runtime.state);
      }
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
