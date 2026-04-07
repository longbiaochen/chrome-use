# chrome-use

`chrome-use` is the repository and shared runtime for two public browser skills:

- `chrome-inspect`
- `chrome-auth`

Only two public skill names are surfaced by design:

- `/chrome-inspect`
- `/chrome-auth`

`/chrome` and `/inspect` are intentionally unavailable as standalone commands.

- `/chrome-inspect` captures selected DOM context in a dedicated profile and returns a mutation-ready inspect workflow.
- `/chrome-auth` handles operator-driven login/authorization flows while keeping session state on the dedicated profile.
- For `/chrome-inspect`, the launcher can auto-start a detected local project web app before opening Chrome when `CHROME_INSPECT_PROJECT_ROOT` is set or when the current working directory or git root can be inferred as the local project.
- Both public skills may be invoked explicitly or implicitly.

On macOS, the launcher keeps Chrome in the background when opening or reusing the dedicated profile so agent activity does not pull the window frontmost. The dedicated `agent-profile` must remain a single-window Chrome instance; other Chrome windows under other profiles are allowed.

## Fast install

Neutral install target:

```bash
git clone https://github.com/longbiaochen/chrome-use.git
cd chrome-use
bash install/install-agent-skill.sh
```

Codex-native install target:

```bash
git clone https://github.com/longbiaochen/chrome-use.git
cd chrome-use
bash install/install-codex-skill.sh
```

After install, exposed skills are:

- `~/.agents/skills/chrome-inspect`
- `~/.agents/skills/chrome-auth`
- `~/.codex/skills/chrome-inspect`
- `~/.codex/skills/chrome-auth`

`chrome-use` itself is not exposed as a standalone skill or command. Shared runtime code lives under `runtime/chrome-use/`.

## Direct CDP workflows

`chrome-inspect` uses direct CDP capture commands:

```bash
bash skills/chrome-inspect/scripts/open_url.sh "http://127.0.0.1:8000/"
skills/chrome-inspect/scripts/inspect-capture begin --project-root "/path/to/repo"
skills/chrome-inspect/scripts/inspect-capture await --workflow-id "<workflowId>"
```

or the one-shot helper:

```bash
skills/chrome-inspect/scripts/inspect_select_element.sh "/path/to/repo"
```

`chrome-auth` uses direct CDP auth helpers against the same dedicated profile:

```bash
bash skills/chrome-auth/scripts/open_url.sh "https://example.com/login"
skills/chrome-auth/scripts/auth-cdp status
skills/chrome-auth/scripts/auth-cdp snapshot --output /tmp/auth.png
```

## Client support

| Client | Install path | Status | Notes |
| --- | --- | --- | --- |
| Codex | `~/.agents/skills/` or `~/.codex/skills/` | Best supported | Optional `agents/openai.yaml` metadata included; public skills may trigger implicitly |
| Claude-compatible clients | `~/.agents/skills/` | Compatible | Client-specific wrappers may use folder-level linking |
| Generic skills-compatible agents | `.agents/skills/` | Compatible | Uses plain `SKILL.md` plus shared runtime wrappers |

## Repository layout

Public skills:

- `skills/chrome-inspect/SKILL.md`
- `skills/chrome-inspect/agents/openai.yaml`
- `skills/chrome-auth/SKILL.md`
- `skills/chrome-auth/agents/openai.yaml`

Shared runtime:

- `runtime/chrome-use/scripts/ensure_profile.sh`
- `runtime/chrome-use/scripts/doctor.sh`
- `runtime/chrome-use/scripts/open_url.sh`
- `runtime/chrome-use/scripts/ensure_project_webapp_running.sh`
- `runtime/chrome-use/scripts/project_webapp_entry.sh`
- `runtime/chrome-use/scripts/inspect_capture.mjs`
- `runtime/chrome-use/scripts/inspect_runtime.mjs`
- `runtime/chrome-use/scripts/auth_cdp.mjs`
- `runtime/chrome-use/scripts/cleanup.sh`

## Defaults

The public repo is client-neutral by default:

- profile dir: `~/.chrome-use/agent-profile`
- state dir: `~/.chrome-use/state`
- debug URL: `http://127.0.0.1:9223`

Runtime contract:

- exactly one Chrome process owns `~/.chrome-use/agent-profile`
- that process exposes `127.0.0.1:9223`
- the dedicated profile has exactly one Chrome window on macOS
- follow-up launches reuse that same instance by opening a new tab there

Override with environment variables:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-use-profile"
export CHROME_USE_DEBUG_PORT="9223"
```

`CHROME_USE_DEFAULT_WEBAPP_URL` is used as optional URL fallback before `about:blank`.
For `/chrome-inspect`, set `CHROME_INSPECT_PROJECT_ROOT` (for example `/Users/longbiao/Projects/home-page`) to let the helper auto-resolve the project's docs web app entry.
If inspect auto-start is enabled and that env var is missing, the shared runtime now infers the project root from the current working directory or git root before using `about:blank`.
When `CHROME_INSPECT_AUTO_START_WEBAPP=1` is set, `open_url.sh` will also try to start that local web app before attaching Chrome.
That autostart path only applies when the resolved target is a matching local `localhost` or `127.0.0.1` URL for the detected project entry.
If the expected preview port is already listening but the target URL is still unreachable, `open_url.sh` now stops immediately with the blocking listener details instead of starting a second server.

For a Codex setup that already standardizes on a custom dedicated profile path:

- set `CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-use-profile"`, or
- export that env var in your local shell/profile before running the skill commands

## Codex setup notes

Install examples in this repo install only the two public skills above and do not expose `/chrome`. Both public skills may be used explicitly or implicitly.

For `/chrome-inspect` default flow, send:

1. Run `/chrome-inspect` in chat.
2. Let `scripts/open_url.sh` open Chrome and auto-start the local project web app first when `CHROME_INSPECT_PROJECT_ROOT` is configured or the current repo can be inferred as the local project.
   If the dedicated profile is already running, the command reuses it by opening a new tab there instead of creating another dedicated window.
3. Start capture with `scripts/inspect-capture begin --project-root "<repo>"` and store the returned `workflowId`.
4. Confirm inspect mode is armed, then click the target element in Chrome.
   The page toolbar should already be in active inspect mode on entry, with the primary action labeled `Exit Inspector`.
   After a successful click, inspect mode should auto-exit, the primary action should flip back to `Inspector`, and the toolbar should remain visible.
   The toolbar should also show a short saved-selection card under the main controls so the operator can see what was selected and know it has been persisted.
   The page should immediately become navigable again, and the toolbar should continue to appear across same-tab navigation, reloads, same-document navigation, and other tabs in the same dedicated profile.
   Clicking `Inspector` after exit should immediately re-enter inspect mode, even before a new capture workflow is created.
5. Call `scripts/inspect-capture await --workflow-id "<workflowId>"`.
6. Treat the result as valid only if it belongs to the current `workflowId` and follows a fresh click for this capture cycle.
   If `await_selection` appears to return immediately with stale prior context, restart capture instead of presenting it as the new selection.
7. Wait for `phase=awaiting_user_instruction`; the agent should not finish the turn before that selection payload is returned.
8. Confirm the agent reports enough selected-element detail to avoid another lookup:
   `summary`, tag / `nodeName`, `selectorHint`, `id`, `className`, `ariaLabel`, page URL,
   `position`, and the element content from `selectedElement.snippet` or equivalent captured text.
9. Reply with a concrete edit instruction.
10. Call `scripts/inspect-capture apply --workflow-id "<workflowId>" --instruction "<user instruction>"`.
11. Confirm returned `phase=ready_to_apply`.
    `apply` completes the capture workflow only; it should not remove the toolbar from the page.

## Inspect toolbar contract

The inspect toolbar is a persistent browser-level affordance, while capture is a one-shot workflow layered on top of it.

- On first entry to a new capture, the toolbar should already be active. The primary button reads `Exit Inspector`.
- Every page tab in the dedicated profile should receive the toolbar. Inspect-originated tabs start active; other tabs stay injected in the idle `Inspector` state until a capture or manual re-entry activates inspect mode there.
- If the operator clicks `Exit Inspector`, inspect mode stops immediately and the primary button changes back to `Inspector`.
- If the operator selects an element, inspect mode also stops immediately and the toolbar moves to a saved-selection state.
- In the saved-selection state, the toolbar should show a short summary card under the controls with “Selected and saved. Return to the agent.” plus a compact element summary.
- In the saved-selection or exited state, clicking `Inspector` must re-enter inspect mode without requiring a second click or a brand-new workflow just to make the UI responsive.
- A small `×` button may be present to temporarily dismiss the toolbar when it overlaps page content. This is a visibility affordance, not the main exit path.
- Toolbar presence should persist across same-tab navigation, reloads, and same-document navigation.
- The most recent successful selection should be persisted so the next turn can recover it if the original capture timed out.
- Selection history should also be appended to `events/selection-history.jsonl` so at least one prior selection remains inspectable like a clipboard trail.
- When a new inspect session starts without an explicit URL, the runtime should prefer the current latest page tab instead of wandering across older attached tabs.

## Agent behavior

The preferred Codex behavior is to arm inspect mode and then keep waiting for the operator’s click, rather than returning early with a timeout-style message.

- Default behavior: use `begin` followed immediately by `await` and keep the turn open until a fresh selection arrives.
- This does not materially increase token burn because the wait is handled by the runtime process, not by streaming assistant text.
- Fallback behavior: only if the client cannot reliably keep a long-running tool call alive, return immediately after arming inspect mode and tell the operator to click the page and then come back.
- Do not use “wait a bit and maybe timeout” as the normal UX. Either keep waiting, or return immediately and say exactly what the user should do next.

For `/chrome-auth`, send the command with target URL when known, then use `scripts/auth-cdp` for page status, navigation, screenshots, element lookup, clicks, and typing in the same dedicated profile session.

To verify packaging, command availability, and fallback behavior from this repository, run:

```bash
bash scripts/verify-manifest.sh
```

To verify the dedicated-profile runtime contract with mocked process, endpoint, and window state, run:

```bash
bash scripts/test-runtime.sh
```

To run the local closed-loop visual validation for the compact inspect toolbar, run:

```bash
node runtime/chrome-use/scripts/inspect_visual_loop.mjs
```

The script opens the dedicated browser against a deterministic local fixture, verifies the `Exit Inspector` / `Inspector` toggle contract, checks that a secondary tab receives idle toolbar injection, checks that selection auto-exits inspect mode, validates the saved-selection summary card, confirms manual re-entry without a fresh workflow, verifies JSONL history appends across selections, confirms navigation keeps the toolbar injected, re-arms a second capture on the destination page, and writes screenshots to a temp output directory.

## Platform support

- macOS: tested
- Linux: scripted defaults included
- Windows: not yet tested; planned, but not claimed as supported

## Docs

- [Codex install and adapter notes](./docs/clients/codex.md)
- [Generic `.agents/skills` install](./docs/clients/generic.md)
- [Claude-compatible install notes](./docs/clients/claude.md)
