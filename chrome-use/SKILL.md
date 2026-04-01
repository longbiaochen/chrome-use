---
name: "chrome-use"
description: "Shared base package for explicit Chrome workflow commands and reusable DevTools MCP runtime helpers."
---

# Chrome Use (shared base package)

`chrome-use` is a shared helper package for explicit command SKILLs:

- `chrome-inspect`
- `chrome-auth`

It is intentionally not a standalone slash command and is not directly invokable.

## Use cases for the shared runtime

- Reused authenticated browser state and cookie persistence
- Deterministic Chrome profile handling
- Debug endpoint ownership verification
- Single-window validation for the dedicated profile on macOS
- Consistent startup URL resolution and MCP launch plumbing

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

## Scripted stack

- `scripts/ensure_profile.sh`
  Enforces the dedicated-profile runtime contract, launches Chrome when absent,
  reuses the running dedicated instance by opening a new tab there, and prints the debug URL.
- `scripts/doctor.sh`
  Reports dedicated-profile process count, endpoint ownership, and single-window status.
- `scripts/open_url.sh [url]`
  Resolves startup URL in this priority:
  - explicit user URL
  - `CHROME_USE_DEFAULT_WEBAPP_URL`
  - `about:blank`
  then ensures the URL is opened in the dedicated-profile Chrome instance.
- `scripts/chrome_devtools_mcp_wrapper.sh`
  Launches MCP against the validated debug endpoint.
- `scripts/cleanup.sh`
  Removes stale helper logs.

## Startup resolution details

- `scripts/resolve_startup_url.sh` returns:
  1. explicit user URL
  2. `CHROME_USE_DEFAULT_WEBAPP_URL` when set
  3. `about:blank`

## Client notes

- For Codex, optional metadata is available in `agents/openai.yaml`.
- For cross-client installs, use command directories:
  - `.agents/skills/chrome-inspect/`
  - `.agents/skills/chrome-auth/`

## Platform notes

- macOS is the reference platform.
- macOS validation requires exactly one Chrome window for the dedicated `agent-profile`;
  other Chrome windows under other profiles are allowed.
- Linux is supported by the shell scripts.
- Windows is not yet tested; if you need Windows support, treat it as planned rather than guaranteed.
