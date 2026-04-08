#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getDefaultDebugUrl } from "./inspect_runtime.mjs";

const DEFAULT_ACTION_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 100;

function printUsage() {
  console.error(`Usage:
  auth-cdp status [--browser-url <url>]
  auth-cdp list-pages [--browser-url <url>]
  auth-cdp select-page --page-id <id> [--browser-url <url>]
  auth-cdp navigate --url <url> [--browser-url <url>] [--page-id <id>]
  auth-cdp wait-for --text <value> [--timeout-ms <ms>] [--browser-url <url>] [--page-id <id>]
  auth-cdp snapshot [--mode dom|a11y] [--output <path>] [--browser-url <url>] [--page-id <id>]
  auth-cdp screenshot [--selector <css>] [--output <path>] [--browser-url <url>] [--page-id <id>]
  auth-cdp find --selector <css> [--browser-url <url>] [--page-id <id>]
  auth-cdp hover --selector <css> [--browser-url <url>] [--page-id <id>]
  auth-cdp click --selector <css> [--browser-url <url>] [--page-id <id>]
  auth-cdp fill --selector <css> --text <text> [--browser-url <url>] [--page-id <id>]
  auth-cdp type --selector <css> --text <text> [--browser-url <url>] [--page-id <id>]
  auth-cdp press-key --key <key> [--browser-url <url>] [--page-id <id>]`);
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
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
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

function getStateRoot() {
  return process.env.CHROME_USE_STATE_DIR || path.join(os.homedir(), ".chrome-use", "state");
}

function getAuthScope(debugUrl) {
  const parsed = new URL(debugUrl);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return path.join(getStateRoot(), "auth", `${parsed.hostname}-${port}`);
}

function getSelectedPagePath(debugUrl) {
  return path.join(getAuthScope(debugUrl), "selected-page.json");
}

async function readSelectedPage(debugUrl) {
  const filePath = getSelectedPagePath(debugUrl);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const payload = JSON.parse(await readFile(filePath, "utf8"));
    return typeof payload?.pageId === "string" && payload.pageId ? payload.pageId : null;
  } catch {
    return null;
  }
}

async function writeSelectedPage(debugUrl, pageId) {
  const filePath = getSelectedPagePath(debugUrl);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ pageId, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function serializePage(page, selectedPageId = null) {
  if (!page) {
    return null;
  }
  return {
    id: page.id || null,
    title: page.title || null,
    url: page.url || null,
    selected: Boolean(selectedPageId && page.id === selectedPageId),
  };
}

async function resolvePageState(debugUrl, explicitPageId = "") {
  const version = await fetchJson(`${debugUrl}/json/version`);
  const list = await fetchJson(`${debugUrl}/json/list`);
  const pages = Array.isArray(list) ? list.filter((item) => item?.type === "page") : [];
  const storedPageId = explicitPageId || (await readSelectedPage(debugUrl)) || "";
  let selectedPage = storedPageId ? pages.find((item) => item?.id === storedPageId) || null : null;
  let selectionSource = explicitPageId ? "requested_page" : storedPageId ? "stored_page" : "latest_page";

  if (!selectedPage) {
    selectedPage = pages[pages.length - 1] || null;
    if (storedPageId && !explicitPageId) {
      selectionSource = "stored_page_missing";
    }
  }

  return {
    browserWsUrl: version.webSocketDebuggerUrl || null,
    pages,
    selectedPage,
    selectionSource,
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

async function openPageSession(debugUrl, explicitPageId = "") {
  const pageState = await resolvePageState(debugUrl, explicitPageId);
  if (!pageState.selectedPage?.webSocketDebuggerUrl) {
    throw new Error(`No page target is available at ${debugUrl}. Open a page in the dedicated profile first.`);
  }
  const session = createProtocolSession(pageState.selectedPage.webSocketDebuggerUrl);
  await session.waitOpen();
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("DOM.enable");
  return { session, pageState };
}

function probeSelectorExpression(selector) {
  return `(() => {
    const element = document.querySelector(${escapeJsString(selector)});
    if (!element) {
      return { found: false, reason: "not_found", selector: ${escapeJsString(selector)} };
    }
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    const disabled = Boolean(element.disabled || element.getAttribute("aria-disabled") === "true");
    const editable =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element.isContentEditable;
    return {
      found: true,
      selector: ${escapeJsString(selector)},
      tagName: element.tagName,
      id: element.id || "",
      className: element.className || "",
      text: (element.innerText || element.textContent || "").trim().slice(0, 400),
      ariaLabel: element.getAttribute("aria-label") || "",
      visible,
      disabled,
      editable,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  })()`;
}

function waitForTextExpression(text) {
  return `(() => {
    const bodyText = (document.body?.innerText || document.body?.textContent || "").trim();
    return {
      found: bodyText.includes(${escapeJsString(text)}),
      text: ${escapeJsString(text)},
      url: location.href,
      title: document.title || "",
      readyState: document.readyState
    };
  })()`;
}

async function waitForLoadEvent(session, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for page load.`));
    }, timeoutMs);
    const unsubscribe = session.onEvent((message) => {
      if (message.method === "Page.loadEventFired") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

async function waitForPageReady(session, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, expectedUrl = "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const page = await evaluate(
      session,
      `(() => ({ url: location.href, readyState: document.readyState, title: document.title || "" }))()`,
    );
    if (page?.readyState === "complete") {
      if (!expectedUrl || normalizeComparableUrl(page.url) === normalizeComparableUrl(expectedUrl)) {
        return page;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for page readiness.`);
}

function normalizeComparableUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return String(value || "");
  }
}

async function waitForSelector(session, selector, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const probe = await evaluate(session, probeSelectorExpression(selector));
    if (probe?.found && probe.visible) {
      return probe;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return {
    found: false,
    reason: "timeout",
    selector,
    timeoutMs,
  };
}

async function waitForText(session, text, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = await evaluate(session, waitForTextExpression(text));
    if (result?.found) {
      return result;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return {
    found: false,
    text,
    timeoutMs,
  };
}

async function dispatchMouseClick(session, rect) {
  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { x, y };
}

async function dispatchHover(session, rect) {
  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  return { x, y };
}

function parseTimeout(flags, fallbackMs) {
  const raw = flags["timeout-ms"];
  if (raw === undefined) {
    return fallbackMs;
  }
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${raw}`);
  }
  return value;
}

function parseKeyCombo(combo) {
  const normalized = String(combo || "").trim();
  if (!normalized) {
    throw new Error("auth-cdp press-key requires --key.");
  }

  let baseKey = normalized;
  let modifierPart = "";
  if (normalized.includes("+")) {
    const lastSeparator = normalized.lastIndexOf("+");
    modifierPart = normalized.slice(0, lastSeparator);
    baseKey = normalized.slice(lastSeparator + 1);
    if (!baseKey) {
      baseKey = "+";
    }
  }

  const modifiers = modifierPart
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  return { modifiers, baseKey };
}

function getKeyDefinition(baseKey) {
  const aliasMap = {
    Esc: "Escape",
    Spacebar: "Space",
    " ": "Space",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
  };
  const key = aliasMap[baseKey] || baseKey;

  const special = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    Space: { code: "Space", keyCode: 32, text: " " },
    "+": { code: "Equal", keyCode: 187, text: "+" },
  };
  if (special[key]) {
    return { key, ...special[key] };
  }

  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return {
      key: upper,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: upper,
    };
  }

  if (/^[0-9]$/.test(key)) {
    return {
      key,
      code: `Digit${key}`,
      keyCode: key.charCodeAt(0),
      text: key,
    };
  }

  return {
    key,
    code: key,
    keyCode: 0,
  };
}

function getModifierDefinition(name) {
  const normalized = String(name || "").trim();
  const definitions = {
    Control: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
    Ctrl: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
    Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, bit: 8 },
    Alt: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
    Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
    Command: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  };
  const definition = definitions[normalized];
  if (!definition) {
    throw new Error(`Unsupported modifier key: ${name}`);
  }
  return definition;
}

async function runStatus(debugUrl) {
  const pageState = await resolvePageState(debugUrl);
  return {
    browserUrl: debugUrl,
    connected: Boolean(pageState.browserWsUrl),
    pageCount: pageState.pages.length,
    selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
    selectionSource: pageState.selectionSource,
    pages: pageState.pages.map((page) => serializePage(page, pageState.selectedPage?.id || null)),
  };
}

async function runListPages(debugUrl) {
  const status = await runStatus(debugUrl);
  return {
    browserUrl: status.browserUrl,
    pageCount: status.pageCount,
    selectedPage: status.selectedPage,
    pages: status.pages,
  };
}

async function runSelectPage(debugUrl, pageId) {
  const pageState = await resolvePageState(debugUrl, pageId);
  if (!pageState.selectedPage || pageState.selectedPage.id !== pageId) {
    throw new Error(`Could not find page id '${pageId}' on ${debugUrl}.`);
  }
  await writeSelectedPage(debugUrl, pageId);
  return {
    browserUrl: debugUrl,
    selectedPage: serializePage(pageState.selectedPage, pageId),
    pageCount: pageState.pages.length,
  };
}

async function runNavigate(debugUrl, url, pageId = "", timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
  try {
    await session.send("Page.navigate", { url });
    const page = await waitForPageReady(session, timeoutMs, url);
    return {
      browserUrl: debugUrl,
      navigatedTo: page?.url || url,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      page,
    };
  } finally {
    session.close();
  }
}

async function runSnapshot(debugUrl, mode = "dom", outputPath = "", pageId = "") {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
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

    let snapshot;
    if (mode === "a11y") {
      const tree = await session.send("Accessibility.getFullAXTree");
      snapshot = {
        nodeCount: Array.isArray(tree?.nodes) ? tree.nodes.length : 0,
        nodes: Array.isArray(tree?.nodes)
          ? tree.nodes
              .filter((node) => !node?.ignored)
              .slice(0, 120)
              .map((node) => ({
                nodeId: node.nodeId ?? null,
                role: node.role?.value || null,
                name: node.name?.value || "",
                description: node.description?.value || "",
                value: node.value?.value ?? "",
                properties: Array.isArray(node.properties)
                  ? node.properties.slice(0, 8).map((property) => ({
                      name: property.name || null,
                      value: property.value?.value ?? property.value ?? null,
                    }))
                  : [],
              }))
          : [],
      };
    } else {
      snapshot = await evaluate(
        session,
        `(() => {
          const isVisible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const nodes = Array.from(document.querySelectorAll("a,button,input,select,textarea,[role='button'],[role='link'],[tabindex]"))
            .filter(isVisible)
            .slice(0, 80)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                tagName: element.tagName,
                id: element.id || "",
                className: element.className || "",
                text: (element.innerText || element.textContent || "").trim().slice(0, 160),
                ariaLabel: element.getAttribute("aria-label") || "",
                href: element.href || "",
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height
                }
              };
            });
          return {
            interactive: nodes,
            bodyTextSample: (document.body?.innerText || document.body?.textContent || "").trim().slice(0, 1200)
          };
        })()`,
      );
    }

    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify({ page, mode, snapshot }, null, 2)}\n`, "utf8");
    }

    return {
      browserUrl: debugUrl,
      mode,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      page,
      snapshot,
      outputPath: outputPath || null,
    };
  } finally {
    session.close();
  }
}

async function runScreenshot(debugUrl, outputPath = "", selector = "", pageId = "") {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
  try {
    let screenshot;
    let matchedElement = null;

    if (selector) {
      const probe = await waitForSelector(session, selector, DEFAULT_ACTION_TIMEOUT_MS);
      if (!probe?.found) {
        return {
          browserUrl: debugUrl,
          selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
          selector,
          screenshotCaptured: false,
          reason: probe?.reason || "not_found",
        };
      }
      matchedElement = probe;
      screenshot = await session.send("Page.captureScreenshot", {
        format: "png",
        clip: {
          x: probe.rect.x,
          y: probe.rect.y,
          width: probe.rect.width,
          height: probe.rect.height,
          scale: 1,
        },
      });
    } else {
      screenshot = await session.send("Page.captureScreenshot", { format: "png" });
    }

    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
    }

    return {
      browserUrl: debugUrl,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      selector: selector || null,
      matchedElement,
      screenshotPath: outputPath || null,
      screenshotCaptured: Boolean(screenshot.data),
    };
  } finally {
    session.close();
  }
}

async function runFind(debugUrl, selector, pageId = "") {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
  try {
    const result = await evaluate(session, probeSelectorExpression(selector));
    return {
      browserUrl: debugUrl,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      ...(result || { selector, found: false }),
    };
  } finally {
    session.close();
  }
}

async function runHover(debugUrl, selector, pageId = "") {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
  try {
    const probe = await waitForSelector(session, selector, DEFAULT_ACTION_TIMEOUT_MS);
    if (!probe?.found) {
      return {
        browserUrl: debugUrl,
        selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
        selector,
        hovered: false,
        reason: probe?.reason || "not_found",
      };
    }
    const position = await dispatchHover(session, probe.rect);
    return {
      browserUrl: debugUrl,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      hovered: true,
      selector,
      tagName: probe.tagName,
      id: probe.id,
      className: probe.className,
      position,
    };
  } finally {
    session.close();
  }
}

async function runClick(debugUrl, selector, pageId = "") {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
  try {
    const probe = await waitForSelector(session, selector, DEFAULT_ACTION_TIMEOUT_MS);
    if (!probe?.found) {
      return {
        browserUrl: debugUrl,
        selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
        selector,
        clicked: false,
        reason: probe?.reason || "not_found",
      };
    }
    if (probe.disabled) {
      return {
        browserUrl: debugUrl,
        selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
        selector,
        clicked: false,
        reason: "disabled",
      };
    }
    const position = await dispatchMouseClick(session, probe.rect);
    const domClick = await evaluate(
      session,
      `(() => {
        const element = document.querySelector(${escapeJsString(selector)});
        if (!element) {
          return { clicked: false, reason: "not_found_after_mouse" };
        }
        if (typeof element.focus === "function") {
          element.focus();
        }
        if (typeof element.click === "function") {
          element.click();
        }
        return {
          clicked: true,
          tagName: element.tagName,
          id: element.id || "",
          className: element.className || ""
        };
      })()`,
    );
    return {
      browserUrl: debugUrl,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      clicked: Boolean(domClick?.clicked),
      selector,
      tagName: domClick?.tagName || probe.tagName,
      id: domClick?.id || probe.id,
      className: domClick?.className || probe.className,
      position,
    };
  } finally {
    session.close();
  }
}

async function runFill(debugUrl, selector, text, pageId = "", mode = "fill") {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
  try {
    const probe = await waitForSelector(session, selector, DEFAULT_ACTION_TIMEOUT_MS);
    if (!probe?.found) {
      return {
        browserUrl: debugUrl,
        selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
        selector,
        updated: false,
        reason: probe?.reason || "not_found",
      };
    }
    const result = await evaluate(
      session,
      `(() => {
        const element = document.querySelector(${escapeJsString(selector)});
        if (!element) return { updated: false, reason: "not_found" };
        if (element.disabled || element.getAttribute("aria-disabled") === "true") {
          return { updated: false, reason: "disabled" };
        }
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        element.focus();
        if (element instanceof HTMLSelectElement) {
          const option = Array.from(element.options).find((candidate) =>
            candidate.value === ${escapeJsString(text)} || candidate.text.trim() === ${escapeJsString(text)}
          );
          if (!option) {
            return { updated: false, reason: "option_not_found" };
          }
          element.value = option.value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { updated: true, valueLength: element.value.length, tagName: element.tagName };
        }
        if (!(element instanceof HTMLInputElement) &&
            !(element instanceof HTMLTextAreaElement) &&
            !element.isContentEditable) {
          return { updated: false, reason: "not_editable" };
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) {
            setter.call(element, ${escapeJsString(text)});
          } else {
            element.value = ${escapeJsString(text)};
          }
        } else {
          element.textContent = ${escapeJsString(text)};
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          updated: true,
          valueLength: ("value" in element ? String(element.value || "") : String(element.textContent || "")).length,
          tagName: element.tagName
        };
      })()`,
    );
    return {
      browserUrl: debugUrl,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      selector,
      mode,
      ...(result || { updated: false, reason: "unknown" }),
    };
  } finally {
    session.close();
  }
}

async function runWaitFor(debugUrl, text, timeoutMs, pageId = "") {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
  try {
    const result = await waitForText(session, text, timeoutMs);
    return {
      browserUrl: debugUrl,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      ...result,
    };
  } finally {
    session.close();
  }
}

async function runPressKey(debugUrl, keyCombo, pageId = "") {
  const { session, pageState } = await openPageSession(debugUrl, pageId);
  try {
    const { modifiers, baseKey } = parseKeyCombo(keyCombo);
    let modifierBits = 0;
    const modifierDefinitions = modifiers.map((modifier) => getModifierDefinition(modifier));
    for (const modifier of modifierDefinitions) {
      modifierBits |= modifier.bit;
      await session.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        nativeVirtualKeyCode: modifier.keyCode,
        modifiers: modifierBits,
      });
    }

    const keyDefinition = getKeyDefinition(baseKey);
    const keyDownType = keyDefinition.text && modifierDefinitions.length === 0 ? "keyDown" : "rawKeyDown";
    await session.send("Input.dispatchKeyEvent", {
      type: keyDownType,
      key: keyDefinition.key,
      code: keyDefinition.code,
      text: modifierDefinitions.length === 0 ? keyDefinition.text || "" : "",
      windowsVirtualKeyCode: keyDefinition.keyCode,
      nativeVirtualKeyCode: keyDefinition.keyCode,
      modifiers: modifierBits,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyDefinition.key,
      code: keyDefinition.code,
      windowsVirtualKeyCode: keyDefinition.keyCode,
      nativeVirtualKeyCode: keyDefinition.keyCode,
      modifiers: modifierBits,
    });

    for (let idx = modifierDefinitions.length - 1; idx >= 0; idx -= 1) {
      const modifier = modifierDefinitions[idx];
      modifierBits &= ~modifier.bit;
      await session.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        nativeVirtualKeyCode: modifier.keyCode,
        modifiers: modifierBits,
      });
    }

    return {
      browserUrl: debugUrl,
      selectedPage: serializePage(pageState.selectedPage, pageState.selectedPage?.id || null),
      pressed: true,
      key: keyCombo,
    };
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
    const pageId = flags["page-id"] || "";
    let result;

    if (command === "status") {
      result = await runStatus(debugUrl);
    } else if (command === "list-pages") {
      result = await runListPages(debugUrl);
    } else if (command === "select-page") {
      if (!flags["page-id"]) {
        throw new Error("auth-cdp select-page requires --page-id.");
      }
      result = await runSelectPage(debugUrl, flags["page-id"]);
    } else if (command === "navigate") {
      if (!flags.url) {
        throw new Error("auth-cdp navigate requires --url.");
      }
      result = await runNavigate(debugUrl, flags.url, pageId, parseTimeout(flags, DEFAULT_WAIT_TIMEOUT_MS));
    } else if (command === "wait-for") {
      if (!Object.hasOwn(flags, "text")) {
        throw new Error("auth-cdp wait-for requires --text.");
      }
      result = await runWaitFor(debugUrl, flags.text, parseTimeout(flags, DEFAULT_WAIT_TIMEOUT_MS), pageId);
    } else if (command === "snapshot") {
      const mode = flags.mode || "dom";
      if (!["dom", "a11y"].includes(mode)) {
        throw new Error("auth-cdp snapshot --mode must be 'dom' or 'a11y'.");
      }
      result = await runSnapshot(debugUrl, mode, flags.output || "", pageId);
    } else if (command === "screenshot") {
      result = await runScreenshot(debugUrl, flags.output || "", flags.selector || "", pageId);
    } else if (command === "find") {
      if (!flags.selector) {
        throw new Error("auth-cdp find requires --selector.");
      }
      result = await runFind(debugUrl, flags.selector, pageId);
    } else if (command === "hover") {
      if (!flags.selector) {
        throw new Error("auth-cdp hover requires --selector.");
      }
      result = await runHover(debugUrl, flags.selector, pageId);
    } else if (command === "click") {
      if (!flags.selector) {
        throw new Error("auth-cdp click requires --selector.");
      }
      result = await runClick(debugUrl, flags.selector, pageId);
    } else if (command === "fill") {
      if (!flags.selector || !Object.hasOwn(flags, "text")) {
        throw new Error("auth-cdp fill requires --selector and --text.");
      }
      result = await runFill(debugUrl, flags.selector, flags.text, pageId, "fill");
    } else if (command === "type") {
      if (!flags.selector || !Object.hasOwn(flags, "text")) {
        throw new Error("auth-cdp type requires --selector and --text.");
      }
      result = await runFill(debugUrl, flags.selector, flags.text, pageId, "type");
    } else if (command === "press-key") {
      if (!flags.key) {
        throw new Error("auth-cdp press-key requires --key.");
      }
      result = await runPressKey(debugUrl, flags.key, pageId);
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
