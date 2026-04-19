# `chrome-use` Chrome for Testing runtime launch draft

## English

Chrome 136 changed the rules for remote debugging on the default Chrome profile, so we moved `chrome-use` onto a managed `Chrome for Testing` runtime.

- no more app shim, renamed Chrome bundle, or Dock-level maintenance
- managed browser download from the official CfT feed, with a dedicated browser-data dir and the same CDP endpoint on `127.0.0.1:9223`
- `chrome-inspect` + `chrome-auth` still share one stable agent browser world, just without depending on the user's real Chrome session

Try it here: https://github.com/longbiaochen/chrome-use

## 中文

Chrome 136 之后，默认 Chrome profile 已经不再适合继续走旧的 remote debugging 路径，所以我们把 `chrome-use` 的 runtime 切到了托管的 `Chrome for Testing`：不再需要 app shim、改名后的 Chrome 包和 Dock 级维护，安装时直接从官方 CfT 源下载浏览器，落到独立的 browser-data 目录上，继续复用同一个 `127.0.0.1:9223` CDP 入口，同时保持 `chrome-inspect` 和 `chrome-auth` 共享同一个稳定的 agent browser 世界，但不再依赖用户真实 Chrome 会话。欢迎试用、star、follow，也欢迎直接提 issue 和 PR：https://github.com/longbiaochen/chrome-use
