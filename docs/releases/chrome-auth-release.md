# `chrome-auth` release

`chrome-auth` is the current release focus in `chrome-use`.

This update is about a very specific pain point: web auth flows are inconsistent. Different services put sign-up and log-in in different places, mix multiple tabs and redirects, and surface manual checkpoints at arbitrary points in the flow. Screenshot-driven guidance is too slow and too brittle for that job.

## What shipped

`chrome-auth` now leans harder into direct Chrome CDP so the agent can work with the live page instead of guessing from screenshots.

- page-aware auth control with `status`, `list-pages`, and `select-page`
- direct DOM search for the real sign-up and log-in entry points
- structured snapshots with `snapshot --mode dom|a11y`
- explicit waits for auth state changes with `wait-for`
- richer interactions with `hover`, `click`, `fill`, `type`, `press-key`, and `screenshot`
- clearer operator handoff when the page reaches a manual verification checkpoint

The core positioning stays the same:

- no Chrome DevTools MCP dependency for the public default path
- no screenshot-only auth flow
- no change to the shared auth + inspect browser contract, now centered on managed Chrome for Testing

## Why this matters

If a user asks an agent to finish login, authorization, or permission-related work on a web service, the hard part is rarely "press this exact button." The hard part is finding the real auth surface, understanding the live page state, and reacting when the flow changes.

`chrome-auth` is built for that:

- it can search and inspect the live page directly instead of relying on screenshots
- it can wait for the page to prove that the auth state changed
- it can tell the operator exactly when human intervention is needed, instead of silently stalling
- it keeps the whole flow inside the same managed browser world so follow-up agent work can continue immediately after login

The point is not just "browser automation." The point is faster, more natural auth handoff between operator and agent without screenshot-driven guesswork.

## Demo walkthrough

The new local demo fixture shows the intended loop end-to-end:

1. Open the auth demo home page.
2. Detect both `Sign up` and `Log in` entry points directly from the DOM.
3. Fill a sign-up form for `John Appleseed`.
4. Detect the `Manual verification required` state without relying on screenshots.
5. Resume after the mock operator checkpoint and land on the dashboard.
6. Sign out.
7. Return to `Log in`, reuse the same credentials, and sign in again.
8. Wait for the signed-in state and finish the loop.

The demo is intentionally local and deterministic. It exists to show what `chrome-auth` is supposed to feel like on real services: find the auth surface quickly, move through the flow efficiently, and ask for human help only when it is actually needed.

## Validation

Validate this release with:

- `bash scripts/verify-manifest.sh`
- `bash scripts/test-runtime.sh`
- `node runtime/chrome-use/scripts/auth_visual_loop.mjs`
- `bash scripts/build-readme-gif.sh`

## Launch stack

Use this three-part structure for release-facing copy:

1. pain point: auth flows differ across services and screenshot-based handling is slow
2. shipped capability: `chrome-auth` now uses direct CDP page search, snapshots, waits, and richer actions
3. user payoff: the agent can finish more auth work quickly, naturally, and with clear human-intervention checkpoints
