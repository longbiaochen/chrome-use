# Codex adapter notes

For Codex, `chrome-use` is most useful when the user can point at the page faster than they can describe it. `chrome-inspect` keeps the tool call open, waits for the real click, and returns structured `page` / `element` / `content` context, while `chrome-auth` keeps the same login state alive in the dedicated profile.

Codex supports the generic skill payload plus optional metadata in installed skill folders:

- `chrome-inspect`
- `chrome-auth`

Install options:

```bash
bash install/install.sh
```

or:

```bash
bash install/install.sh --target codex
```

The unified installer detects Codex, recommends `codex + generic`, materializes public skills into `~/.codex/skills/`, installs the managed runtime under `~/.chrome-use/runtime/chrome-use` and managed skill payloads under `~/.chrome-use/skills/`, and on macOS creates `~/Applications/Agent Profile Chrome.app` by default.

This repo intentionally exposes only two explicit commands: `chrome-inspect` and `chrome-auth`.
`/chrome` and `/inspect` are not registered command selectors.
Both public skills are also allowed to trigger implicitly when the user's request clearly matches them.
`/chrome-inspect` resolves startup URL in this order for inspect flow:

- explicit user URL
- `CHROME_INSPECT_PROJECT_ROOT` docs webapp entry
- inferred current-repo docs webapp entry when inspect auto-start is enabled and the working directory or git root looks like a local project
- `CHROME_USE_DEFAULT_WEBAPP_URL`
- `about:blank`

For local-project inspect work, omitting the URL should not skip repo lookup. The shared runtime now infers the project root from the current working directory or git root before falling back to `about:blank`.

Codex should use the canonical dedicated runtime unless there is an explicit local override requirement:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.chrome-use/agent-profile"
export CHROME_USE_DEBUG_PORT="9223"
```

Public `chrome-inspect` and `chrome-auth` flows now always run a strict preflight before attaching:

- require the canonical `agent-profile` on `127.0.0.1:9223`
- require exactly one owning Chrome process for that dedicated profile
- auto-repair by launching/reusing the canonical runtime when the endpoint is missing or mismatched
- hard-block if the endpoint still resolves to the wrong profile, wrong port, or multiple owner processes after repair

Typical inspect command flow:

```bash
CHROME_USE_PROFILE_DIR="$HOME/.chrome-use/agent-profile" \
  bash skills/chrome-inspect/scripts/open_url.sh "http://127.0.0.1:8000/"
CHROME_USE_PROFILE_DIR="$HOME/.chrome-use/agent-profile" \
  skills/chrome-inspect/scripts/inspect-capture begin --project-root "/path/to/repo"
```

For manual login-state preparation or user-created Chrome Web Apps, use the dedicated launcher that Codex installs by default on macOS:

```bash
bash scripts/install-agent-profile-chrome-app.sh
```

This creates `Agent Profile Chrome`, which always opens the same canonical dedicated profile/debug toolchain that Codex will later reuse for auth and inspect work. Pass `--skip-chrome-app` if you explicitly want a Codex install without creating the app.
The app bundle itself lives at `~/Applications/Agent Profile Chrome.app`, not under `~/.chrome-use`.

Recommended verification for public skills:

1. Reinstall/update skills:
   `bash install/install.sh --target codex`
2. Resolve each public command from the installed skill directory, not from the repo root `scripts/` directory. The skill entrypoints are `~/.codex/skills/chrome-inspect/scripts/...` and `~/.codex/skills/chrome-auth/scripts/...` after install.
3. Send `/chrome-inspect` in chat.
4. Chrome session is opened through the installed skill's `scripts/open_url.sh` with the resolved startup URL, and the local project web app is auto-started first when `CHROME_INSPECT_PROJECT_ROOT` is configured or the current repo can be inferred as the local project.
   Reuse keeps the dedicated `agent-profile` on the same owner process and opens a new tab on that running instance.
   Reusing an existing matching target no longer activates that tab by default; set `CHROME_USE_ACTIVATE_EXISTING_TARGET=1` only for explicit operator-facing flows that must bring it forward.
   If the expected preview port is already listening but the target URL is still unreachable, the runtime should stop immediately with a listener-blocker error instead of starting another server.
5. The runtime should prioritize the freshly opened target instead of attaching unrelated tabs.
6. The client calls `~/.codex/skills/chrome-inspect/scripts/inspect-capture begin --project-root "<repo>"` and stores `workflowId` plus the returned `targetId`.
7. In Chrome, use the persistent page toolbar to enter inspect mode, then click the target element only after inspect mode is armed.
8. The client calls `~/.codex/skills/chrome-inspect/scripts/inspect-capture await --workflow-id "<workflowId>"`.
9. Treat the result as valid only if it belongs to the current `workflowId` and follows a fresh click for the current capture cycle.
   If `await_selection` appears to return immediately with stale prior context, restart capture instead of presenting it as the new selection.
10. For a later-turn "latest selection" recovery request, call `~/.codex/skills/chrome-inspect/scripts/inspect-capture latest`.
   Do not reuse an earlier turn's cached `workflowId` to answer "latest".
   This should be handled as a local file read, not a fresh browser/runtime attach and not a new preview lookup.
11. Confirm the agent does not conclude the turn before the tool returns `phase=awaiting_user_instruction`.
    The user should not need to come back with a pasted URL, screenshot, or extra explanation after they already clicked the page.
12. Confirm the agent reports enough selected-element detail after `phase=awaiting_user_instruction`:
   `summary`, `workflowId`, tag / `selectedElement.nodeName`, `selectedElement.selectorHint`,
   `selectedElement.id`, `selectedElement.className`, `selectedElement.ariaLabel`, page URL,
   `position`, and the element content from `selectedElement.snippet` or equivalent captured text.
13. Reply with a concrete edit instruction.
14. Confirm returned `phase=ready_to_apply` after `~/.codex/skills/chrome-inspect/scripts/inspect-capture apply --workflow-id "<workflowId>" --instruction "<user instruction>"`.

For `/chrome-auth`, send the explicit auth URL and then use `~/.codex/skills/chrome-auth/scripts/auth-cdp` for login/authorization actions while keeping the same dedicated profile and debug endpoint. Prefer `list-pages` plus `bind-page --page-id "<id>"` when more than one tab or window is open, then keep passing `--binding-id "<binding-id>"` so every DOM action stays pinned to that tab instead of inheriting an endpoint-wide selected page.
