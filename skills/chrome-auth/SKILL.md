---
name: "chrome-auth"
description: "Handle login, auth checks, and session-preserving browser workflows in the same dedicated Chrome profile used by `chrome-inspect`."
---

# Chrome Auth Skill

Use this skill for login, auth, and authorization workflows where stateful cookies or session storage must persist in the dedicated profile. It is the companion to `chrome-inspect`: users log in once, keep the same browser world alive, and then hand real page selections back to the agent without rebuilding session state.

## Workflow

1. Resolve startup URL from:
   - Explicit user auth/login/authorization URL (if provided)
   - `CHROME_USE_DEFAULT_WEBAPP_URL`
   - `about:blank`
2. Start or reuse Chrome in dedicated profile via `scripts/open_url.sh`.
   Reuse must open a new tab on the running dedicated-profile instance instead of creating a second dedicated window.
3. Keep the same debug endpoint, profile, and single dedicated Chrome window for the entire auth flow.
4. Use the direct CDP auth helper for operator-guided navigation, screenshots, state inspection, and simple DOM interaction:
   - `scripts/auth-cdp status`
   - `scripts/auth-cdp navigate --url "<url>"`
   - `scripts/auth-cdp snapshot --output /tmp/auth.png`
   - `scripts/auth-cdp find --selector "<css>"`
   - `scripts/auth-cdp click --selector "<css>"`
   - `scripts/auth-cdp type --selector "<css>" --text "<text>"`
5. Do not automate credentials directly; keep auth operations operator-driven and tool-guided.

## Tools

### `scripts/open_url.sh`
Starts or reuses the dedicated profile, enforces the single-window invariant, and opens the workflow URL on that dedicated instance.

### `scripts/auth-cdp`
Runs direct CDP commands against the dedicated Chrome debug endpoint for status, navigation, screenshots, and targeted DOM actions.

## Notes

- Keep authentication context in the same Chrome profile across steps so cookies/storage are preserved.
- Other Chrome windows may exist under other profiles, but the dedicated `agent-profile` must remain a single-window instance.
- Shared runtime helpers live under `runtime/chrome-use/` in this repository; this skill only exposes the public auth workflow entrypoints.
