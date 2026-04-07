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
  - Detected docs webapp entry from the current repo when inspect auto-start is enabled and the working directory or git root looks like a local project
  - `CHROME_USE_DEFAULT_WEBAPP_URL`
  - `about:blank`
2. Never skip repo detection just because the user omitted a URL. If the request is about the current local project, treat the repo as the source of truth and let the shared runtime infer the preview entry before falling back to `about:blank`.
3. Start local docs web server (for local docs URLs) before opening Chrome when documented. The command wrapper should do this automatically for the detected project webapp entry.
4. Start or reuse Chrome with the resolved URL through `bash scripts/open_url.sh "<resolved_url>"`.
   Reuse must open a new tab on the running dedicated-profile instance instead of creating a second dedicated window.
5. Use the direct-CDP inspect CLI for selection capture by default:
   - `scripts/inspect-capture begin --project-root "<repo>"`
   - `scripts/inspect-capture await --workflow-id "<workflowId>"`
   - or the one-shot path: `scripts/inspect_select_element.sh "<repo>"`
6. Ensure the session is attached to the dedicated debug endpoint and that the dedicated profile still has exactly one Chrome window.
7. The direct inspect runtime should pass the startup URL into the shared runtime so capture prioritizes the freshly opened target instead of attaching unrelated tabs on the same debug endpoint.
8. Confirm inspect mode is armed, then have the user use the persistent page toolbar to click a target in Chrome.
   The toolbar is expected to stay injected across reloads, page navigation, and every page tab in the same dedicated profile.
   On entry, the toolbar should already be active and the primary action should read `Exit Inspector`.
   A successful click should automatically exit inspect mode, leave the toolbar visible, switch the primary action back to `Inspector`, and return the page to normal interaction so links and navigation work immediately.
   The toolbar should also show a short saved-selection card under the controls so the user can see what was selected and know it was persisted.
   If the operator clicks `Inspector` after exit, inspect mode should re-enter immediately, even if no new capture workflow has been created yet.
9. Treat the selection as valid only if it is clearly for the current `workflowId` and follows a fresh operator click for this capture cycle.
   If `await_selection` appears to return immediately with stale prior context, or the durable files only show an older `updatedAt` / `payload.observedAt`, do not present it as the new selection. Restart capture or create a fresh workflow and retry.
10. Do not return a final response, a completion summary, or a "Worked for ..." timeout-style message before receiving a fresh `phase=awaiting_user_instruction` or equivalent fresh `selection_received` payload for the current capture cycle.
11. If a fresh selection is present, report the selected element with enough detail for the operator to identify and modify it without another lookup.
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
12. After reporting that richer element context, ask one concrete DOM instruction.
13. Re-run the same workflow with `scripts/inspect-capture apply --workflow-id "<workflowId>" --instruction "<user text>"`.
14. Treat `apply` as ending the capture workflow only.
    It should not remove the toolbar from the page; the toolbar stays resident in the dedicated profile and the next capture will re-arm inspect mode.

## Toolbar behavior

- The toolbar is persistent across same-tab navigation, reloads, and same-document navigation.
- Every page tab in the dedicated profile should receive the toolbar. Inspect-started tabs should enter active inspect mode immediately; non-inspect tabs should stay injected in the idle `Inspector` state until the operator or runtime activates inspect mode there.
- The primary action is a toggle:
  - `Exit Inspector` while inspect mode is active
  - `Inspector` after manual exit or after a completed selection
- A successful selection must be persisted so later turns can recover it if the original wait timed out.
- Selection history should be appended to `events/selection-history.jsonl`, not just overwritten in `current-selection.json`.
- A small `×` close affordance may be present to hide the toolbar temporarily when it blocks page content; it is not the main inspect-mode exit control.
- Manual re-entry into inspect mode should work on the first click, not require a double click.
- When no explicit URL is provided for a fresh inspect cycle, prefer the current latest page tab instead of older attached tabs on the same debug endpoint.

## Client strategy

- Preferred behavior in Codex: arm capture, then immediately call `await` and keep waiting for a fresh selection.
- This is the default because the runtime process does the waiting; it is not a high-token streaming interaction.
- Fallback only when the client cannot keep the tool call open: return immediately after arming inspect mode and tell the user to select and then come back.
- Do not make timeout-heavy partial-return flows the normal path.

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
- JSON on stdout should also expose `selectionHistoryPath` so the caller can inspect or recover the JSONL trail
- no manual bridge handshake
- no repo-wide discovery step when `project_webapp_entry.sh` already resolves the preview URL
- successful selection automatically exits inspect mode while keeping the toolbar visible
- the toolbar toggle should read `Exit Inspector` while active and `Inspector` after exit or selection
- manual re-entry into inspect mode should be immediate and single-click

## Notes

- Keep the same dedicated profile across sessions with `CHROME_USE_PROFILE_DIR`.
- Keep the dedicated `agent-profile` isolated to one Chrome window; other Chrome profile windows may exist separately.
- For explicit mismatches between expected profile/debug endpoint, run `../../../runtime/chrome-use/scripts/doctor.sh` from this skill's `scripts/` directory, or `runtime/chrome-use/scripts/doctor.sh` from the repo root.
- `about:blank` is the fallback when no URL is supplied.
- When inspect auto-start is enabled, `open_url.sh` now infers a local project root from the current working directory or git root before using `about:blank`.
- If the expected local preview port is already listening but the target URL is still not reachable, the runtime now fails fast with the blocking listener details instead of starting a second server on top of it.
- If `await_selection` resolves suspiciously fast without an obvious new click for the current capture cycle, or the current-selection file still carries an older timestamp, treat it as stale context and restart capture instead of showing it as the fresh selection.
- Performance expectation: the direct runtime should prefer the startup target and avoid attaching unrelated tabs on the same debug endpoint. If logs show many `target_attached` events for unrelated pages, treat that as a regression.
