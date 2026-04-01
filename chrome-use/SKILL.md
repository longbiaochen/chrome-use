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
- On macOS, launch or reuse Chrome in the background so DevTools MCP work does not steal focus from the user.
- Expose selection-inspection tooling when element inspection workflows need selected-DOM context.

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
5. For selected-element workflows, start wrapper in inspect mode so `/inspect` can be resolved to `inspect(action='capture')`; then call `inspect` or `inspect_selected_element` after Chrome "Inspect" on a node.

## Scripts

- `scripts/ensure_profile.sh`
  Starts or reuses the dedicated profile and prints the debug URL.
- `scripts/doctor.sh`
  Reports readiness, matching PID information, and mismatch blockers.
- `scripts/open_url.sh [url]`
  Opens a URL in the dedicated profile.
- `scripts/chrome_devtools_mcp_wrapper.sh`
  Launches the official `chrome-devtools-mcp` server against the validated browser endpoint.
  - Inspect entry:
    - `bash chrome-use/scripts/chrome_devtools_mcp_wrapper.sh inspect`
    - `bash chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh`
- In inspect mode (`CHROME_USE_MCP_MODE=inspect`), the wrapper launches a compatibility bridge that preserves upstream tools and adds:
  - `inspect_selected_element`
  - `inspect` (stateful workflow helper)
- `scripts/cleanup.sh`
  Removes stale helper logs.

## inspect_selected_element

- Returns selected-element context:
  - `selectedElement`: `backendNodeId`, `nodeName`, `id`, `className`, `ariaLabel`, `descriptionText`, `selectorHint`, `snippet`
  - `position`: `x`, `y`, `width`, `height`, `quads`
  - `page`: `title`, `url`, `pageId`, `frameId`
- Tool parameters:
  - `waitForSelectionMs` (default 5000, minimum 500)
  - `timeoutMs` (default 10000)

## Behavior notes

- The tool first listens to `Overlay.inspectNodeRequested` in the active DevTools session.
- If no event is captured in `waitForSelectionMs`, it falls back to short-interval polling of page active element state within `timeoutMs`.
- On timeout, it returns an error with explicit `"timeout"` context and the last observed bridge error if available.

## inspect

- A stateful interaction wrapper around selected-element inspection.
- `/inspect` is handled by this skill by default with implicit invocation enabled. If the request appears to do selected-element work, call `inspect(action='capture')` first.
- Phases:
  - `capture`: waits for selection and returns `selectedElement/position/page` plus `summary`, `workflowId`，`phase=awaiting_user_instruction`。
  - `apply_instruction`: accepts the user's modification instruction for the same workflow and returns `ready_to_apply` payload.
- Codex one-shot flow:
- `/inspect` -> `inspect(action='capture')`
  - show `summary` and ask for one concrete DOM modification instruction
  - `inspect(action='apply_instruction', instruction='...')`
  - proceed with the returned `ready_to_apply` context in your mutation tools.
- Recommended flow in Codex:
  - Call `inspect(action='capture')`.
  - If `phase=awaiting_user_instruction`, show summary to user and ask for exact DOM modification instruction.
  - Call `inspect(action='apply_instruction', instruction='...')` with same session intent.
  - Use normal Codex mutation tools to apply the instruction in your editing flow.
- Input schema:
  - `action` (`capture` | `apply_instruction`, default `capture`)
  - `waitForSelectionMs` (default 5000, min 500)
  - `timeoutMs` (default 10000)
  - `instruction` (required when `action=apply_instruction`)
- Returns:
  - `phase`
  - `workflowId`
  - `selectedElement`
  - `position`
  - `page`
  - `summary`
  - `userInstruction` when applied

## Client notes

- For Codex, optional metadata is available in `agents/openai.yaml`.
- For cross-client installs, prefer `.agents/skills/chrome-use/`.
- Client-native install paths may also work, but are secondary to the neutral `.agents/skills/` layout.

## Platform notes

- macOS is the reference platform.
- Linux is supported by the shell scripts.
- Windows is not yet tested; if you need Windows support, treat it as planned rather than guaranteed.
