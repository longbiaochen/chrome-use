#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

import { getDefaultDebugUrl } from "./inspect_runtime.mjs";

function printUsage() {
  console.error(`Usage:
  auth-cdp status [--browser-url <url>]
  auth-cdp navigate --url <url> [--browser-url <url>]
  auth-cdp snapshot [--output <path>] [--browser-url <url>]
  auth-cdp find --selector <css> [--browser-url <url>]
  auth-cdp click --selector <css> [--browser-url <url>]
  auth-cdp type --selector <css> --text <text> [--browser-url <url>]`);
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

function createProtocolSession(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  let messageId = 1;

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (event) => reject(event.error || new Error("WebSocket connection failed")));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        item.reject(new Error(message.error.message || "CDP request failed"));
      } else {
        item.resolve(message.result);
      }
      return;
    }
    for (const listener of listeners) {
      listener(message);
    }
  });

  socket.addEventListener("close", () => {
    for (const item of pending.values()) {
      item.reject(new Error("CDP connection closed"));
    }
    pending.clear();
  });

  return {
    async waitOpen() {
      await opened;
    },
    async send(method, params = {}) {
      await opened;
      return new Promise((resolve, reject) => {
        const id = messageId += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    onEvent(listener) {
      listeners.push(listener);
    },
    close() {
      socket.close();
    },
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function resolvePageTarget(debugUrl) {
  const version = await fetchJson(`${debugUrl}/json/version`);
  const list = await fetchJson(`${debugUrl}/json/list`);
  const pages = Array.isArray(list) ? list.filter((item) => item?.type === "page") : [];
  const activePage = pages[0] || null;
  return {
    browserWsUrl: version.webSocketDebuggerUrl || null,
    pageWsUrl: activePage?.webSocketDebuggerUrl || null,
    page: activePage,
  };
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value;
}

function escapeJsString(value) {
  return JSON.stringify(String(value));
}

async function openPageSession(debugUrl) {
  const target = await resolvePageTarget(debugUrl);
  if (!target.pageWsUrl) {
    throw new Error(`No page target is available at ${debugUrl}. Open a page in the dedicated profile first.`);
  }
  const session = createProtocolSession(target.pageWsUrl);
  await session.waitOpen();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("DOM.enable");
  return { session, target };
}

async function runStatus(debugUrl) {
  const target = await resolvePageTarget(debugUrl);
  return {
    browserUrl: debugUrl,
    connected: Boolean(target.browserWsUrl),
    pageCount: target.page ? 1 : 0,
    page: target.page
      ? {
          id: target.page.id || null,
          title: target.page.title || null,
          url: target.page.url || null,
        }
      : null,
  };
}

async function runNavigate(debugUrl, url) {
  const { session } = await openPageSession(debugUrl);
  try {
    await session.send("Page.navigate", { url });
    await session.send("Page.waitForLoadEventFired");
    return {
      browserUrl: debugUrl,
      navigatedTo: url,
    };
  } finally {
    session.close();
  }
}

async function runSnapshot(debugUrl, outputPath = "") {
  const { session } = await openPageSession(debugUrl);
  try {
    const page = await evaluate(
      session,
      `(() => ({
        title: document.title || "",
        url: location.href,
        readyState: document.readyState,
        activeElement: document.activeElement ? {
          tagName: document.activeElement.tagName,
          id: document.activeElement.id || "",
          className: document.activeElement.className || "",
          ariaLabel: document.activeElement.getAttribute("aria-label") || ""
        } : null
      }))()`,
    );
    const screenshot = await session.send("Page.captureScreenshot", { format: "png" });
    if (outputPath) {
      await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
    }
    return {
      browserUrl: debugUrl,
      page,
      screenshotPath: outputPath || null,
      screenshotCaptured: Boolean(screenshot.data),
    };
  } finally {
    session.close();
  }
}

async function runFind(debugUrl, selector) {
  const { session } = await openPageSession(debugUrl);
  try {
    const result = await evaluate(
      session,
      `(() => {
        const element = document.querySelector(${escapeJsString(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          selector: ${escapeJsString(selector)},
          found: true,
          tagName: element.tagName,
          id: element.id || "",
          className: element.className || "",
          text: (element.innerText || element.textContent || "").trim().slice(0, 400),
          ariaLabel: element.getAttribute("aria-label") || "",
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      })()`,
    );
    return result || { selector, found: false };
  } finally {
    session.close();
  }
}

async function runClick(debugUrl, selector) {
  const { session } = await openPageSession(debugUrl);
  try {
    const result = await evaluate(
      session,
      `(() => {
        const element = document.querySelector(${escapeJsString(selector)});
        if (!element) return { clicked: false, reason: "not_found" };
        element.click();
        return {
          clicked: true,
          selector: ${escapeJsString(selector)},
          tagName: element.tagName,
          id: element.id || "",
          className: element.className || ""
        };
      })()`,
    );
    return result;
  } finally {
    session.close();
  }
}

async function runType(debugUrl, selector, text) {
  const { session } = await openPageSession(debugUrl);
  try {
    const result = await evaluate(
      session,
      `(() => {
        const element = document.querySelector(${escapeJsString(selector)});
        if (!element) return { updated: false, reason: "not_found" };
        if (!("value" in element)) return { updated: false, reason: "not_editable" };
        element.focus();
        element.value = ${escapeJsString(text)};
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          updated: true,
          selector: ${escapeJsString(selector)},
          valueLength: element.value.length
        };
      })()`,
    );
    return result;
  } finally {
    session.close();
  }
}

async function main() {
  try {
    const { command, flags } = parseArgs(process.argv.slice(2));
    if (!command || flags.help) {
      printUsage();
      process.exit(command ? 0 : 1);
    }

    const debugUrl = flags["browser-url"] || getDefaultDebugUrl();
    let result;

    if (command === "status") {
      result = await runStatus(debugUrl);
    } else if (command === "navigate") {
      if (!flags.url) {
        throw new Error("auth-cdp navigate requires --url.");
      }
      result = await runNavigate(debugUrl, flags.url);
    } else if (command === "snapshot") {
      result = await runSnapshot(debugUrl, flags.output || "");
    } else if (command === "find") {
      if (!flags.selector) {
        throw new Error("auth-cdp find requires --selector.");
      }
      result = await runFind(debugUrl, flags.selector);
    } else if (command === "click") {
      if (!flags.selector) {
        throw new Error("auth-cdp click requires --selector.");
      }
      result = await runClick(debugUrl, flags.selector);
    } else if (command === "type") {
      if (!flags.selector || !Object.hasOwn(flags, "text")) {
        throw new Error("auth-cdp type requires --selector and --text.");
      }
      result = await runType(debugUrl, flags.selector, flags.text);
    } else {
      throw new Error(`Unsupported auth-cdp command: ${command}`);
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
  }
}

await main();
