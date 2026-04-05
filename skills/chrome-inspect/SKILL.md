---
name: "chrome-inspect"
description: "Capture selected DOM elements in a dedicated Chrome profile and prepare mutation-ready inspection context."
---

# Chrome Inspect Skill

Use this skill when an agent needs deterministic, inspect-first Chrome DOM work in a dedicated profile. It is designed to trigger both explicitly and implicitly for browser QA, DOM inspection, selected-element capture, and mutation-ready page context.

## Workflow

1. Resolve startup URL in this priority:
  - Explicit user URL
  - Detected docs webapp entry from `CHROME_INSPECT_PROJECT_ROOT`
  - `CHROME_USE_DEFAULT_WEBAPP_URL`
  - `about:blank`
2. Start local docs web server (for local docs URLs) before opening Chrome when documented. The command wrapper should do this automatically for the detected project webapp entry.
3. Start or reuse Chrome with the resolved URL through `bash scripts/open_url.sh "<resolved_url>"`.
   Reuse must open a new tab on the running dedicated-profile instance instead of creating a second dedicated window.
4. Use the direct-CDP inspect CLI for selection capture by default:
   - `scripts/inspect-capture begin --project-root "<repo>"`
   - `scripts/inspect-capture await --workflow-id "<workflowId>"`
   - or the one-shot path: `scripts/inspect_select_element.sh "<repo>"`
5. Ensure the session is attached to the dedicated debug endpoint and that the dedicated profile still has exactly one Chrome window.
6. The direct inspect runtime should pass the startup URL into the shared runtime so capture prioritizes the freshly opened target instead of attaching unrelated tabs on the same debug endpoint.
7. Confirm inspect mode is armed, then have the user use the persistent page toolbar to stay in `Inspect` mode or `Exit`, click an element in Chrome, and wait for `await` or `once` to return the normalized selection JSON.
8. Treat the selection as valid only if it is clearly for the current `workflowId` and follows a fresh operator click for this capture cycle.
   If `await_selection` appears to return immediately with stale prior context, or the durable files only show an older `updatedAt` / `payload.observedAt`, do not present it as the new selection. Restart capture or create a fresh workflow and retry.
9. Do not return a final response, a completion summary, or a "Worked for ..." timeout-style message before receiving a fresh `phase=awaiting_user_instruction` or equivalent fresh `selection_received` payload for the current capture cycle.
10. If a fresh selection is present, report the selected element with enough detail for the operator to identify and modify it without another lookup.
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
12. Re-run the same workflow with `scripts/inspect-capture apply --workflow-id "<workflowId>" --instruction "<user text>"`.

## Tools

### `scripts/open_url.sh`
Starts or reuses dedicated Chrome, enforces the single-window dedicated-profile invariant, and prints the active debug URL.

### `scripts/inspect-capture`
Runs direct-CDP element capture against the dedicated Chrome debug endpoint without requiring a manual MCP handshake.

### `scripts/inspect_select_element.sh`
One-shot helper that opens or reuses the repo preview, arms capture, waits for a fresh click, and prints normalized JSON.

## Fast path

Preferred two-command flow:

```bash
bash scripts/open_url.sh "http://127.0.0.1:8000/"
scripts/inspect-capture begin --project-root "/path/to/repo"
scripts/inspect-capture await --workflow-id "<workflowId>"
```

Preferred one-shot flow:

```bash
scripts/inspect_select_element.sh "/path/to/repo"
```

Expected result:
- JSON on stdout with `workflowId`, `observedAt`, `summary`, `page`, `selectedElement`, and `position`
- no manual bridge handshake
- no repo-wide discovery step when `project_webapp_entry.sh` already resolves the preview URL

## Notes

- Keep the same dedicated profile across sessions with `CHROME_USE_PROFILE_DIR`.
- Keep the dedicated `agent-profile` isolated to one Chrome window; other Chrome profile windows may exist separately.
- For explicit mismatches between expected profile/debug endpoint, run `../../../runtime/chrome-use/scripts/doctor.sh` from this skill's `scripts/` directory, or `runtime/chrome-use/scripts/doctor.sh` from the repo root.
- `about:blank` is the fallback when no URL is supplied.
- If `await_selection` resolves suspiciously fast without an obvious new click for the current capture cycle, or the current-selection file still carries an older timestamp, treat it as stale context and restart capture instead of showing it as the fresh selection.
- Performance expectation: the direct runtime should prefer the startup target and avoid attaching unrelated tabs on the same debug endpoint. If logs show many `target_attached` events for unrelated pages, treat that as a regression.
