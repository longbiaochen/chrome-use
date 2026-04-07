# Chrome Inspector milestone

ChromeUse now ships a full inspect-first workflow for coding agents.

## What shipped

- `chrome-inspect` now supports a persistent in-page inspect panel in the dedicated agent profile
- the first real page click completes the active inspect workflow immediately
- `inspect-capture await` now uses one long-lived daemon wait instead of layered reconnect/search fallback during the normal path
- the saved-selection panel now shows `Selected`, `Content`, `Page`, and `Element`
- `inspect-capture latest` can recover the most recent persisted selection without reopening Chrome
- `chrome-auth` remains the companion skill for login and authorization in the same dedicated browser session

## Why this matters

Most browser tools are either:

- generic automation layers, or
- generic debugging layers

ChromeUse is narrower and more opinionated:

- one dedicated agent profile, separate from the default Chrome profile
- one dedicated remote-debuggable Chrome runtime
- one inspect workflow that maps cleanly to agent turns: `begin -> await -> apply`
- one auth companion skill that preserves the same session state

That gives ChromeUse a tighter local loop for coding agents working on real apps:

- less startup churn
- less profile confusion
- less fallback search after the user already clicked
- faster handoff from human selection to mutation-ready DOM context

## Technical highlights

- direct CDP runtime, not a screenshot-only or DOM-scrape-only path
- workflow routing keyed by `workflowId` and `captureToken`
- durable selection persistence in `current-selection.json` and `selection-history.jsonl`
- persistent toolbar injection across reloads, same-tab navigation, and same-document navigation
- dedicated profile reuse so auth and inspect stay in the same browser world

## Validation

This milestone was verified with:

- `bash scripts/verify-manifest.sh`
- `bash scripts/test-runtime.sh`
- `node runtime/chrome-use/scripts/inspect_visual_loop.mjs`

## Launch post draft

Pain point: browser agents still lose time between “the user clicked the thing” and “the agent has usable DOM context”.

ChromeUse now fixes that with a dedicated Chrome Inspector workflow:

- first click completes the active inspect workflow immediately
- persistent inspect panel survives reloads and navigation
- dedicated agent profile keeps auth and inspect state isolated from your normal Chrome

Under the hood it is a fast CDP runtime, not a loose browser macro.
`chrome-inspect` and `chrome-auth` work together in the same dedicated session.

GitHub: https://github.com/longbiaochen/chrome-use
