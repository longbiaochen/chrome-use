---
name: "chrome-inspect"
description: "Capture selected DOM elements in a dedicated Chrome profile and prepare mutation-ready inspection context."
---

# Chrome Inspect Skill

Use this skill when an agent needs deterministic, inspect-first Chrome DOM work in a dedicated profile.

## Workflow

1. Resolve startup URL in this priority:
  - Explicit user URL
  - Detected docs webapp entry from `CHROME_INSPECT_PROJECT_ROOT`
  - `CHROME_USE_DEFAULT_WEBAPP_URL`
  - `about:blank`
2. Start local docs web server (for local docs URLs) before opening Chrome when documented. The command wrapper should do this automatically for the detected project webapp entry.
3. Start or reuse Chrome with the resolved URL through `bash scripts/open_url.sh "<resolved_url>"`.
4. Ensure the session is attached to the dedicated debug endpoint.
5. Run in inspect MCP mode and call `inspect(action="capture", timeoutMs=0)` so it blocks until the user selects an element.
6. Wait for the MCP result. Do not return a final response, a completion summary, or a "Worked for ..." timeout-style message before receiving `phase=awaiting_user_instruction` with the selected-element payload.
7. If `phase=awaiting_user_instruction`, print concise selected-element summary and ask one concrete DOM instruction.
8. Re-run the same workflow with `inspect(action="apply_instruction", instruction="<user text>")` using the same `workflowId`.

## Tools

### `scripts/open_url.sh`
Starts or reuses dedicated Chrome with URL startup and prints the active debug URL.

### `scripts/../chrome-use/scripts/chrome_devtools_mcp_wrapper_inspect.sh`
Starts inspect-aware MCP bridge for `inspect_selected_element` and `inspect`.

## Notes

- Keep the same dedicated profile across sessions with `CHROME_USE_PROFILE_DIR`.
- For explicit mismatches between expected profile/debug endpoint, run `scripts/../chrome-use/scripts/doctor.sh`.
- `about:blank` is the fallback when no URL is supplied.
