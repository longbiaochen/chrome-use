# chrome-use

[![English version](https://img.shields.io/badge/English%20version-README-blue)](./README.md)
[![中文版](https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E7%89%88-README.zh--CN-red)](./README.zh-CN.md)

> ⚡ chrome-use ships a faster browser workflow for coding agents.
> It gives you a dedicated Chrome session for full inspect + auth loops, keeps a long-lived remote-debugging connection open, and exposes two public skills:
> `chrome-inspect` and `chrome-auth`.

## 🚀 Milestone: `chrome-inspect` shipped

`chrome-use` now ships `chrome-inspect`: a faster, full workflow for agent + operator collaboration on live pages.

What you get on the first screen:

- one dedicated `agent-profile`, separate from your default Chrome profile
- direct Chrome DevTools Protocol (CDP) control over a remote-debuggable Chrome instance
- a persistent in-page inspect panel that survives reloads, same-tab navigation, and same-document navigation
- a `begin -> await -> apply` workflow that returns mutation-ready DOM context from the first real click
- companion auth flows through `chrome-auth`, so login and inspection live in the same dedicated browser session
- a `latest` fast path for recovering the most recent saved selection without reopening Chrome

This repo is opinionated on purpose: it is not a generic browser MCP wrapper. It is a local-first skill set for people who want faster inspect handoff, stable auth state, and a cleaner human-in-the-loop browser workflow.
Try it, star it, and open a PR if there is a browser loop you want `chrome-use` to own.

## ✨ Why chrome-use feels different

### `chrome-inspect`

- click-to-capture inspect workflow for real pages
- first click completes the active workflow immediately
- persistent panel with a single primary action and saved selection context
- returns `selectedElement`, `position`, `page`, `summary`, and element content for downstream DOM mutation
- built for agent turns that need precise UI context, not just screenshots or text dumps

### `chrome-auth`

- operator-driven login and authorization in the same dedicated browser
- keeps cookies, sessions, and local storage inside the dedicated agent profile
- lets the agent navigate, inspect status, screenshot, click, type, and continue work after auth is done

## 🧠 Architecture

chrome-use uses a dedicated browser runtime instead of your normal Chrome session:

- dedicated profile dir: `~/.chrome-use/agent-profile`
- dedicated state dir: `~/.chrome-use/state`
- dedicated debug endpoint: `http://127.0.0.1:9223`
- dedicated remote debugging session over CDP

That design matters:

- your default Chrome profile stays untouched
- auth state is stable and reusable across turns
- inspect and auth share the same browser session
- agents can keep a fast, low-overhead connection instead of repeatedly booting new browsers
- the runtime can route selections and workflow state deterministically by `workflowId` and `captureToken`

On macOS, the launcher keeps the dedicated Chrome instance in the background so agent activity does not steal focus. The dedicated `agent-profile` must remain a single-window Chrome instance; other Chrome windows under other profiles are allowed.

## 🥊 Where chrome-use fits

chrome-use is best understood as an opinionated skill layer on top of Chrome itself.

| Tool | What it is great at | Where chrome-use is stronger |
| --- | --- | --- |
| Chrome DevTools MCP | General-purpose browser debugging, automation, traces, network, console, screenshots | chrome-use adds an inspect-first operator workflow, persistent in-page panel UX, dedicated profile discipline, and mutation-ready selection handoff |
| `agent-browser` | Fast CLI automation and accessibility/snapshot-driven browser control | chrome-use is stronger when an operator needs to point at a live DOM target and hand exact page context back to an agent |
| `browser-use` | High-level browser agents, cloud/browser infrastructure, and broad automation frameworks | chrome-use is leaner and more local-first for coding-agent workflows that need precise inspection, persistent auth, and minimal runtime indirection |

chrome-use is intentionally narrower than those tools. That narrowness is the advantage: it is optimized for live inspect/edit/auth loops instead of trying to be every browser tool at once.

## 📦 Public skills

Only two public skill names are surfaced by design:

- `chrome-inspect`
- `chrome-auth`

`chrome-use` itself is not exposed as a standalone skill or command. `/chrome` and `/inspect` are intentionally unavailable as standalone selectors.

For `chrome-inspect`, the launcher can auto-start a detected local project web app before opening Chrome when `CHROME_INSPECT_PROJECT_ROOT` is set or when the current working directory or git root can be inferred as the local project.

Both public skills may be invoked explicitly or implicitly.

## 📝 Release note

- [`chrome-inspect` milestone release notes](./docs/releases/chrome-inspector-milestone.md)

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
   The page panel should already be injected in the idle ready state on entry, with the primary action labeled `Press this button to inspect`.
   After the operator clicks that button, inspect mode should become active and the button should read `Inspecting`.
   After a successful click, inspect mode should auto-exit, the primary action should flip back to `Press this button to inspect`, and the panel should remain visible.
   The saved-selection details should live inside that same panel and show `Selected`, `Content`, `Page`, and `Element`.
   The page should immediately become navigable again, and the panel should continue to appear across same-tab navigation, reloads, same-document navigation, and other tabs in the same dedicated profile.
   Clicking `Press this button to inspect` after selection or idle state should immediately re-enter inspect mode, even before a new capture workflow is created.
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

The inspect panel is a persistent browser-level affordance, while capture is a one-shot workflow layered on top of it.

- On first entry to a new capture, the panel should already be visible but idle. The primary button reads `Press this button to inspect`.
- Every page tab in the dedicated profile should receive the same panel in that idle state by default.
- If the operator clicks `Press this button to inspect`, inspect mode starts immediately and the primary button changes to `Inspecting`.
- If the operator selects an element, inspect mode stops immediately and the panel moves to a saved-selection state.
- In the saved-selection state, the panel should show `Selected`, `Content`, `Page`, and `Element` in the same panel body.
- In the saved-selection or idle state, clicking `Press this button to inspect` must re-enter inspect mode without requiring a second click or a brand-new workflow just to make the UI responsive.
- Panel presence should persist across same-tab navigation, reloads, and same-document navigation.
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

The script opens the dedicated browser against a deterministic local fixture, verifies the idle `Press this button to inspect` / active `Inspecting` panel contract, checks that a secondary tab receives the same idle panel injection, checks that selection auto-exits inspect mode, validates the unified saved-selection panel body, confirms manual re-entry without a fresh workflow, verifies JSONL history appends across selections, confirms navigation keeps the panel injected, and writes screenshots to a temp output directory.

## Platform support

- macOS: tested
- Linux: scripted defaults included
- Windows: not yet tested; planned, but not claimed as supported

## Docs

- [Codex install and adapter notes](./docs/clients/codex.md)
- [Generic `.agents/skills` install](./docs/clients/generic.md)
- [Claude-compatible install notes](./docs/clients/claude.md)
