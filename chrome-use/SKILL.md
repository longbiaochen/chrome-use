---
name: "chrome-use"
description: "Use when a task needs Chrome DevTools MCP with a persistent dedicated Chrome profile, readiness checks, and explicit mismatch detection. Best tested with Codex, but packaged as a portable SKILL.md skill."
---

# Chrome Use

Use this skill when an agent needs a repeatable Chrome DevTools MCP workflow with persistent browser state.

## Use cases

- authenticated product admin work in Chrome
- browser validation that must reuse cookies, storage, or bookmarks
- DOM, console, network, and screenshot work through a stable browser session
- preventing accidental attachment to the wrong Chrome process

## Rules

- Use a dedicated Chrome profile for agent-driven DevTools MCP work.
- Reuse the same dedicated profile across sessions when persistent state matters.
- Treat a mismatched debug endpoint as a blocker.
- Do not silently fall back to the browser's default profile if the dedicated profile is required.

## Defaults

- Profile dir: `~/.chrome-use/agent-profile`
- State dir: `~/.chrome-use/state`
- Debug URL: `http://127.0.0.1:9223`
- MCP server: official `chrome-devtools-mcp`

These can be overridden with:

- `CHROME_USE_PROFILE_DIR`
- `CHROME_USE_STATE_DIR`
- `CHROME_USE_DEBUG_HOST`
- `CHROME_USE_DEBUG_PORT`
- `CHROME_USE_CHROME_BIN`
- `CHROME_USE_CHROME_APP`

## Workflow

1. Run `scripts/ensure_profile.sh` to start or reuse the dedicated Chrome profile.
2. If needed, log into the target site in that dedicated browser window.
3. Run `scripts/doctor.sh` to verify the endpoint belongs to the expected profile.
4. Use the `chrome-devtools` MCP tools through the wrapper or your client's MCP config.

## Scripts

- `scripts/ensure_profile.sh`
  Starts or reuses the dedicated profile and prints the debug URL.
- `scripts/doctor.sh`
  Reports readiness, matching PID information, and mismatch blockers.
- `scripts/open_url.sh [url]`
  Opens a URL in the dedicated profile.
- `scripts/chrome_devtools_mcp_wrapper.sh`
  Launches the official `chrome-devtools-mcp` server against the validated browser endpoint.
- `scripts/cleanup.sh`
  Removes stale helper logs.

## Client notes

- For Codex, optional metadata is available in `agents/openai.yaml`.
- For cross-client installs, prefer `.agents/skills/chrome-use/`.
- Client-native install paths may also work, but are secondary to the neutral `.agents/skills/` layout.

## Platform notes

- macOS is the reference platform.
- Linux is supported by the shell scripts.
- Windows is not yet tested; if you need Windows support, treat it as planned rather than guaranteed.
