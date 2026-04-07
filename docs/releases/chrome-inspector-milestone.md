# `chrome-inspect` milestone

chrome-use now ships a full inspect-first workflow for coding agents, built to turn user clicks into structured agent context in real time.

## What shipped

- `chrome-inspect` now supports a persistent in-page inspect panel in the dedicated agent profile
- the first real page click completes the active inspect workflow immediately
- the selected page area is written back as structured `page`, `element`, and `content` context instead of requiring pasted links or screenshots
- `inspect-capture await` now uses one long-lived daemon wait instead of layered reconnect/search fallback during the normal path
- the saved-selection panel now shows `Selected`, `Content`, `Page`, and `Element`
- `inspect-capture latest` can recover the most recent persisted selection without reopening Chrome
- `chrome-auth` remains the companion skill for login and authorization in the same dedicated browser session

## Why this matters

Most browser tools are either:

- generic automation layers, or
- generic debugging layers

chrome-use is narrower and more opinionated:

- one dedicated agent profile, separate from the default Chrome profile
- one dedicated remote-debuggable Chrome runtime
- one inspect workflow that maps cleanly to agent turns: `begin -> await -> apply`
- one auth companion skill that preserves the same session state

That gives chrome-use a tighter local loop for coding agents working on real apps:

- less startup churn
- less profile confusion
- less fallback search after the user already clicked
- faster handoff from human selection to mutation-ready DOM context
- no need to restate page context in chat after the operator has already pointed at the right place
- durable persisted selections that make the workflow easier to trust and recover

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

## Launch message stack

Use this stack for launch-facing copy:

1. pain point: what is still slow, flaky, or broken in the status quo
2. shipped capability: what `chrome-use` now does
3. user payoff: why the workflow is faster, cleaner, or more complete
4. credibility proof: dedicated agent profile, direct CDP runtime, shared auth + inspect session
5. CTA: try it, star it, follow it, and open PRs

## Approved X templates

### English template

We just shipped `chrome-inspect` in `chrome-use`.

- faster handoff from user click to mutation-ready DOM context
- full inspect + auth workflow in one dedicated Chrome session
- direct CDP runtime with a dedicated agent profile, so the flow stays fast and predictable

Try it, star the repo, and tell us what to build next: https://github.com/longbiaochen/chrome-use

### Chinese template

`chrome-inspect` 已经在 `chrome-use` 里正式发布：现在浏览器里的点选可以更快回到 agent 手里，直接变成可编辑的 DOM 上下文，而且 `chrome-inspect` 和 `chrome-auth` 会在同一个 dedicated agent profile 里跑完整流程，既快又稳，欢迎试用、star、follow，也欢迎直接来提 issue 和 PR：https://github.com/longbiaochen/chrome-use
