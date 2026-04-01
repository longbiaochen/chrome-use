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
3. In Chrome, click the target element.
4. Confirm returned `summary` and `workflowId`.
5. Reply with a concrete edit instruction.
6. Confirm returned `phase=ready_to_apply`.

For `/chrome-auth`, send the explicit auth URL and then step through login/authorization actions while keeping the same dedicated profile.

Available tools:

- `inspect_selected_element`
  - `waitForSelectionMs` (default `5000`, min `500`)
  - `timeoutMs` (default `10000`)
  - returns selected element description, geometry, page context
- `inspect`
  - `action` (`capture` | `apply_instruction`, default `capture`)
  - `instruction` (required for `apply_instruction`)
  - `waitForSelectionMs` (default `5000`, min `500`)
  - `timeoutMs` (default `10000`)
  - returns `phase`, `workflowId`, `selectedElement`, `position`, `page`, `summary`, `userInstruction`
