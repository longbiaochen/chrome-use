# chrome-use

[![English version](https://img.shields.io/badge/English%20version-README-blue)](./README.md)
[![中文版](https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E7%89%88-README.zh--CN-red)](./README.zh-CN.md)

> `chrome-use` is a managed Chrome for Testing workflow for coding agents.
> It solves the slow handoff between human clicks and agent actions by keeping a dedicated agent browser alive, then turning human intent into agent-usable context and browser state over CDP.
> It ships two focused public skills: `chrome-inspect` for live page selection handoff, and `chrome-auth` for direct-CDP auth flows that find and use the real login surface without relying on screenshots.

Built for people shipping web apps with coding agents: product engineers, infra engineers, tool builders, and anyone who wants a fast human-in-the-loop browser loop without copying links, pasting screenshots, or re-explaining what part of the page matters.

## `chrome-use` plugin

`chrome-use` is not a generic browser wrapper. It is a local-first browser runtime plus two installable skills built around one strict contract:

- one managed `Chrome for Testing` runtime
- one CDP endpoint at `127.0.0.1:9223`
- one reusable browser session shared across inspect, auth, and whatever comes next

That gives you a cleaner handoff between operator and agent:

- the operator can point at a live page once, and the agent gets structured context instead of a screenshot
- the agent can finish auth in the same managed browser instead of redoing login in a throwaway session
- browser state stays stable across turns, so follow-up work starts from the page the user already prepared

## `chrome-inspect`

`chrome-inspect` is the inspect-first skill in `chrome-use`: the operator clicks a live target once, and the agent gets mutation-ready page context back in the same turn.

![`chrome-inspect` demo](./docs/media/chrome-inspect-demo.gif)

_Demo: open the in-page inspect panel, visibly click into inspect mode, select the real target on the page, and return durable structured context instead of a screenshot._

Under the hood, `chrome-inspect` keeps a persistent in-page panel inside the managed Chrome for Testing session, preserves the latest good selection, and returns `selectedElement`, page metadata, snippets, and element position for downstream DOM mutation.

## `chrome-auth`

`chrome-auth` is the auth-first skill in `chrome-use`: it uses direct Chrome CDP to search the real page, find the correct sign-up or log-in entry point, and move through web auth flows without treating the page like an image.

![`chrome-auth` demo](./docs/media/chrome-auth-demo.gif)

_Demo: open a local auth fixture, locate the real `Sign up` button, register `John Appleseed`, land on the login page, then log in with the same account and finish the loop inside the managed Chrome for Testing session._

Under the hood, `chrome-auth` stays in the same managed Chrome for Testing session, can list and select tabs, inspect structured snapshots, wait for page state changes, and drive click/fill/type flows directly through CDP instead of falling back to screenshot-only automation.

## General

## 🧠 Architecture

chrome-use uses a managed `Chrome for Testing` browser plus a dedicated CDP runtime:

- managed browser root: `~/.chrome-use/browsers/chrome-for-testing/<version>/<platform>`
- dedicated browser-data dir: `~/.chrome-use/browser-data/<channel-or-version>`
- state dir: `~/.chrome-use/state`
- debug endpoint: `http://127.0.0.1:9223`
- direct remote debugging session over CDP

That design matters:

- the agent keeps its own isolated browser world
- auth state is stable and reusable across turns
- inspect and auth share the same browser session
- agents can keep a fast, low-overhead connection instead of repeatedly booting new browsers
- the runtime can route selections and workflow state deterministically by `workflowId`, `captureToken`, and bound `targetId`
- user selections stay durable in persisted state instead of disappearing into one-off chat messages

On macOS, the launcher starts the managed `Chrome for Testing` binary directly with its dedicated `--user-data-dir` and reuses that runtime when CDP is already healthy. The runtime still expects one owner process for the configured browser-data path, but it may keep more than one Chrome window open when different agent threads are pinned to different tabs or targets.

Important boundaries:

- `Chrome for Testing` is the automation browser here, not your day-to-day Chrome profile
- it does not inherit your existing Chrome `Default` cookies, extensions, bookmarks, or sync state
- it does not auto-update; rerun `bash install/install.sh` to refresh Stable, or pin `CHROME_USE_CFT_VERSION` when you need a fixed version
- treat it as a trusted-content browser for agent workflows, not a general browsing recommendation
- if you intentionally need a user-supplied browser instead, use `--browser system` or set `CHROME_USE_BROWSER_KIND=system`

## 🥊 Where chrome-use fits

chrome-use is best understood as an opinionated skill layer on top of Chrome itself.

| Tool | What it is great at | Where chrome-use is stronger |
| --- | --- | --- |
| Chrome DevTools MCP | General-purpose browser debugging, automation, traces, network, console, screenshots | chrome-use adds an inspect-first operator workflow, persistent in-page panel UX, and mutation-ready selection handoff on a managed agent browser |
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

- [`chrome-auth` release notes](./docs/releases/chrome-auth-release.md)
- [`chrome-inspect` milestone release notes](./docs/releases/chrome-inspector-milestone.md)

## Fast install

Unified installer:

```bash
git clone https://github.com/longbiaochen/chrome-use.git
cd chrome-use
bash install/install.sh
```

The installer stages a managed runtime under `~/.chrome-use`, downloads managed Chrome for Testing from the official Chrome for Testing feed by default, materializes public skills into the selected agent directories, and records the install in `~/.chrome-use/install-manifest.json`.

Non-interactive examples:

```bash
bash install/install.sh --target codex --non-interactive --yes
bash install/install.sh --target generic --non-interactive --yes
bash install/install.sh --browser system --skip-browser-download --target generic --non-interactive --yes
```

Compatibility wrappers still exist:

```bash
bash install/install-codex-skill.sh
bash install/install-agent-skill.sh
```

After install, exposed skills are:

- `~/.codex/skills/chrome-inspect`
- `~/.codex/skills/chrome-auth`
- `~/.agents/skills/chrome-inspect`
- `~/.agents/skills/chrome-auth`

Use one target per machine by default. On Codex, install to `~/.codex/skills` only. Installing the same `chrome-*` skills into both `~/.codex/skills` and `~/.agents/skills` can make Codex surface duplicate skill entries.

`chrome-use` itself is not exposed as a standalone skill or command. Installed shared runtime code lives under `~/.chrome-use/runtime/chrome-use/`, and the managed public skill payloads live under `~/.chrome-use/skills/`.

## Direct CDP workflows

`chrome-inspect` uses direct CDP capture commands:

```bash
bash skills/chrome-inspect/scripts/open_url.sh "http://127.0.0.1:8000/"
skills/chrome-inspect/scripts/inspect-capture begin --project-root "/path/to/repo"
skills/chrome-inspect/scripts/inspect-capture await --workflow-id "<workflowId>"
```

`inspect-capture begin` returns both `workflowId` and the bound `targetId`, so later `await` and `apply` calls stay pinned to the same tab even when other agent threads are attached to the same debug endpoint.

or the one-shot helper:

```bash
skills/chrome-inspect/scripts/inspect_select_element.sh "/path/to/repo"
```

`chrome-auth` uses direct CDP auth helpers against the same managed Chrome for Testing session:

```bash
bash skills/chrome-auth/scripts/open_url.sh "https://example.com/login"
skills/chrome-auth/scripts/auth-cdp status
skills/chrome-auth/scripts/auth-cdp list-pages
skills/chrome-auth/scripts/auth-cdp bind-page --page-id "<page-id>"
skills/chrome-auth/scripts/auth-cdp select-page --page-id "<page-id>"
skills/chrome-auth/scripts/auth-cdp snapshot --mode a11y --binding-id "<binding-id>"
skills/chrome-auth/scripts/auth-cdp screenshot --output /tmp/auth.png
```

For concurrency-safe auth automation, prefer `bind-page` once and then pass `--binding-id` on every DOM action instead of relying on the endpoint-wide stored selected page.

## Client support

| Client | Install path | Status | Notes |
| --- | --- | --- | --- |
| Codex | `~/.codex/skills/` | Best supported | Default install target on Codex; keeps optional `agents/openai.yaml` metadata |
| Claude-compatible clients | `~/.claude/skills/` or `~/.agents/skills/` | Compatible | Use only when you need a non-Codex client on the same machine |
| Generic skills-compatible agents | `~/.agents/skills/` | Compatible | Uses plain `SKILL.md`; no Codex-specific metadata is copied |

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

- browser kind: `cft`
- browser dir: `~/.chrome-use/browsers/chrome-for-testing/<version>/<platform>`
- profile dir: `~/.chrome-use/browser-data/<channel-or-version>`
- profile name: `Default`
- state dir: `~/.chrome-use/state`
- install root: `~/.chrome-use`
- managed runtime root: `~/.chrome-use/runtime/chrome-use`
- managed skills root: `~/.chrome-use/skills`
- debug URL: `http://127.0.0.1:9223`

Runtime contract:

- exactly one `Google Chrome for Testing` owner process exposes `127.0.0.1:9223`
- that process is expected to run the configured dedicated browser-data path
- follow-up launches reuse that same instance by opening a new tab there
- multiple windows may exist on macOS, but target ownership must stay isolated per workflow / binding
- every public inspect/auth attach first runs a managed-browser preflight and auto-repair path
- if the debug endpoint is still not owned by the expected Chrome for Testing process after auto-repair, the runtime blocks instead of silently attaching elsewhere

Override with environment variables:

```bash
export CHROME_USE_BROWSER_KIND="cft"
export CHROME_USE_CFT_CHANNEL="stable"
export CHROME_USE_PROFILE_DIR="$HOME/.chrome-use/browser-data/stable"
export CHROME_USE_DEBUG_PORT="9223"
```

Manual user entrypoint on macOS:

```bash
~/.chrome-use/bin/chrome-use-open-google-chrome
```

That wrapper bootstraps the managed `Chrome for Testing` browser into the expected CDP-attached state and reuses the same runtime that `chrome-inspect` and `chrome-auth` attach to later.

`CHROME_USE_DEFAULT_WEBAPP_URL` is used as optional URL fallback before `about:blank`.
For `/chrome-inspect`, set `CHROME_INSPECT_PROJECT_ROOT` (for example `/Users/longbiao/Projects/home-page`) to let the helper auto-resolve the project's docs web app entry.
If inspect auto-start is enabled and that env var is missing, the shared runtime now infers the project root from the current working directory or git root before using `about:blank`.
When `CHROME_INSPECT_AUTO_START_WEBAPP=1` is set, `open_url.sh` will also try to start that local web app before attaching Chrome.
That autostart path only applies when the resolved target is a matching local `localhost` or `127.0.0.1` URL for the detected project entry.
If the expected preview port is already listening but the target URL is still unreachable, `open_url.sh` now stops immediately with the blocking listener details instead of starting a second server.

For a Codex setup that needs an explicit browser override:

- set `CHROME_USE_BROWSER_KIND=system` to use a user-supplied browser, or
- export `CHROME_USE_CHROME_BIN` / `CHROME_USE_CHROME_APP` before running the skill commands

## Codex setup notes

Install examples in this repo install only the two public skills above and do not expose `/chrome`. Both public skills may be used explicitly or implicitly.

For `/chrome-inspect` default flow, send:

1. Run `/chrome-inspect` in chat.
2. Let `scripts/open_url.sh` open Chrome and auto-start the local project web app first when `CHROME_INSPECT_PROJECT_ROOT` is configured or the current repo can be inferred as the local project.
   If the managed Chrome for Testing runtime is already running in the expected CDP-attached state, the command reuses it by opening a new tab there instead of relaunching.
   Reusing an existing matching target no longer activates that tab by default; set `CHROME_USE_ACTIVATE_EXISTING_TARGET=1` only for explicit operator-facing flows that must bring it to the front.
3. Start capture with `scripts/inspect-capture begin --project-root "<repo>"` and store the returned `workflowId` and `targetId`.
4. Confirm inspect mode is armed, then click the target element in Chrome.
   The page panel should already be injected in the idle ready state on entry, with the primary action labeled `Press this button to inspect`.
   After the operator clicks that button, inspect mode should become active and the button should read `Inspecting`.
   After a successful click, inspect mode should auto-exit, the primary action should flip back to `Press this button to inspect`, and the panel should remain visible.
   The saved-selection details should live inside that same panel and show `Selected`, `Content`, `Page`, and `Element`.
   The page should immediately become navigable again, and the panel should continue to appear across same-tab navigation, reloads, same-document navigation, and other tabs in the same managed browser session.
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
- Every page tab in the same managed Chrome for Testing session should receive the same panel in that idle state by default.
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

For `/chrome-auth`, send the command with target URL when known, then use `scripts/auth-cdp` for page status, page selection, structured snapshots, screenshots, element lookup, clicks, fill/type actions, waits, and key presses in the same managed browser session.

To verify packaging, command availability, and fallback behavior from this repository, run:

```bash
bash scripts/verify-manifest.sh
```

To verify the Chrome attach runtime contract with mocked process, endpoint, and window state, run:

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
