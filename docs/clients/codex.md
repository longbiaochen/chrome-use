# Codex adapter notes

Codex supports the generic skill payload plus optional metadata in installed skill folders:

- `chrome-inspect`
- `chrome-auth`

Install options:

```bash
bash install/install-agent-skill.sh
```

or:

```bash
bash install/install-codex-skill.sh
```

This repo intentionally exposes only two explicit commands: `chrome-inspect` and `chrome-auth`.
`/chrome` and `/inspect` are not registered command selectors.
`/chrome-inspect` resolves startup URL in this order for inspect flow:

- explicit user URL
- `CHROME_INSPECT_PROJECT_ROOT` docs webapp entry
- `CHROME_USE_DEFAULT_WEBAPP_URL`
- `about:blank`

If you want Codex to use the same dedicated profile path as an existing local setup:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile"
```

Typical MCP wrapper command:

```bash
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile" \
  bash chrome-use/scripts/chrome_devtools_mcp_wrapper.sh
```

To enable the selected-element tool, start wrapper in inspect mode:

```bash
CHROME_USE_MCP_MODE=inspect \
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile" \
  bash chrome-use/scripts/chrome_devtools_mcp_wrapper.sh
```

or:

```bash
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile" \
  bash chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh
```

Recommended verification for explicit commands:

1. Reinstall/update skills:
   `bash install/install-codex-skill.sh`
2. Send `/chrome-inspect` in chat.
3. Chrome session is opened through the canonical inspect wrapper with the resolved startup URL, and the local project web app is auto-started first when `CHROME_INSPECT_PROJECT_ROOT` is configured.
   Reuse keeps the dedicated `agent-profile` on a single Chrome window and opens a new tab on that running instance.
4. The wrapper should pass the startup URL into the shared runtime so the inspect bridge can prioritize the freshly opened target instead of attaching unrelated tabs.
5. The client calls `inspect(action="begin_capture")` and stores `workflowId`.
6. If the client cannot drive the inspect MCP handshake reliably, it recreates or pre-creates the durable workflow, then restarts or attaches the inspect bridge so it rehydrates `activeWorkflowId` and arms inspect mode.
7. In Chrome, click the target element only after inspect mode is armed.
8. The client calls `inspect(action="await_selection", workflowId="<workflowId>")`.
9. Treat the result as valid only if it belongs to the current `workflowId` and follows a fresh click for the current capture cycle.
   If `await_selection` appears to return immediately with stale prior context, restart capture instead of presenting it as the new selection.
10. Confirm the agent does not conclude the turn before the tool returns `phase=awaiting_user_instruction`.
11. Confirm the agent reports enough selected-element detail after `phase=awaiting_user_instruction`:
   `summary`, `workflowId`, tag / `selectedElement.nodeName`, `selectedElement.selectorHint`,
   `selectedElement.id`, `selectedElement.className`, `selectedElement.ariaLabel`, page URL,
   `position`, and the element content from `selectedElement.snippet` or equivalent captured text.
12. Reply with a concrete edit instruction.
13. Confirm returned `phase=ready_to_apply`.
14. If the inspect bridge is attached but durable state still shows `activeWorkflowId: null`, recover by creating a fresh workflow and restarting the inspect bridge.

For `/chrome-auth`, send the explicit auth URL and then step through login/authorization actions while keeping the same dedicated profile, debug endpoint, and single dedicated Chrome window.

Available tools:

- `inspect_selected_element`
  - `waitForSelectionMs` (default `5000`, min `500`)
  - `timeoutMs` (default `10000`)
  - returns selected element description, geometry, page context
- `inspect`
  - `action` (`begin_capture` | `await_selection` | `get_status` | `capture` | `apply_instruction`, default `capture`)
  - `workflowId` (required for `await_selection`, `get_status`, and recommended for `apply_instruction`)
  - `instruction` (required for `apply_instruction`)
  - `waitForSelectionMs` (default `5000`, min `500`)
  - `timeoutMs` (`0` blocks until user selection, default `0`)
  - returns `phase`, `workflowId`, `selectedElement`, `position`, `page`, `summary`, `userInstruction`
  - recommended stable flow is `begin_capture` then `await_selection`; `capture` is a compatibility shortcut
