# chrome-use

[![English version](https://img.shields.io/badge/English%20version-README-blue)](./README.md)
[![中文版](https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E7%89%88-README.zh--CN-red)](./README.zh-CN.md)

> `chrome-use` 是一套给 coding agent 用的专用 Chrome 工作流。
> 它通过一个持续存在的专用浏览器 session，把“人点页面”和“agent 接着做事”这两段流程接成一个稳定闭环。
> 它对外只提供两个聚焦的 skills：`chrome-inspect` 负责把真实页面选区交回 agent，`chrome-auth` 负责用 direct CDP 在真实网页里定位并推进登录流程，而且不是靠截图理解页面。

适合正在用 coding agent 做 Web 开发的人：产品工程师、基础设施工程师、工具作者，以及任何希望把浏览器协作链路做得更快、更稳，而且不想再靠复制链接、截图和人工解释页面位置的人。

## `chrome-use` plugin

`chrome-use` 不是一个泛化浏览器包装层，而是一套本地优先的浏览器 runtime，加上两个安装即用的技能，围绕同一个严格约束展开：

- 一个独立的 `agent-profile`，与默认 Chrome profile 分离
- 一个固定的远程调试入口 `127.0.0.1:9223`
- 一个可复用的浏览器 session，在 inspect、auth 和后续步骤之间持续共享

这样做的收益很直接：

- 用户在真实页面上点一次，agent 拿到的是结构化上下文，而不是截图
- agent 可以在同一个专用浏览器里完成登录，不用每次重新起一个临时浏览器
- 页面状态、cookie 和登录态能跨回合保留，后续工作可以直接接着做

## `chrome-inspect`

`chrome-inspect` 是 `chrome-use` 里偏 inspect 的 skill：用户在真实页面上点一次目标，agent 就能在同一回合拿到可直接修改页面的结构化上下文。

![`chrome-inspect` 演示](./docs/media/chrome-inspect-demo.gif)

_演示：打开页面内的 inspect 面板，清楚地看到进入 inspect 模式的点击过程，再选中真实目标，把结构化页面上下文回传给 agent，而不是丢一张截图。_

在实现上，`chrome-inspect` 会把面板常驻在 dedicated agent browser 里，持久化最近一次有效选择，并返回 `selectedElement`、页面信息、片段和位置等后续 DOM 修改真正需要的上下文。

## `chrome-auth`

`chrome-auth` 是 `chrome-use` 里偏 auth 的 skill：它通过 direct Chrome CDP 在真实页面里搜索、定位并推进注册或登录流程，而不是把页面当作一张图片去猜。

![`chrome-auth` 演示](./docs/media/chrome-auth-demo.gif)

_演示：打开本地 auth fixture，定位真正的 `Sign up` 入口，帮 `John Appleseed` 完成注册，进入登录页后再用同一账号登录，在 dedicated agent browser 里把 auth 闭环跑完。_

在实现上，`chrome-auth` 运行在同一个 dedicated session 中，支持枚举和切换标签页、读取结构化快照、等待状态变化，并直接通过 CDP 执行 click / fill / type，而不是回退到靠截图做页面理解。

## General

## 🧠 架构

chrome-use 使用一个专用浏览器运行时，而不是直接接管你平时使用的 Chrome：

- 专用 profile 目录：`~/.chrome-use/agent-profile`
- 专用 state 目录：`~/.chrome-use/state`
- 专用 debug endpoint：`http://127.0.0.1:9223`
- 基于 CDP 的专用 remote debugging 会话

这样设计的意义在于：

- 默认 Chrome profile 完全不受影响
- 鉴权状态可以稳定复用，跨回合保留
- inspect 与 auth 共用同一个浏览器世界
- agent 可以保持一个低开销的高速连接，而不是反复启动新浏览器
- 运行时可以基于 `workflowId`、`captureToken` 和绑定的 `targetId` 对选择事件和工作流状态做确定性路由
- 用户点选不会丢在一次性聊天消息里，而是会进入可恢复的持久化状态

在 macOS 上，启动器会尽量让专用 Chrome 实例留在后台，避免 agent 操作抢焦点。专用 `agent-profile` 在 macOS 上必须保持单窗口；其他 profile 下的 Chrome 窗口可以同时存在。

## 🥊 chrome-use 的定位

可以把 chrome-use 理解成构建在 Chrome 之上的一层有明确取舍的技能层。

| 工具 | 擅长什么 | chrome-use 更强在哪里 |
| --- | --- | --- |
| Chrome DevTools MCP | 通用浏览器调试、自动化、trace、network、console、screenshot | chrome-use 增加了 inspect-first 的人机协作工作流、持久页面面板、专用 profile 约束，以及可直接交给修改工具的 selection handoff |
| `agent-browser` | 快速 CLI 自动化，以及基于 accessibility tree / snapshot 的浏览器控制 | 当操作者需要在真实 DOM 上直接点选目标，并把精确页面上下文交回 agent 时，chrome-use 更强 |
| `browser-use` | 高层浏览器 agent、云端浏览器基础设施，以及更广义的自动化框架 | 对于需要精确 inspect、稳定鉴权以及尽量少运行时中间层的 coding-agent 工作流，chrome-use 更轻、更本地优先 |

chrome-use 刻意比这些工具更窄。窄反而是优势：它不是试图包办所有浏览器场景，而是专门优化实时 inspect / edit / auth 闭环。

## 📦 Public skills

出于设计约束，对外只暴露两个公共技能名：

- `chrome-inspect`
- `chrome-auth`

`chrome-use` 自身不会作为独立 skill 或命令暴露。`/chrome` 和 `/inspect` 则被刻意保留，不作为单独 selector 提供。

对于 `chrome-inspect`，当设置了 `CHROME_INSPECT_PROJECT_ROOT`，或当前工作目录 / git root 能被推断为本地项目时，启动器会在打开 Chrome 前自动启动并定位本地项目的 web app。

两个公共技能都支持显式调用，也支持隐式触发。

## 📝 发布说明

- [`chrome-auth` 发布说明](./docs/releases/chrome-auth-release.md)
- [`chrome-inspect` milestone release notes](./docs/releases/chrome-inspector-milestone.md)

## Fast install

通用安装目标：

```bash
git clone https://github.com/longbiaochen/chrome-use.git
cd chrome-use
bash install/install-agent-skill.sh
```

Codex 原生安装目标：

```bash
git clone https://github.com/longbiaochen/chrome-use.git
cd chrome-use
bash install/install-codex-skill.sh
```

安装后暴露的 skills 为：

- `~/.agents/skills/chrome-inspect`
- `~/.agents/skills/chrome-auth`
- `~/.codex/skills/chrome-inspect`
- `~/.codex/skills/chrome-auth`

`chrome-use` 本身不会作为独立 skill 或命令暴露。共享运行时代码位于 `runtime/chrome-use/`。

## Direct CDP workflows

`chrome-inspect` 使用直接 CDP capture 命令：

```bash
bash skills/chrome-inspect/scripts/open_url.sh "http://127.0.0.1:8000/"
skills/chrome-inspect/scripts/inspect-capture begin --project-root "/path/to/repo"
skills/chrome-inspect/scripts/inspect-capture await --workflow-id "<workflowId>"
```

`inspect-capture begin` 现在会同时返回 `workflowId` 和绑定后的 `targetId`，后续 `await` / `apply` 会固定落在同一个标签页上，即使同一个 debug endpoint 上还有别的 agent 线程。

或使用一键辅助脚本：

```bash
skills/chrome-inspect/scripts/inspect_select_element.sh "/path/to/repo"
```

`chrome-auth` 则通过同一个专用 profile 上的直接 CDP auth 辅助命令工作：

```bash
bash skills/chrome-auth/scripts/open_url.sh "https://example.com/login"
skills/chrome-auth/scripts/auth-cdp status
skills/chrome-auth/scripts/auth-cdp list-pages
skills/chrome-auth/scripts/auth-cdp bind-page --page-id "<page-id>"
skills/chrome-auth/scripts/auth-cdp select-page --page-id "<page-id>"
skills/chrome-auth/scripts/auth-cdp snapshot --mode a11y --binding-id "<binding-id>"
skills/chrome-auth/scripts/auth-cdp screenshot --output /tmp/auth.png
```

如果是多标签页或多 agent 并发的 auth 自动化，优先先执行一次 `bind-page`，随后所有 DOM 操作都传 `--binding-id`，不要再依赖 endpoint 级别的默认 selected page。

## Client support

| Client | 安装路径 | 状态 | 说明 |
| --- | --- | --- | --- |
| Codex | `~/.agents/skills/` 或 `~/.codex/skills/` | 支持最好 | 包含可选的 `agents/openai.yaml` 元数据；公共 skills 可隐式触发 |
| Claude-compatible clients | `~/.agents/skills/` | 兼容 | 客户端特定包装层可能使用目录级链接 |
| Generic skills-compatible agents | `.agents/skills/` | 兼容 | 使用纯 `SKILL.md` 加共享运行时包装脚本 |

## Repository layout

公共 skills：

- `skills/chrome-inspect/SKILL.md`
- `skills/chrome-inspect/agents/openai.yaml`
- `skills/chrome-auth/SKILL.md`
- `skills/chrome-auth/agents/openai.yaml`

共享运行时：

- `runtime/chrome-use/scripts/ensure_profile.sh`
- `runtime/chrome-use/scripts/doctor.sh`
- `runtime/chrome-use/scripts/open_url.sh`
- `runtime/chrome-use/scripts/ensure_project_webapp_running.sh`
- `runtime/chrome-use/scripts/project_webapp_entry.sh`
- `runtime/chrome-use/scripts/inspect_capture.mjs`
- `runtime/chrome-use/scripts/inspect_runtime.mjs`
- `runtime/chrome-use/scripts/auth_cdp.mjs`
- `runtime/chrome-use/scripts/cleanup.sh`

## Defaults

这个公开仓库默认保持 client-neutral：

- profile 目录：`~/.chrome-use/agent-profile`
- state 目录：`~/.chrome-use/state`
- debug URL：`http://127.0.0.1:9223`

运行时契约：

- 只能有一个 Chrome 进程拥有 `~/.chrome-use/agent-profile`
- 该进程必须暴露 `127.0.0.1:9223`
- 在 macOS 上，该专用 profile 必须只有一个 Chrome 窗口
- 后续启动必须复用同一个实例，并在该实例中打开新标签页

可通过环境变量覆盖：

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-use-profile"
export CHROME_USE_DEBUG_PORT="9223"
```

`CHROME_USE_DEFAULT_WEBAPP_URL` 会在 `about:blank` 之前作为可选 URL fallback。
对于 `/chrome-inspect`，可以设置 `CHROME_INSPECT_PROJECT_ROOT`（例如 `/Users/longbiao/Projects/home-page`），让辅助脚本自动定位该项目的 docs web app 入口。
如果启用了 inspect auto-start 且缺少该环境变量，共享运行时会先从当前工作目录或 git root 推断项目根目录，再决定是否退回 `about:blank`。
当设置 `CHROME_INSPECT_AUTO_START_WEBAPP=1` 时，`open_url.sh` 也会在附加 Chrome 前尝试启动对应的本地 web app。
这条 auto-start 路径仅在目标 URL 被解析为对应本地项目的 `localhost` 或 `127.0.0.1` 地址时生效。
如果预期的 preview 端口已经在监听，但目标 URL 仍不可达，`open_url.sh` 会直接报出阻塞监听信息，而不是再启动第二个服务。

如果你的 Codex 环境已经统一使用自定义专用 profile 路径：

- 设置 `CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-use-profile"`，或
- 在本地 shell / profile 里预先导出这个环境变量

## Codex setup notes

本仓库中的安装示例只安装前面提到的两个公共 skills，不会暴露 `/chrome`。两个公共 skills 都可以显式调用，也可以隐式触发。

对于 `/chrome-inspect` 的默认流程：

1. 在聊天中运行 `/chrome-inspect`。
2. 让 `scripts/open_url.sh` 打开 Chrome；当配置了 `CHROME_INSPECT_PROJECT_ROOT` 或能从当前仓库推断出本地项目时，它会优先自动启动本地 web app。
   如果专用 profile 已经在运行，命令会在同一实例中复用并打开新标签页，而不是创建第二个专用窗口。
   如果只是复用已存在的匹配标签页，默认不会主动把该标签切到前台；只有显式设置 `CHROME_USE_ACTIVATE_EXISTING_TARGET=1` 时才会 activate。
3. 使用 `scripts/inspect-capture begin --project-root "<repo>"` 启动 capture，并保存返回的 `workflowId` 和 `targetId`。
4. 确认 inspect mode 已经 armed，然后在 Chrome 中点击目标元素。
   页面面板在进入时就应以 idle ready 状态注入，主按钮显示 `Press this button to inspect`。
   操作者点击该按钮后，inspect mode 才应真正激活，按钮文字变为 `Inspecting`。
   成功点击目标元素后，inspect mode 应自动退出，主按钮恢复为 `Press this button to inspect`，面板保持可见。
   同一个面板内应展示 `Selected`、`Content`、`Page`、`Element` 四部分保存后的选择信息。
   页面应立即恢复可交互；面板也应跨同标签导航、刷新、同文档导航以及专用 profile 内其他标签持续存在。
   在已选择或 idle 状态下，再点击 `Press this button to inspect` 必须立即重新进入 inspect mode，无需先创建新 workflow。
5. 调用 `scripts/inspect-capture await --workflow-id "<workflowId>"`。
6. 只有当结果属于当前 `workflowId`，且明显来自当前 capture cycle 的新点击时，才可视为有效。
   如果 `await_selection` 过快返回旧上下文，应重启 capture，而不是把它当成新选择展示。
7. 等到返回 `phase=awaiting_user_instruction`；agent 不应在拿到这份选择结果之前结束当前回合。
8. 确认 agent 已报告足够的 selected-element 细节，避免再次查找：
   `summary`、标签 / `nodeName`、`selectorHint`、`id`、`className`、`ariaLabel`、页面 URL、
   `position`，以及 `selectedElement.snippet` 或同等元素内容。
9. 回复具体的编辑指令。
10. 调用 `scripts/inspect-capture apply --workflow-id "<workflowId>" --instruction "<user instruction>"`。
11. 确认返回 `phase=ready_to_apply`。
    `apply` 只会结束 capture workflow，不应把 toolbar 从页面移除。

## Inspect toolbar contract

inspect 面板是一个持久化的浏览器层 affordance，而 capture 是叠加在它上面的单次工作流。

- 每次新 capture 开始时，面板应已可见但处于 idle 状态。主按钮显示 `Press this button to inspect`。
- 专用 profile 中的每个页面标签都应默认收到同一个 idle 状态的面板。
- 如果操作者点击 `Press this button to inspect`，inspect mode 应立即启动，主按钮变为 `Inspecting`。
- 如果操作者选择了一个元素，inspect mode 应立即停止，面板进入 saved-selection 状态。
- 在 saved-selection 状态下，同一个面板中应显示 `Selected`、`Content`、`Page`、`Element`。
- 在 saved-selection 或 idle 状态下，再次点击 `Press this button to inspect` 必须立即重新进入 inspect mode，不能要求第二次点击，也不能要求先新建 workflow 才让 UI 响应。
- 面板必须跨同标签导航、刷新和同文档导航持续存在。
- 最近一次成功选择必须被持久化，这样即便原始等待超时，下一回合仍可恢复它。
- 选择历史也必须追加写入 `events/selection-history.jsonl`，不能只覆盖 `current-selection.json`。
- 当新的 inspect session 没有显式 URL 时，运行时应优先选择当前最新的页面标签，而不是在旧的已附加标签之间游走。

## Agent behavior

Codex 的推荐行为是先 arm inspect mode，然后保持等待操作者点击，而不是过早返回一个 timeout 风格消息。

- 默认行为：使用 `begin` 后立刻调用 `await`，并保持回合开启，直到收到新的选择结果。
- 这样不会显著增加 token 消耗，因为等待发生在运行时进程里，而不是 assistant 文本流里。
- fallback 行为：只有当客户端确实无法可靠维持长时间 tool call 时，才在 arm inspect mode 之后立即返回，并明确告诉用户先去点击页面，再回来继续。
- 不要把“等一会儿然后超时”当作默认 UX。要么持续等待，要么立即返回并清楚说明下一步怎么做。

对于 `/chrome-auth`，当已知目标 URL 时直接附上 URL 命令，然后通过同一个专用 profile session 里的 `scripts/auth-cdp` 完成状态检查、页面切换、结构化快照、截图、元素查找、点击、填充、输入、等待和按键操作。

如需从本仓库验证打包、命令可用性和 fallback 行为，请运行：

```bash
bash scripts/verify-manifest.sh
```

如需验证 dedicated-profile 运行时契约（使用 mocked process、endpoint 和 window state），请运行：

```bash
bash scripts/test-runtime.sh
```

如需运行本地闭环的 compact inspect toolbar 可视化验证，请运行：

```bash
node runtime/chrome-use/scripts/inspect_visual_loop.mjs
```

该脚本会在一个确定性的本地 fixture 上打开专用浏览器，验证 idle `Press this button to inspect` / active `Inspecting` 的面板契约，检查第二个标签页是否也收到同样的 idle 面板注入，检查选择后是否自动退出 inspect mode，验证统一的 saved-selection 面板主体，确认无需新 workflow 也能手动重新进入 inspect mode，验证 JSONL history 会随选择追加，确认导航后面板仍保持注入，并把截图写到一个临时输出目录。

## Platform support

- macOS：已测试
- Linux：包含脚本化默认值
- Windows：尚未完成端到端测试；已规划，但不宣称支持

## Docs

- [Codex install and adapter notes](./docs/clients/codex.md)
- [Generic `.agents/skills` install](./docs/clients/generic.md)
- [Claude-compatible install notes](./docs/clients/claude.md)
