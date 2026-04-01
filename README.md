# chrome-use

`chrome-inspect` and `chrome-auth` are explicit Codex-facing skills for Chrome DevTools MCP workflows.
`chrome-use` is retained as the shared helper package used by both skills.

Only two slash commands are surfaced by design:

- `/chrome-inspect`
- `/chrome-auth`

`/chrome` and `/inspect` are intentionally unavailable as standalone commands.

- `/chrome-inspect` captures selected DOM context in a dedicated profile and returns a mutation-ready inspect workflow.
- `/chrome-auth` handles operator-driven login/authorization flows while keeping session state on the dedicated profile.
- For `/chrome-inspect`, the launcher can auto-start a detected local project web app before opening Chrome when `CHROME_INSPECT_PROJECT_ROOT` is set.

On macOS, the launcher keeps Chrome in the background when opening or reusing the dedicated MCP profile so agent activity does not pull the window frontmost.

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

`chrome-use` is not exposed as a standalone entrypoint by default.

## Inspect-selected-element mode

To enable inspect-compatible MCP tools, set the inspect mode when launching MCP:

```bash
export CHROME_USE_MCP_MODE=inspect
bash chrome-use/scripts/chrome_devtools_mcp_wrapper.sh
```

or use the inspect wrapper directly:

```bash
bash chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh
```

Available inspect tools:

- `inspect_selected_element`
  - Returns selected element description, geometry, and page context.
  - Parameters:
    - `waitForSelectionMs` (default `5000`, minimum `500`)
    - `timeoutMs` (default `10000`)
  - Fallback strategy:
    - prioritize `Overlay.inspectNodeRequested`
    - fallback to short polling of active element state
  - Returns:
    - `selectedElement`
    - `position`
    - `page` with `title`, `url`, `pageId`, `frameId`
- `inspect`
  - Parameters:
    - `action` (`capture` | `apply_instruction`, default `capture`)
    - `instruction` (required when `apply_instruction`)
    - `waitForSelectionMs` (default `5000`, minimum `500`)
    - `timeoutMs` (`0` means block until selection, default `0`)
  - Output fields:
    - `phase` (`awaiting_user_instruction`, `ready_to_apply`)
    - `workflowId`
    - `selectedElement`
    - `position`
    - `page`
    - `summary`
    - `userInstruction`

## Client support

| Client | Install path | Status | Notes |
| --- | --- | --- | --- |
| Codex | `~/.agents/skills/` or `~/.codex/skills/` | Best supported | Optional `agents/openai.yaml` metadata included |
| Claude-compatible clients | `~/.agents/skills/` | Compatible | Client-specific wrappers may use folder-level linking |
| Generic skills-compatible agents | `.agents/skills/` | Compatible | Uses plain `SKILL.md` plus shared scripts |

## What gets installed

- `chrome-inspect/SKILL.md`
- `chrome-inspect/agents/openai.yaml`
- `chrome-auth/SKILL.md`
- `chrome-auth/agents/openai.yaml`
- `chrome-use/SKILL.md` (shared package metadata)
- `chrome-use/agents/openai.yaml` (shared package metadata)
- `chrome-use/scripts/ensure_profile.sh`
- `chrome-use/scripts/doctor.sh`
- `chrome-use/scripts/open_url.sh`
- `chrome-use/scripts/ensure_project_webapp_running.sh`
- `chrome-use/scripts/project_webapp_entry.sh`
- `chrome-use/scripts/chrome_devtools_mcp_wrapper.sh`
- `chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh`
- `chrome-use/scripts/cleanup.sh`

## Defaults

The public repo is client-neutral by default:

- profile dir: `~/.chrome-use/agent-profile`
- state dir: `~/.chrome-use/state`
- debug URL: `http://127.0.0.1:9223`

Override with environment variables:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile"
export CHROME_USE_DEBUG_PORT="9223"
```

`CHROME_USE_DEFAULT_WEBAPP_URL` is used as optional URL fallback before `about:blank`.
For `/chrome-inspect`, set `CHROME_INSPECT_PROJECT_ROOT` (for example `/Users/longbiao/Projects/home-page`) to let the helper auto-resolve the project's docs web app entry.
When `CHROME_INSPECT_AUTO_START_WEBAPP=1` is set, `open_url.sh` will also try to start that local web app before attaching Chrome.

For a Codex setup that already standardizes on `~/.codex/chrome-mcp-profile`:

- set `CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile"`, or
- update the wrapper command in `~/.codex/config.toml` to export that env var before launching the wrapper

## Codex setup notes

Install examples in this repo install both explicit skills above and do not expose `/chrome`.

For `/chrome-inspect` default flow, send:

1. Run `/chrome-inspect` in chat.
2. Let the wrapper open Chrome and auto-start the local project web app first when `CHROME_INSPECT_PROJECT_ROOT` is configured.
3. Select the target element in Chrome inspector flow.
4. Wait for `phase=awaiting_user_instruction`; the agent should not finish the turn before that selection payload is returned.
5. Confirm returned `summary` and `selectedElement`.
6. Reply with a concrete edit instruction.
7. Confirm returned `phase=ready_to_apply`.

For `/chrome-auth`, send the command with target URL when known, then follow interactive auth steps in the same dedicated profile session.

To verify packaging, command availability, and fallback behavior from this repository, run:

```bash
bash scripts/verify-manifest.sh
```

## Platform support

- macOS: tested
- Linux: scripted defaults included
- Windows: not yet tested; planned, but not claimed as supported

## Docs

- [Codex install and adapter notes](./docs/clients/codex.md)
- [Generic `.agents/skills` install](./docs/clients/generic.md)
- [Claude-compatible install notes](./docs/clients/claude.md)
