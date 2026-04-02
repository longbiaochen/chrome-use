---
name: "chrome-inspect"
description: "Capture selected DOM elements in a dedicated Chrome profile and prepare mutation-ready inspection context."
---

# Chrome Inspect Skill

Use this skill when an agent needs deterministic, inspect-first Chrome DOM work in a dedicated profile.

## Workflow

1. Resolve startup URL in this priority:
  - Explicit user URL
  - Detected docs webapp entry from `CHROME_INSPECT_PROJECT_ROOT`
  - `CHROME_USE_DEFAULT_WEBAPP_URL`
  - `about:blank`
2. Start local docs web server (for local docs URLs) before opening Chrome when documented. The command wrapper should do this automatically for the detected project webapp entry.
3. Start or reuse Chrome with the resolved URL through `bash scripts/open_url.sh "<resolved_url>"`.
   Reuse must open a new tab on the running dedicated-profile instance instead of creating a second dedicated window.
4. Ensure the session is attached to the dedicated debug endpoint and that the dedicated profile still has exactly one Chrome window.
5. Run in inspect MCP mode and create a durable capture workflow with `inspect(action="begin_capture")`. This returns immediately with a `workflowId`.
6. If the current client cannot drive the inspect MCP handshake reliably, create the durable workflow first, then restart or attach the inspect bridge so it rehydrates `activeWorkflowId` from persisted state and arms inspect mode on the open page targets.
7. Confirm inspect mode is armed, then have the user select an element in Chrome and call `inspect(action="await_selection", workflowId="<workflowId>")`.
8. Treat the selection as valid only if it is clearly for the current `workflowId` and follows a fresh operator click for this capture cycle.
   If `await_selection` appears to return immediately with stale prior context, do not present it as the new selection. Restart capture or create a fresh workflow and retry.
9. Do not return a final response, a completion summary, or a "Worked for ..." timeout-style message before receiving `phase=awaiting_user_instruction` with the selected-element payload.
10. If `phase=awaiting_user_instruction`, report the selected element with enough detail for the operator to identify and modify it without another lookup.
   Include at least:
   - `summary`
   - the element tag / `nodeName`
   - `selectorHint`
   - `id`
   - `className`
   - `ariaLabel`
   - page `url`
   - `position`
   - the element content from `selectedElement.snippet` or equivalent captured text
11. After reporting that richer element context, ask one concrete DOM instruction.
12. Re-run the same workflow with `inspect(action="apply_instruction", workflowId="<workflowId>", instruction="<user text>")`.

## Tools

### `scripts/open_url.sh`
Starts or reuses dedicated Chrome, enforces the single-window dedicated-profile invariant, and prints the active debug URL.

### `scripts/../chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh`
Starts inspect-aware MCP bridge for `inspect_selected_element` and `inspect`.

## Notes

- Keep the same dedicated profile across sessions with `CHROME_USE_PROFILE_DIR`.
- Keep the dedicated `agent-profile` isolated to one Chrome window; other Chrome profile windows may exist separately.
- For explicit mismatches between expected profile/debug endpoint, run `scripts/../chrome-use/scripts/doctor.sh`.
- `about:blank` is the fallback when no URL is supplied.
- `inspect(action="capture")` still exists as a compatibility shortcut, but `begin_capture` then `await_selection` is the stable default flow.
- If the inspect bridge is attached but durable session state still shows `activeWorkflowId: null`, recover by creating a fresh workflow, then restart the inspect bridge so it rehydrates that workflow and arms inspect mode from persisted state.
- If `await_selection` resolves suspiciously fast without an obvious new click for the current capture cycle, treat it as stale context and restart capture instead of showing it as the fresh selection.
