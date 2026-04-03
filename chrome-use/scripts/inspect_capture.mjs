#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeInspectRuntime,
  connectInspectRuntime,
  createInspectStore,
  getDefaultDebugUrl,
  handleInspectAction,
  toCliSelectionPayload,
} from "./chrome_devtools_inspect_mcp.mjs";

function printUsage() {
  console.error(`Usage:
  inspect-capture begin --project-root <path> [--url <url>]
  inspect-capture await --workflow-id <id> [--timeout-ms <ms>]
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

function resolveSessionStartupUrl(debugUrl) {
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
  if (!["begin", "await", "apply", "once"].includes(command)) {
    throw new Error(`Unsupported inspect-capture subcommand: ${command}`);
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  ensureCommandRequirements(command, flags);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = typeof flags["project-root"] === "string" ? flags["project-root"] : "";
  const explicitUrl = typeof flags.url === "string" ? flags.url : "";
  const timeoutMs =
    typeof flags["timeout-ms"] === "string" ? Number.parseInt(flags["timeout-ms"], 10) : 0;

  let startupUrl = explicitUrl;
  let debugUrl = getDefaultDebugUrl();

  if (command === "begin" || command === "once") {
    const resolved = resolveAndOpenTarget({ scriptDir, projectRoot, explicitUrl });
    startupUrl = resolved.startupUrl;
    debugUrl = resolved.debugUrl || debugUrl;
  } else {
    startupUrl = explicitUrl || resolveSessionStartupUrl(debugUrl);
  }

  let runtime = null;
  try {
    runtime = await connectInspectRuntime({ debugUrl, startupUrl });
    const { cdp, state } = runtime;

    if (command === "begin") {
      const result = await handleInspectAction(cdp, state, { action: "begin_capture" }, 1);
      process.stdout.write(`${JSON.stringify({
        workflowId: result.workflowId,
        status: result.status,
        phase: result.phase,
        url: startupUrl || null,
      })}\n`);
      return;
    }

    if (command === "await") {
      const result = await handleInspectAction(
        cdp,
        state,
        {
          action: "await_selection",
          workflowId: flags["workflow-id"],
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 0,
          waitForSelectionMs: 500,
        },
        2,
      );
      process.stdout.write(`${JSON.stringify(toCliSelectionPayload(result))}\n`);
      return;
    }

    if (command === "apply") {
      const result = await handleInspectAction(
        cdp,
        state,
        {
          action: "apply_instruction",
          workflowId: flags["workflow-id"],
          instruction: flags.instruction,
        },
        3,
      );
      process.stdout.write(`${JSON.stringify({
        workflowId: result.workflowId,
        phase: result.phase,
        userInstruction: result.userInstruction || flags.instruction,
      })}\n`);
      return;
    }

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
    if (runtime) {
      await closeInspectRuntime(runtime.cdp, runtime.state);
    }
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
