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
`/chrome-inspect` resolves startup URL in this order for inspect flow:

- explicit user URL
- `CHROME_INSPECT_PROJECT_ROOT` docs webapp entry
- `CHROME_USE_DEFAULT_WEBAPP_URL`
- `about:blank`

If you want Codex to use the same dedicated profile path as an existing local setup:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile"
```

Typical MCP wrapper command:

```bash
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile" \
  bash chrome-use/scripts/chrome_devtools_mcp_wrapper.sh
```

To enable the selected-element tool, start wrapper in inspect mode:

```bash
CHROME_USE_MCP_MODE=inspect \
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile" \
  bash chrome-use/scripts/chrome_devtools_mcp_wrapper.sh
```

or:

```bash
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile" \
  bash chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh
```

Recommended verification for explicit commands:

1. Reinstall/update skills:
   `bash install/install-codex-skill.sh`
2. Send `/chrome-inspect` in chat.
3. Chrome session is opened through `scripts/open_url.sh` with resolved startup URL, and the local project web app is auto-started first when `CHROME_INSPECT_PROJECT_ROOT` is configured.
   Reuse keeps the dedicated `agent-profile` on a single Chrome window and opens a new tab on that running instance.
4. In Chrome, click the target element.
5. Confirm the agent does not conclude the turn before the tool returns `phase=awaiting_user_instruction`.
6. Confirm returned `summary` and `workflowId` after `phase=awaiting_user_instruction`.
7. Reply with a concrete edit instruction.
8. Confirm returned `phase=ready_to_apply`.

For `/chrome-auth`, send the explicit auth URL and then step through login/authorization actions while keeping the same dedicated profile, debug endpoint, and single dedicated Chrome window.

Available tools:

- `inspect_selected_element`
  - `waitForSelectionMs` (default `5000`, min `500`)
  - `timeoutMs` (default `10000`)
  - returns selected element description, geometry, page context
- `inspect`
  - `action` (`capture` | `apply_instruction`, default `capture`)
  - `instruction` (required for `apply_instruction`)
  - `waitForSelectionMs` (default `5000`, min `500`)
  - `timeoutMs` (`0` blocks until user selection, default `0`)
  - returns `phase`, `workflowId`, `selectedElement`, `position`, `page`, `summary`, `userInstruction`
