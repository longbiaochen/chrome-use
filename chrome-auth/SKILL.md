---
name: "chrome-auth"
description: "Run authentication and authorization workflows in a dedicated Chrome profile and preserve authenticated session state."
---

# Chrome Auth Skill

Use this skill for login, auth, and authorization workflows where stateful cookies/session must persist in the dedicated profile.

## Workflow

1. Resolve startup URL from:
2. Explicit user auth/login/authorization URL (if provided)
3. `CHROME_USE_DEFAULT_WEBAPP_URL`
4. `about:blank`
5. Start or reuse Chrome in dedicated profile via `scripts/open_url.sh`.
   Reuse must open a new tab on the running dedicated-profile instance instead of creating a second dedicated window.
6. Keep the same debug endpoint, profile, and single dedicated Chrome window for the entire auth flow.
7. Guide the user through operator-driven auth steps using Chrome DevTools MCP actions (click, input, screenshot, navigation, and state checks).

## Tools

### `scripts/open_url.sh`
Starts or reuses the dedicated profile, enforces the single-window invariant, and opens the workflow URL on that dedicated instance.

### `scripts/../chrome-use/scripts/chrome_devtools_mcp_wrapper.sh`
Runs standard MCP tool coverage for auth and follow-up workflow actions.

## Notes

- Do not automate credentials directly; keep auth operations operator-driven and tool-guided.
- Keep authentication context in the same Chrome profile across steps so cookies/storage are preserved.
- Other Chrome windows may exist under other profiles, but the dedicated `agent-profile` must remain a single-window instance.
