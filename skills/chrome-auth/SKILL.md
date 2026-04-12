---
name: "chrome-auth"
description: "Handle login, auth checks, and session-preserving browser workflows in the same dedicated Chrome profile used by `chrome-inspect`."
---

# Chrome Auth Skill

Use this skill for login, auth, and authorization workflows where stateful cookies or session storage must persist in the dedicated profile. It is the companion to `chrome-inspect`: users log in once, keep the same browser world alive, and then hand real page selections back to the agent without rebuilding session state.

Command entrypoints live in this skill's own `scripts/` directory. Resolve the directory that contains this `SKILL.md`, then invoke `<skill-dir>/scripts/open_url.sh` and `<skill-dir>/scripts/auth-cdp` directly. Do not assume a repo-root `scripts/` directory contains these public auth commands.

## Workflow

1. Resolve startup URL from:
   - Explicit user auth/login/authorization URL (if provided)
   - `CHROME_USE_DEFAULT_WEBAPP_URL`
   - `about:blank`
2. Start or reuse Chrome in dedicated profile via `bash "<skill-dir>/scripts/open_url.sh"`.
   Reuse must open a new tab on the running dedicated-profile instance instead of starting a second dedicated-profile owner process.
   This public entrypoint must first preflight the canonical dedicated runtime and only continue when the endpoint is owned by `agent-profile` on `127.0.0.1:9223`; if needed it should auto-repair by relaunching the canonical runtime before attach.
3. Keep the same debug endpoint and profile for the entire auth flow. Multiple dedicated-profile windows are allowed, but auth actions must stay pinned to the same bound page.
4. Use the direct CDP auth helper for operator-guided navigation, page selection, structured snapshots, and DOM interaction:
   - `"<skill-dir>/scripts/auth-cdp" status`
   - `"<skill-dir>/scripts/auth-cdp" list-pages`
   - `"<skill-dir>/scripts/auth-cdp" bind-page --page-id "<id>"`
   - `"<skill-dir>/scripts/auth-cdp" select-page --page-id "<id>"`
   - `"<skill-dir>/scripts/auth-cdp" navigate --url "<url>" --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" wait-for --text "<visible text>" --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" snapshot --mode dom --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" snapshot --mode a11y --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" screenshot --output /tmp/auth.png --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" find --selector "<css>" --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" hover --selector "<css>" --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" click --selector "<css>" --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" fill --selector "<css>" --text "<text>" --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" type --selector "<css>" --text "<text>" --binding-id "<binding-id>"`
   - `"<skill-dir>/scripts/auth-cdp" press-key --key "Enter" --binding-id "<binding-id>"`
5. Do not automate credentials directly; keep auth operations operator-driven and tool-guided.

## Tools

### `<skill-dir>/scripts/open_url.sh`
Starts or reuses the dedicated profile, preserves the single-owner runtime contract, and opens the workflow URL on that dedicated instance.

### `<skill-dir>/scripts/auth-cdp`
Runs direct CDP commands against the dedicated Chrome debug endpoint for page-aware status, navigation, structured snapshots, screenshots, and targeted DOM actions.

## Notes

- Keep authentication context in the same Chrome profile across steps so cookies/storage are preserved.
- The only supported dedicated profile for public workflows is `agent-profile` on `127.0.0.1:9223`.
- In multi-tab or multi-agent flows, prefer `bind-page` once and then keep using `--binding-id` so later DOM commands stay pinned to the same tab instead of inheriting endpoint-wide selected-page state.
- Other Chrome windows may exist under other profiles, and the dedicated `agent-profile` may also keep multiple windows open, but there must still be only one owner process for the dedicated profile and DOM actions should stay pinned via `bindingId`.
- For manual login-state prep or user-created Chrome Web Apps, enter the profile through `Agent Profile Chrome` so auth state is created inside the same dedicated profile/runtime that agents will later reuse.
- Shared runtime helpers live under `runtime/chrome-use/` in this repository; this skill only exposes the public auth workflow entrypoints.
