---
name: "chrome-inspect"
description: "Capture selected DOM elements in a dedicated Chrome profile and prepare mutation-ready inspection context."
---

# Chrome Inspect Skill

Use this skill when an agent needs deterministic, inspect-first Chrome DOM work in a dedicated profile.

## Workflow

1. Resolve startup URL in this priority:
2. Explicit user URL
3. `CHROME_USE_DEFAULT_WEBAPP_URL`
4. `about:blank`
5. Start or reuse Chrome with the resolved URL through `scripts/open_url.sh`.
6. Ensure the session is attached to the dedicated debug endpoint.
7. Run in inspect MCP mode and call `inspect(action="capture")`.
8. If `phase=awaiting_user_instruction`, show `summary` and ask one concrete DOM instruction.
9. Re-run the same workflow with `inspect(action="apply_instruction", instruction="<user text>")` using the same `workflowId`.

## Tools

### `scripts/open_url.sh`
Starts or reuses dedicated Chrome with URL startup and prints the active debug URL.

### `scripts/../chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh`
Starts inspect-aware MCP bridge for `inspect_selected_element` and `inspect`.

## Notes

- Keep the same dedicated profile across sessions with `CHROME_USE_PROFILE_DIR`.
- For explicit mismatches between expected profile/debug endpoint, run `scripts/../chrome-use/scripts/doctor.sh`.
- `about:blank` is the fallback when no URL is supplied.

