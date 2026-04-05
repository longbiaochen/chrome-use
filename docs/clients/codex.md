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
Both public skills are also allowed to trigger implicitly when the user's request clearly matches them.
`/chrome-inspect` resolves startup URL in this order for inspect flow:

- explicit user URL
- `CHROME_INSPECT_PROJECT_ROOT` docs webapp entry
- `CHROME_USE_DEFAULT_WEBAPP_URL`
- `about:blank`

If you want Codex to use the same dedicated profile path as an existing local setup:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-use-profile"
```

Typical inspect command flow:

```bash
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-use-profile" \
  bash skills/chrome-inspect/scripts/open_url.sh "http://127.0.0.1:8000/"
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-use-profile" \
  skills/chrome-inspect/scripts/inspect-capture begin --project-root "/path/to/repo"
```

Recommended verification for public skills:

1. Reinstall/update skills:
   `bash install/install-codex-skill.sh`
2. Send `/chrome-inspect` in chat.
3. Chrome session is opened through `scripts/open_url.sh` with the resolved startup URL, and the local project web app is auto-started first when `CHROME_INSPECT_PROJECT_ROOT` is configured.
   Reuse keeps the dedicated `agent-profile` on a single Chrome window and opens a new tab on that running instance.
4. The runtime should prioritize the freshly opened target instead of attaching unrelated tabs.
5. The client calls `scripts/inspect-capture begin --project-root "<repo>"` and stores `workflowId`.
6. In Chrome, use the persistent page toolbar to stay in `Inspect` mode or `Exit`, then click the target element only after inspect mode is armed.
7. The client calls `scripts/inspect-capture await --workflow-id "<workflowId>"`.
8. Treat the result as valid only if it belongs to the current `workflowId` and follows a fresh click for the current capture cycle.
   If `await_selection` appears to return immediately with stale prior context, restart capture instead of presenting it as the new selection.
9. Confirm the agent does not conclude the turn before the tool returns `phase=awaiting_user_instruction`.
10. Confirm the agent reports enough selected-element detail after `phase=awaiting_user_instruction`:
   `summary`, `workflowId`, tag / `selectedElement.nodeName`, `selectedElement.selectorHint`,
   `selectedElement.id`, `selectedElement.className`, `selectedElement.ariaLabel`, page URL,
   `position`, and the element content from `selectedElement.snippet` or equivalent captured text.
11. Reply with a concrete edit instruction.
12. Confirm returned `phase=ready_to_apply` after `scripts/inspect-capture apply --workflow-id "<workflowId>" --instruction "<user instruction>"`.

For `/chrome-auth`, send the explicit auth URL and then use `scripts/auth-cdp` for login/authorization actions while keeping the same dedicated profile, debug endpoint, and single dedicated Chrome window.
