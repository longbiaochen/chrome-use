#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..", "..", "..");
const authOpenUrlScript = path.join(repoRoot, "skills", "chrome-auth", "scripts", "open_url.sh");
const authCdpScript = path.join(repoRoot, "skills", "chrome-auth", "scripts", "auth-cdp");
const canonicalDebugUrl = "http://127.0.0.1:9223";

const demoIdentity = {
  name: "John Appleseed",
  email: "john.appleseed@example.com",
  password: "OpenAI-demo-2026!",
};

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

function logStep(message) {
  process.stderr.write(`[auth-visual] ${message}\n`);
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

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value || "";
  }
}

function runShellScript(scriptPath, args = [], env = process.env) {
  return execFileSync(scriptPath, args, {
    env,
    encoding: "utf8",
  }).trim();
}

function runAuthJson(args, env = process.env) {
  const output = runShellScript(authCdpScript, args, env);
  return JSON.parse(output);
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

function createProtocolSession(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let messageId = 1;

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (event) => reject(event.error || new Error("WebSocket connection failed")));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      return;
    }
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
    close() {
      socket.close();
    },
  };
}

function parseCookies(rawCookie = "") {
  const result = {};
  for (const part of String(rawCookie).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      result[trimmed] = "";
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

async function readFormBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function htmlDocument({ title, eyebrow, heading, body, aside = "" }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --page-bg: #f4f7ff;
        --surface: rgba(255, 255, 255, 0.92);
        --surface-border: rgba(23, 34, 61, 0.08);
        --text: #152038;
        --muted: #5e6f8a;
        --accent: #1264ff;
        --accent-soft: rgba(18, 100, 255, 0.12);
        --success: #0e9f6e;
        --danger: #ff4d4f;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(18, 100, 255, 0.16), transparent 30%),
          radial-gradient(circle at bottom right, rgba(14, 159, 110, 0.14), transparent 32%),
          linear-gradient(180deg, #fbfdff 0%, var(--page-bg) 100%);
      }
      .shell {
        width: min(1160px, calc(100vw - 56px));
        margin: 0 auto;
        padding: 56px 0 88px;
        display: grid;
        gap: 28px;
        grid-template-columns: minmax(0, 1.25fr) minmax(300px, 360px);
      }
      .card, .aside {
        border: 1px solid var(--surface-border);
        border-radius: 28px;
        background: var(--surface);
        box-shadow: 0 20px 48px rgba(19, 33, 61, 0.08);
        backdrop-filter: blur(16px);
      }
      .card { padding: 32px; }
      .aside {
        padding: 24px;
        align-self: start;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }
      h1 {
        margin: 18px 0 12px;
        font-size: clamp(2.4rem, 4vw, 3.5rem);
        line-height: 0.96;
      }
      p {
        margin: 0 0 16px;
        color: var(--muted);
        line-height: 1.6;
        font-size: 15px;
      }
      .hero-actions {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin-top: 28px;
      }
      a.button, button, .ghost-link {
        appearance: none;
        border: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 48px;
        padding: 0 18px;
        border-radius: 18px;
        text-decoration: none;
        font-weight: 700;
        font-size: 14px;
        cursor: pointer;
        transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
      }
      a.button:hover, button:hover, .ghost-link:hover {
        transform: translateY(-1px);
      }
      .button-primary {
        color: white;
        background: linear-gradient(135deg, #1264ff 0%, #2d86ff 100%);
        box-shadow: 0 12px 24px rgba(18, 100, 255, 0.24);
      }
      .button-secondary {
        color: var(--text);
        background: rgba(21, 32, 56, 0.06);
      }
      .pill-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      .pill {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(21, 32, 56, 0.06);
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
        font-weight: 700;
      }
      form, .stack {
        display: grid;
        gap: 14px;
      }
      input {
        width: 100%;
        min-height: 48px;
        padding: 0 14px;
        border-radius: 18px;
        border: 1px solid rgba(21, 32, 56, 0.12);
        background: white;
        color: var(--text);
        font: inherit;
      }
      .banner {
        margin: 18px 0 0;
        padding: 14px 16px;
        border-radius: 18px;
        font-size: 14px;
        font-weight: 600;
      }
      .banner-success {
        background: rgba(14, 159, 110, 0.14);
        color: var(--success);
      }
      .status-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin-top: 22px;
      }
      .status-card {
        padding: 18px;
        border-radius: 22px;
        background: rgba(21, 32, 56, 0.04);
      }
      .status-card small {
        display: block;
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--muted);
        font-weight: 700;
      }
      .nav {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(3, max-content);
        margin-top: 28px;
      }
      .ghost-link {
        justify-content: flex-start;
        color: var(--text);
        background: rgba(21, 32, 56, 0.04);
      }
      .aside h2 {
        margin: 0 0 14px;
        font-size: 1.18rem;
      }
      .aside ul {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 10px;
        color: var(--muted);
        line-height: 1.5;
      }
      .aside strong { color: var(--text); }
      @media (max-width: 900px) {
        .shell { grid-template-columns: 1fr; }
        .hero-actions { grid-template-columns: 1fr; }
        .nav { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="card">
        <span class="eyebrow">${eyebrow}</span>
        <h1>${heading}</h1>
        ${body}
      </section>
      <aside class="aside">
        ${aside}
      </aside>
    </main>
  </body>
</html>`;
}

function renderHomePage() {
  return htmlDocument({
    title: "Chrome Auth Demo Service",
    eyebrow: "Chrome Auth demo",
    heading: "Find the real auth entry point directly from the page.",
    body: `
      <p>This local app simulates the thing that makes web auth messy in practice: sign-up and log-in live side by side, the structure is app-specific, and an agent needs to find the real path without relying on screenshots.</p>
      <div class="hero-actions">
        <a id="sign-up-link" class="button button-primary" href="/sign-up">Sign up</a>
        <a id="log-in-link" class="button button-secondary" href="/log-in">Log in</a>
      </div>
      <div class="pill-row">
        <span class="pill">DOM search</span>
        <span class="pill">Structured snapshot</span>
        <span class="pill">Fast auth handoff</span>
      </div>
      <nav class="nav">
        <a class="ghost-link" id="plans-link" href="/plans">Open extra tab</a>
        <a class="ghost-link" href="/sign-up">Go to sign up</a>
        <a class="ghost-link" href="/log-in">Go to log in</a>
      </nav>`,
    aside: `
      <h2>What this demo proves</h2>
      <ul>
        <li><strong>No screenshot guessing.</strong> <code>chrome-auth</code> searches and acts through CDP.</li>
        <li><strong>Entry points vary.</strong> Real services rarely make login and registration uniform.</li>
        <li><strong>Same session continues.</strong> The authenticated state stays in the dedicated agent browser.</li>
      </ul>`,
  });
}

function renderPlansPage() {
  return htmlDocument({
    title: "Plans | Chrome Auth Demo Service",
    eyebrow: "Background tab",
    heading: "This tab exists to prove page-aware automation.",
    body: `
      <p>The runner opens this page in a second tab before auth begins, then uses <code>list-pages</code> and <code>select-page</code> to get back to the real app tab before acting.</p>
      <div class="status-grid">
        <section class="status-card">
          <small>Page selection</small>
          <strong>Enumerate tabs first</strong>
          <p>Automation breaks when the wrong page target receives the click.</p>
        </section>
        <section class="status-card">
          <small>Why it matters</small>
          <strong>Target the right app state</strong>
          <p>The same browser session can host multiple tabs and still stay deterministic.</p>
        </section>
      </div>`,
    aside: `
      <h2>Why keep this page</h2>
      <ul>
        <li>This page stays out of the GIF.</li>
        <li>It still validates the richer <code>chrome-auth</code> page control surface.</li>
      </ul>`,
  });
}

function renderSignUpPage() {
  return htmlDocument({
    title: "Sign up | Chrome Auth Demo Service",
    eyebrow: "Sign up",
    heading: "Create the account the agent will use next.",
    body: `
      <p>This page is intentionally ordinary: the field names are clear, but the agent still has to find them, fill them, and submit the form without treating the page as an image.</p>
      <form method="post" action="/sign-up">
        <label for="sign-up-name">Full name
          <input id="sign-up-name" name="name" type="text" autocomplete="name" value="">
        </label>
        <label for="sign-up-email">Work email
          <input id="sign-up-email" name="email" type="email" autocomplete="email" value="">
        </label>
        <label for="sign-up-password">Password
          <input id="sign-up-password" name="password" type="password" autocomplete="new-password" value="">
        </label>
        <button id="sign-up-submit" class="button button-primary" type="submit">Create account</button>
      </form>`,
    aside: `
      <h2>Runner path</h2>
      <ul>
        <li>Fill the visible fields directly.</li>
        <li>Type the final password through the same CDP session.</li>
        <li>Submit and hand off to login immediately.</li>
      </ul>`,
  });
}

function renderLoginPage({ message = "" } = {}) {
  return htmlDocument({
    title: "Log in | Chrome Auth Demo Service",
    eyebrow: "Log in",
    heading: "Use the same credentials to complete the loop.",
    body: `
      <p>The demo closes the auth loop by logging back in with the account created one step earlier, then waiting for the signed-in state.</p>
      ${message ? `<div class="banner banner-success">${message}</div>` : ""}
      <form method="post" action="/log-in">
        <label for="log-in-email">Email
          <input id="log-in-email" name="email" type="email" autocomplete="email" value="">
        </label>
        <label for="log-in-password">Password
          <input id="log-in-password" name="password" type="password" autocomplete="current-password" value="">
        </label>
        <button id="log-in-submit" class="button button-primary" type="submit">Log in</button>
      </form>`,
    aside: `
      <h2>Runner path</h2>
      <ul>
        <li>Wait for the login screen explicitly.</li>
        <li>Fill both fields in the same managed browser session.</li>
        <li>Submit and verify the dashboard state.</li>
      </ul>`,
  });
}

function renderDashboardPage(name, email) {
  return htmlDocument({
    title: "Dashboard | Chrome Auth Demo Service",
    eyebrow: "Signed in",
    heading: `Welcome back, ${name}.`,
    body: `
      <p id="dashboard-status">The account is active. This is the success state the runner waits for before ending the demo.</p>
      <div class="status-grid">
        <section class="status-card">
          <small>Account owner</small>
          <strong>${name}</strong>
          <p>${email}</p>
        </section>
        <section class="status-card">
          <small>Auth state</small>
          <strong>Signed in</strong>
          <p>Ready for downstream agent work that depends on a live authenticated session.</p>
        </section>
      </div>`,
    aside: `
      <h2>Why this matters</h2>
      <ul>
        <li>The login state now lives in the same managed browser the next step can reuse.</li>
        <li>The user sees the full auth loop finish cleanly.</li>
      </ul>`,
  });
}

async function startAuthFixtureServer() {
  const users = new Map();
  const sessions = new Map();
  const sockets = new Set();

  function getCurrentUser(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    const sessionId = cookies.demo_session || "";
    const email = sessions.get(sessionId);
    if (!email) {
      return null;
    }
    return users.get(email) || null;
  }

  function sendHtml(res, html) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }

  function redirect(res, location, cookies = []) {
    const headers = { location };
    if (cookies.length > 0) {
      headers["set-cookie"] = cookies;
    }
    res.writeHead(303, headers);
    res.end("");
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const currentUser = getCurrentUser(req);

      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, renderHomePage());
        return;
      }

      if (req.method === "GET" && url.pathname === "/plans") {
        sendHtml(res, renderPlansPage());
        return;
      }

      if (req.method === "GET" && url.pathname === "/sign-up") {
        sendHtml(res, renderSignUpPage());
        return;
      }

      if (req.method === "POST" && url.pathname === "/sign-up") {
        const form = await readFormBody(req);
        const email = String(form.email || "").trim().toLowerCase();
        users.set(email, {
          name: String(form.name || "").trim(),
          email,
          password: String(form.password || ""),
          verified: true,
        });
        redirect(res, "/log-in?registered=1");
        return;
      }

      if (req.method === "GET" && url.pathname === "/log-in") {
        sendHtml(res, renderLoginPage({
          message: url.searchParams.get("registered") === "1" ? "Account created. Log in with the same credentials to finish the auth loop." : "",
        }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/log-in") {
        const form = await readFormBody(req);
        const email = String(form.email || "").trim().toLowerCase();
        const password = String(form.password || "");
        const user = users.get(email);
        if (!user || user.password !== password || !user.verified) {
          redirect(res, "/log-in");
          return;
        }
        const sessionId = randomUUID();
        sessions.set(sessionId, user.email);
        redirect(res, "/dashboard", [
          `demo_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
        ]);
        return;
      }

      if (req.method === "GET" && url.pathname === "/dashboard") {
        if (!currentUser) {
          redirect(res, "/log-in");
          return;
        }
        sendHtml(res, renderDashboardPage(currentUser.name, currentUser.email));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      res.writeHead(500);
      res.end(error?.message || "Internal server error");
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine auth fixture server address.");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function resolveBrowserWsUrl(debugUrl) {
  const version = await fetchJson(`${debugUrl}/json/version`);
  const browserWsUrl = version?.webSocketDebuggerUrl || "";
  if (!browserWsUrl) {
    throw new Error(`No browser websocket is available at ${debugUrl}.`);
  }
  return browserWsUrl;
}

async function openExtraTab(debugUrl, targetUrl) {
  const browserWsUrl = await resolveBrowserWsUrl(debugUrl);
  const session = createProtocolSession(browserWsUrl);
  await session.waitOpen();
  try {
    const result = await session.send("Target.createTarget", { url: targetUrl });
    return result?.targetId || null;
  } finally {
    session.close();
  }
}

async function closeTarget(debugUrl, targetId) {
  if (!targetId) {
    return;
  }
  const browserWsUrl = await resolveBrowserWsUrl(debugUrl);
  const session = createProtocolSession(browserWsUrl);
  await session.waitOpen();
  try {
    await session.send("Target.closeTarget", { targetId });
  } finally {
    session.close();
  }
}

async function getPageTarget(debugUrl, pageId) {
  const list = await fetchJson(`${debugUrl}/json/list`);
  const pages = Array.isArray(list) ? list.filter((item) => item?.type === "page") : [];
  if (pageId) {
    return pages.find((item) => item?.id === pageId) || null;
  }
  return pages[pages.length - 1] || null;
}

async function withPageSession(debugUrl, pageId, fn) {
  const page = await getPageTarget(debugUrl, pageId);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`Could not find page target '${pageId}'.`);
  }
  const session = createProtocolSession(page.webSocketDebuggerUrl);
  await session.waitOpen();
  try {
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("DOM.enable");
    return await fn(session, page);
  } finally {
    session.close();
  }
}

async function evaluateOnPage(debugUrl, pageId, expression) {
  return withPageSession(debugUrl, pageId, async (session) => {
    const result = await session.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result?.result?.value ?? null;
  });
}

async function findPageByNormalizedUrl(debugUrl, targetUrl) {
  const list = await fetchJson(`${debugUrl}/json/list`);
  const normalizedTarget = normalizeUrl(targetUrl);
  const page = Array.isArray(list)
    ? list.find((item) => item?.type === "page" && normalizeUrl(item?.url || "") === normalizedTarget) || null
    : null;
  return page;
}

function buildOverlayExpression(selector, label, { accent = "#ff453a", cursor = true } = {}) {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const accent = ${JSON.stringify(accent)};
    const label = ${JSON.stringify(label || "")};
    const target = document.querySelector(selector);
    if (!target) {
      return { ok: false, reason: "not_found", selector };
    }
    target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = target.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 1280;
    const rootId = "__chrome_use_demo_overlay__";
    document.getElementById(rootId)?.remove();
    const root = document.createElement("div");
    root.id = rootId;
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483647";
    root.style.pointerEvents = "none";
    const box = document.createElement("div");
    box.style.position = "fixed";
    box.style.left = rect.left - 6 + "px";
    box.style.top = rect.top - 6 + "px";
    box.style.width = rect.width + 12 + "px";
    box.style.height = rect.height + 12 + "px";
    box.style.borderRadius = "22px";
    box.style.border = "4px solid " + accent;
    box.style.boxShadow = "0 0 0 10px rgba(255, 69, 58, 0.14)";
    box.style.background = "rgba(255,255,255,0.02)";
    root.appendChild(box);
    const badge = document.createElement("div");
    badge.textContent = label;
    badge.style.position = "fixed";
    badge.style.left = Math.min(Math.max(20, rect.left), Math.max(20, viewportWidth - 220)) + "px";
    badge.style.top = Math.max(18, rect.top - 42) + "px";
    badge.style.padding = "8px 12px";
    badge.style.borderRadius = "999px";
    badge.style.background = accent;
    badge.style.color = "#fff";
    badge.style.font = "700 13px Avenir Next, Segoe UI, sans-serif";
    badge.style.boxShadow = "0 10px 24px rgba(255, 69, 58, 0.28)";
    root.appendChild(badge);
    if (${cursor}) {
      const cursorEl = document.createElement("div");
      cursorEl.style.position = "fixed";
      cursorEl.style.left = rect.left + rect.width * 0.78 + "px";
      cursorEl.style.top = rect.top + rect.height * 0.55 + "px";
      cursorEl.style.width = "28px";
      cursorEl.style.height = "28px";
      cursorEl.style.borderRadius = "999px";
      cursorEl.style.background = accent;
      cursorEl.style.border = "3px solid #ffffff";
      cursorEl.style.boxShadow = "0 10px 24px rgba(255, 69, 58, 0.35)";
      root.appendChild(cursorEl);
    }
    document.documentElement.appendChild(root);
    return {
      ok: true,
      selector,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height
    };
  })()`;
}

async function highlightSelector(debugUrl, pageId, selector, label) {
  const result = await evaluateOnPage(debugUrl, pageId, buildOverlayExpression(selector, label));
  assertCondition(result?.ok, `Could not highlight selector ${selector}.`, result);
  await delay(140);
  return result;
}

async function clearOverlay(debugUrl, pageId) {
  await evaluateOnPage(debugUrl, pageId, `(() => {
    document.getElementById("__chrome_use_demo_overlay__")?.remove();
    return true;
  })()`);
}

async function capturePageScreenshot(debugUrl, pageId, outputPath) {
  await withPageSession(debugUrl, pageId, async (session) => {
    const screenshot = await session.send("Page.captureScreenshot", { format: "png" });
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  });
}

async function captureStep(debugUrl, pageId, outputDir, name, selector = null, label = "") {
  if (selector) {
    await highlightSelector(debugUrl, pageId, selector, label);
  }
  const screenshotPath = path.join(outputDir, `${name}.png`);
  await capturePageScreenshot(debugUrl, pageId, screenshotPath);
  if (selector) {
    await clearOverlay(debugUrl, pageId);
  }
  return screenshotPath;
}

async function waitForPageText(debugUrl, pageId, text, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await evaluateOnPage(debugUrl, pageId, `(() => ({
      found: (document.body?.innerText || document.body?.textContent || "").includes(${JSON.stringify(text)}),
      url: location.href,
      title: document.title || "",
      readyState: document.readyState
    }))()`);
    if (value?.found) {
      return value;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for text '${text}' on page ${pageId}.`);
}

async function clickPageSelector(debugUrl, pageId, selector) {
  const result = await evaluateOnPage(debugUrl, pageId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) {
      return { clicked: false, reason: "not_found" };
    }
    if (typeof element.focus === "function") {
      element.focus();
    }
    if (typeof element.click === "function") {
      element.click();
    }
    return { clicked: true };
  })()`);
  assertCondition(result?.clicked, `Failed to click selector ${selector}.`, result);
  await delay(120);
}

async function assertDedicatedProfile(debugUrl) {
  assertCondition(debugUrl === canonicalDebugUrl, `Expected canonical debug URL ${canonicalDebugUrl}, got ${debugUrl}.`);
  const doctor = runShellScript(path.join(__dirname, "doctor.sh"));
  assertCondition(doctor.includes("Profile root:"), "Doctor did not report the Chrome profile root.", doctor);
  assertCondition(doctor.includes("Debug URL: http://127.0.0.1:9223"), "Doctor did not report the canonical debug URL.", doctor);
  assertCondition(doctor.includes("Endpoint: ready"), "Doctor did not report a ready debug endpoint.", doctor);
  assertCondition(doctor.includes("Chrome PID count: 1"), "Doctor did not report a single Chrome owner.", doctor);
  assertCondition(doctor.includes("Page target count:"), "Doctor did not report page target diagnostics.", doctor);
  assertCondition(doctor.includes("Status: Google Chrome default profile is ready"), "Doctor did not report a ready Chrome profile.", doctor);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const outputDir = flags["output-dir"]
    ? path.resolve(String(flags["output-dir"]))
    : await mkdtemp(path.join(os.tmpdir(), "chrome-auth-visual-"));
  await mkdir(outputDir, { recursive: true });

  const fixtureServer = await startAuthFixtureServer();
  const homeUrl = `${fixtureServer.origin}/`;
  const plansUrl = `${fixtureServer.origin}/plans`;

  const summary = {
    ok: false,
    fixtureOrigin: fixtureServer.origin,
    outputDir,
    identity: demoIdentity,
    steps: [],
    screenshots: [],
  };

  let debugUrl = "";
  let homePageId = null;
  let plansPageId = null;

  try {
    logStep(`Auth fixture server: ${fixtureServer.origin}`);
    debugUrl = runShellScript(authOpenUrlScript, [homeUrl]);
    summary.debugUrl = debugUrl;
    logStep(`Debug URL: ${debugUrl}`);

    await assertDedicatedProfile(debugUrl);
    await delay(800);

    plansPageId = await openExtraTab(debugUrl, plansUrl);
    summary.steps.push({ step: "open-plans-tab", result: { targetId: plansPageId } });
    await delay(600);

    const status = runAuthJson(["status", "--browser-url", debugUrl]);
    const listedPages = runAuthJson(["list-pages", "--browser-url", debugUrl]);
    summary.steps.push({ step: "status", result: status });
    summary.steps.push({ step: "list-pages", result: listedPages });
    assertCondition(status.pageCount >= 2, "Expected at least two pages after opening the plans tab.", status);
    assertCondition(listedPages.pageCount >= 2, "Expected list-pages to report multiple tabs.", listedPages);

    const homePage = listedPages.pages.find((page) => normalizeUrl(page.url) === normalizeUrl(homeUrl));
    assertCondition(Boolean(homePage?.id), "Could not find the home page in list-pages output.", listedPages);
    homePageId = homePage.id;
    const selectHome = runAuthJson(["select-page", "--browser-url", debugUrl, "--page-id", homePageId]);
    summary.steps.push({ step: "select-home-page", result: selectHome });

    const signUpEntry = runAuthJson(["find", "--browser-url", debugUrl, "--selector", "#sign-up-link"]);
    const logInEntry = runAuthJson(["find", "--browser-url", debugUrl, "--selector", "#log-in-link"]);
    const homeSnapshot = runAuthJson(["snapshot", "--browser-url", debugUrl, "--mode", "a11y"]);
    summary.steps.push({ step: "home-find-sign-up", result: signUpEntry });
    summary.steps.push({ step: "home-find-log-in", result: logInEntry });
    summary.steps.push({ step: "home-snapshot-a11y", result: homeSnapshot });
    assertCondition(signUpEntry?.found && logInEntry?.found, "Expected both sign-up and log-in entry points on the home page.");
    summary.screenshots.push({
      name: "01-home-sign-up-highlight",
      path: await captureStep(debugUrl, homePageId, outputDir, "01-home-sign-up-highlight", "#sign-up-link", "Click `Sign up`"),
    });

    logStep("Clicking the sign-up entry point");
    await clickPageSelector(debugUrl, homePageId, "#sign-up-link");
    const signUpReady = runAuthJson(["wait-for", "--browser-url", debugUrl, "--text", "Create the account the agent will use next.", "--timeout-ms", "6000"]);
    summary.steps.push({ step: "click-sign-up", result: { clicked: true, selector: "#sign-up-link" } });
    summary.steps.push({ step: "wait-for-sign-up", result: signUpReady });
    assertCondition(signUpReady?.found, "Expected to reach the sign-up page.", signUpReady);

    logStep("Typing the sign-up form");
    runAuthJson(["type", "--browser-url", debugUrl, "--selector", "#sign-up-name", "--text", demoIdentity.name]);
    runAuthJson(["type", "--browser-url", debugUrl, "--selector", "#sign-up-email", "--text", demoIdentity.email]);
    runAuthJson(["type", "--browser-url", debugUrl, "--selector", "#sign-up-password", "--text", demoIdentity.password]);
    const signUpFieldClick = runAuthJson(["click", "--browser-url", debugUrl, "--selector", "#sign-up-password"]);
    summary.steps.push({ step: "type-sign-up-form", result: { name: demoIdentity.name, email: demoIdentity.email } });
    summary.steps.push({ step: "click-sign-up-password", result: signUpFieldClick });
    summary.screenshots.push({
      name: "02-sign-up-submit-highlight",
      path: await captureStep(debugUrl, homePageId, outputDir, "02-sign-up-submit-highlight", "#sign-up-submit", "Submit the new account"),
    });

    logStep("Submitting the new account");
    await clickPageSelector(debugUrl, homePageId, "#sign-up-submit");
    const loginReady = runAuthJson(["wait-for", "--browser-url", debugUrl, "--text", "Use the same credentials to complete the loop.", "--timeout-ms", "6000"]);
    summary.steps.push({ step: "submit-sign-up", result: { clicked: true, selector: "#sign-up-submit" } });
    summary.steps.push({ step: "wait-for-login", result: loginReady });
    assertCondition(loginReady?.found, "Expected to reach the log-in page after sign-up.", loginReady);

    logStep("Typing the log-in form");
    runAuthJson(["fill", "--browser-url", debugUrl, "--selector", "#log-in-email", "--text", demoIdentity.email]);
    runAuthJson(["type", "--browser-url", debugUrl, "--selector", "#log-in-password", "--text", demoIdentity.password]);
    const loginFieldClick = runAuthJson(["click", "--browser-url", debugUrl, "--selector", "#log-in-password"]);
    summary.steps.push({ step: "type-log-in-form", result: { email: demoIdentity.email } });
    summary.steps.push({ step: "click-log-in-password", result: loginFieldClick });
    summary.screenshots.push({
      name: "03-log-in-submit-highlight",
      path: await captureStep(debugUrl, homePageId, outputDir, "03-log-in-submit-highlight", "#log-in-submit", "Log in with the same account"),
    });

    logStep("Submitting the log-in form");
    await clickPageSelector(debugUrl, homePageId, "#log-in-submit");
    const dashboardReady = await waitForPageText(debugUrl, homePageId, `Welcome back, ${demoIdentity.name}.`, 6000);
    summary.steps.push({ step: "submit-log-in", result: { clicked: true, selector: "#log-in-submit" } });
    summary.steps.push({ step: "wait-for-dashboard", result: dashboardReady });
    summary.screenshots.push({
      name: "04-dashboard-success",
      path: await captureStep(debugUrl, homePageId, outputDir, "04-dashboard-success", "#dashboard-status", "Auth complete"),
    });

    const summaryPath = path.join(outputDir, "auth-visual-summary.json");
    summary.ok = true;
    summary.summaryPath = summaryPath;
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputDir,
      summaryPath,
      fixtureOrigin: fixtureServer.origin,
      screenshots: summary.screenshots,
    }, null, 2)}\n`);
  } finally {
    try {
      await closeTarget(debugUrl, plansPageId);
      await closeTarget(debugUrl, homePageId);
    } catch {
      // Ignore target cleanup failures.
    }
    await fixtureServer.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  if (error?.details) {
    process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  }
  process.exit(1);
});
