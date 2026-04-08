# `chrome-auth` X draft

## English

We kept iterating on `chrome-use`, and this release is all about `chrome-auth`.

- sign-up and log-in flows differ across web services, so screenshot-driven auth handling is too slow and too brittle
- `chrome-auth` uses direct Chrome CDP to find the real auth entry points, inspect live page state, and move through the flow without relying on screenshots
- it can wait for the signed-in state, detect when human intervention is needed, and keep the rest of the login loop fast and natural

Try it, star the repo, and tell us which auth flow you want `chrome-auth` to handle next: https://github.com/longbiaochen/chrome-use

## 中文

我们继续在迭代 `chrome-use`，这次重点发布的是 `chrome-auth`：不同网页服务的注册和登录流程都不一样，只靠截图去理解页面既慢也不稳；`chrome-auth` 直接利用 Chrome CDP 来搜索和定位真实的鉴权入口、检查页面状态、等待登录结果，并在真正需要的时候明确提示人工介入，让 agent 处理网页服务登录、鉴权和权限相关操作时更自然、更高效，也更不容易卡在复杂流程里。欢迎试用、star、follow，也欢迎直接来提 issue 和 PR：https://github.com/longbiaochen/chrome-use
