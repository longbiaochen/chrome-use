# Chrome DevTools MCP comparison notes

This repository does not use Chrome DevTools MCP as the default public runtime.

Why:

- Chrome DevTools MCP is stronger for general-purpose browser automation and debugging.
- `chrome-use` is stronger for the repo-specific inspect handoff workflow:
  - persistent in-page inspect toolbar
  - fresh-click workflow gating
  - durable `workflowId`-bound selections
  - `current-selection.json` and `selection-history.jsonl` recovery
  - `latest` fast path
  - strict single dedicated-profile owner-process contract with target-level workflow isolation

Current policy:

- Keep direct CDP as the public default for `chrome-inspect` and `chrome-auth`.
- Keep the canonical runtime fixed to `agent-profile` on `127.0.0.1:9223`; public entrypoints must preflight and, when possible, auto-repair back to that dedicated runtime before attach.
- Treat Chrome DevTools MCP as a capability baseline and experimental comparison target.
- Do not require public skill users to install or configure an MCP server.

Capability mapping:

| Need | Chrome DevTools MCP | `chrome-use` default |
| --- | --- | --- |
| Page enumeration and selection | `list_pages`, `select_page` | `auth-cdp list-pages`, `auth-cdp select-page` |
| Structured page snapshot | `take_snapshot` | `auth-cdp snapshot --mode dom|a11y` |
| Screenshot capture | `take_screenshot` | `auth-cdp screenshot` |
| Basic interaction | `click`, `fill`, `hover`, `press_key` | `auth-cdp click`, `fill`, `hover`, `press-key` |
| Persistent auth state | supported with shared browser/profile config | dedicated `agent-profile` by default |
| Inspect-first operator handoff | not a built-in product workflow | native `chrome-inspect` runtime |
| Durable latest selection recovery | not a built-in product workflow | native `inspect-capture latest` |

Experimental MCP work, if added later, must remain non-default and must not change:

- public skill names
- install layout
- public README quick-start path
- manifest verification rules
