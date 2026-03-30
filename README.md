# chrome-use

`chrome-use` is an agent skill for persistent Chrome DevTools MCP sessions with a dedicated browser profile, readiness checks, and mismatch detection.

It is packaged as a cross-agent `SKILL.md` skill first, with Codex as the reference client and best-tested adapter.

## Why this exists

Most Chrome MCP demos assume a fresh browser or a one-off debug session. Real agent work usually needs:

- a persistent authenticated Chrome profile
- a fixed debug endpoint
- a way to prove the MCP server is attached to the correct profile
- a blocker when the endpoint points at the wrong browser

`chrome-use` gives you that harness as a reusable skill instead of a repo-local script pile.

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

After install, the canonical skill folder is `chrome-use/` and the canonical entrypoint is [`chrome-use/SKILL.md`](./chrome-use/SKILL.md).

## Client support

| Client | Install path | Status | Notes |
| --- | --- | --- | --- |
| Codex | `~/.agents/skills/` or `~/.codex/skills/` | Best supported | Optional `agents/openai.yaml` metadata included |
| Claude-compatible clients | `~/.agents/skills/` | Compatible | `.claude/skills/` may work for some clients, but is not the canonical path |
| Generic skills-compatible agents | `.agents/skills/` | Compatible | Uses plain `SKILL.md` plus shell scripts |

## What gets installed

- [`chrome-use/SKILL.md`](./chrome-use/SKILL.md)
- [`chrome-use/scripts/ensure_profile.sh`](./chrome-use/scripts/ensure_profile.sh)
- [`chrome-use/scripts/doctor.sh`](./chrome-use/scripts/doctor.sh)
- [`chrome-use/scripts/open_url.sh`](./chrome-use/scripts/open_url.sh)
- [`chrome-use/scripts/chrome_devtools_mcp_wrapper.sh`](./chrome-use/scripts/chrome_devtools_mcp_wrapper.sh)
- [`chrome-use/scripts/cleanup.sh`](./chrome-use/scripts/cleanup.sh)

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

## Codex example

Codex-specific metadata is optional and lives in [`chrome-use/agents/openai.yaml`](./chrome-use/agents/openai.yaml).

For a Codex setup that already standardizes on `~/.codex/chrome-mcp-profile`, either:

- set `CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile"`, or
- update the wrapper command in your `~/.codex/config.toml` to export that env var before launching the wrapper

## Platform support

- macOS: tested
- Linux: scripted defaults included
- Windows: not yet tested; planned, but not claimed as supported

## Docs

- [Codex install and adapter notes](./docs/clients/codex.md)
- [Generic `.agents/skills` install](./docs/clients/generic.md)
- [Claude-compatible install notes](./docs/clients/claude.md)

## Positioning

Market this as an agent skill or Chrome DevTools MCP skill, not a plugin.

The portable value is the skill contract:

- persistent dedicated profile
- fixed debug endpoint
- profile ownership check
- clear blocker on mismatch

That is the hook worth sharing in demos, screenshots, and social posts.
