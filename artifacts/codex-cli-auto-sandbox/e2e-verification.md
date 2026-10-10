# Codex CLI AUTO_SANDBOX（原生“帮我批准”）页面/端到端验收报告

- 结论（分段）：
  - **页面与真实运行其余部分：通过**。三档显示、AUTO 选择说明、高级沙箱 TOML 冲突置灰与拒绝、正常配置保存/启动、刷新/续聊/停止/切换一致性、桌面/窄屏、REST 侧复核、真实 AUTO 有界行为均符合本轮验收目标。
  - **最终开放：尚未通过**。超出本轮页面验收的约定开放标准仍缺一项真实证据：可重复的“原生自动审阅后仍需人工确认”请求及页面批准/拒绝/过期验证。本轮 4 类安全探针均未触发该分支（见第 6 节），按要求明确记为**未验收**，不以 fixture/模拟请求替代。
- 对象：固定提交 `5cee20ffbec5a274a41d5ee1740bc4978699aff1`；功能基线 `38977277ebe39ae63b3a4481ac03f18ee8e6e71f`；返修前提交 `f52a53b3151ca2e473224c6fb6bea8540f74e8ee`。独立复审见房间消息 `981d8ef4-2ba6-45a8-8786-a82e9c829674`。
- 验收日期：2026-10-10。执行：测试工程师（TeamRun member）。未修改产品代码、未提交/合并/推送/发布。

## 1. 环境与服务归属

| 项 | 值 |
| --- | --- |
| 工作目录 | `/Users/shitian/Work/shitian/agent-tower/.worktrees/at/team/ac159203/main/bdbc143e` |
| HEAD | 开始与结束均为 `5cee20ffbec5a274a41d5ee1740bc4978699aff1`，`git status` 除本轮新增 `artifacts/codex-cli-auto-sandbox/` 外干净 |
| 服务归属 | 新建 workspace service `codex-auto-e2e-qa`（pid 26405，`node packages/server/dist/cli.js`）；`lsof` 确认进程 cwd 即上述工作目录 |
| 端口/数据 | `http://127.0.0.1:17871`，独立 data dir `/tmp/tower-auto-e2e/data`、独立 web dist 副本；未触碰既有 QA 服务 `permission-ui-fix-qa`(17843) |
| 产物来源 | `packages/server/dist` 与固定 SHA 源码的**全新 `tsc` 编译产物逐字节一致**（仅 sourcemap 路径不同）；web 由工作树 dist 副本提供 |
| Codex 隔离 | `CODEX_HOME=/tmp/tower-auto-e2e/codex-home`（0600，仅连接与认证副本，凭据未输出）；`~/.codex/*` mtime 未变化 |
| 环境 | Darwin arm64 / macOS 15.6.1 / Codex CLI 0.161.0 / Node v22.19.0 / agent-browser 0.34.0（session `qa-codex-auto`） |
| 模型连接 | 本机既有 gpt-6-sol OpenAI-compatible 中转连接（与实现者 smoke 相同的 `requires_openai_auth` 形态）；产品默认模型未改 |

## 2. 页面验收结果

| # | 场景 | 结果与证据 |
| --- | --- | --- |
| 1 | Codex Provider 三档显示 | 新建/编辑 Provider 始终显示三项：请求批准、自动同意（沙箱）、自动同意（完全访问）；下拉展开、选中态、详情页“执行权限”一致（截图 01/02/03/11） |
| 2 | AUTO 选择说明 | Codex 专属中文说明可见（下拉项 + 表单说明区）：“Codex 原生自动审阅可能批准工作区外写入或网络访问；部分请求仍需你批准。此档不构成对宿主或 MCP 工具的完整隔离。”（截图 01/02） |
| 3 | 模型未满足时置灰 | 未显式选择 `gpt-6-sol` 时 AUTO 置灰，原因 “Codex CLI auto-review has only been verified with the explicitly selected gpt-6-sol model.”；选模型后变为可选 |
| 4 | 高级沙箱 TOML 禁用原因 | 高级配置写入 `[sandbox_workspace_write]`(含点号键/嵌套 profile) 后，AUTO 立即置灰，原因“使用 Codex 自动同意（沙箱）前，请移除高级配置中的 sandbox_workspace_write。”；鼠标点击与键盘 Enter 均无法选中被禁项（截图 04） |
| 5 | 高级沙箱 TOML 不可保存 | 冲突状态下“保存 Provider”“测试配置”均禁用；页面无法提交。REST 侧同样拒绝（见第 4 节） |
| 6 | 正常配置可保存/启动 | 无冲突配置保存成功，Provider 详情显示自动同意（沙箱）、模型 gpt-6-sol、CODEX_HOME 已配置、无 diagnostics；随后在页面成功启动真实 AUTO 会话（截图 03/11） |
| 7 | 刷新一致性 | 页面刷新/重新打开后 Provider 仍为自动同意（沙箱）、无 diagnostics；运行中会话刷新后状态、消息与已用 token 一致 |
| 8 | 续聊一致性 | 同一原生 thread `01a12430-ed5f-7b80-84dd-61a91f0c1dca` 保持不变，`/runtime` 复核 `executionPermission=AUTO_SANDBOX`、`turnState=IDLE`、`pendingPermissions=0` |
| 9 | 停止一致性 | 运行中点击停止：会话 2s 内进入 CANCELLED，codex 子进程清零；等待 35s 后延迟写入 `should-not-exist.txt` 未出现，无残留进程 |
| 10 | 切换一致性 | 会话内切换 Provider：ASK Provider → `/runtime` 变为 `ASK`；切回 AUTO Provider → 恢复 `AUTO_SANDBOX`；thread 保持；选择器按 Provider 显示所需档位标签 |
| 11 | 历史失效配置显示 | 手工注入的“AUTO + 冲突 TOML”旧 Provider：设置页保留原选择并显示冲突原因（截图 06）；该 Provider 被启动入口过滤，启动请求在 `turn/start` 前失败且无 codex 进程产生（截图 05） |
| 12 | 桌面与窄屏 | 1280×800 与 390×844 均可完整阅读三档说明、展开选择、保存按钮可达；窄屏会话页与 Provider 选择器可操作（截图 07–10） |
| 13 | 非相关项回归 | 输入框上方未重新出现“启动权限”标记；失败/停止会话无卡死，均在 IDLE/终态 |

## 3. 真实 AUTO 有界行为（macOS arm64 / Codex 0.161.0 / gpt-6-sol）

实际 spawn 命令行已复核：
`-c approval_policy=on-request -c sandbox_mode=workspace-write -c approvals_reviewer=auto_review -c sandbox_workspace_write.writable_roots=[] -c sandbox_workspace_write.network_access=false`，后接正常连接参数。

| 场景 | 结果 |
| --- | --- |
| 沙箱内自动执行 | `printf inside > inside-auto.txt` 在 workspace 内自动执行，页面无审批卡片，回复与 token 用量正常 |
| 越界操作由原生自动审阅 | `sandbox_permissions=require_escalated` 写 `/Users/shitian/.tower-codex-auto-e2e-outside/auto-approved.txt` → 原生自动审阅批准，文件内容 `approved`，**全程无 Tower 人工审批卡片** |
| 取消清理 | 运行 `printf running > running.txt; sleep 30; printf finished > should-not-exist.txt`，命令启动后点击停止：2s 内进程清零、延迟写入未发生、会话进入 CANCELLED |
| 下一轮重新确认 | 停止后继续对话成功（`RESUMED_AUTO_OK`），thread 不变，`executionPermission` 仍为 AUTO_SANDBOX；上下文与 token 用量连续 |
| 连接隔离生效 | Provider 高级 TOML 的越界项被置灰的同时，运行时固定 `writable_roots=[]`、`network_access=false`，未出现“仅 UI 置灰但实际放行” |

## 4. REST/API 侧复核（不依赖 UI）

| 请求 | 结果 |
| --- | --- |
| `POST /providers/capabilities`（AUTO + 干净配置） | AUTO `supported/selectable=true` |
| `POST /providers/capabilities`（AUTO + 顶层/点号键/嵌套 profile 冲突） | AUTO `selectable=false`，`CONFLICT` |
| `POST /providers`（AUTO + 冲突 TOML） | 400，`CONFLICT` |
| `PUT /providers/:id`（仅改 executionPermission=AUTO，保留冲突 TOML） | 400，`CONFLICT`，库中仍为原档位 |
| `PUT /providers/:id`（AUTO + 冲突 TOML 字段） | 400，`CONFLICT`，已存配置未被改写 |
| `POST /providers/test` | 200 `{ok:false, stage:'validation', CONFLICT}` |
| `POST /providers/import/preview` | 400，`CONFLICT` |
| 旧/手工写入的 AUTO+冲突 Provider 启动 | 队列在派发前失败、无 codex 子进程；REST 启动不会因 UI 置灰而被绕过 |

## 5. 发现与观察

1. **[需决策] 既有失败会话在 Provider 连接修复后不会自动恢复。** 复现：会话 `25b2ebfd…` 的原生 thread 首次创建于“Provider 尚无显式连接（默认 openai）”状态并返回 401；其后 Provider 改为已验证可用连接，同一会话的续聊仍失败（页面无错误卡片），而为同一 Provider 新建的会话正常完成（`repro.txt`/`repro2.txt`）。根因未定位（疑似恢复原生 thread 时沿用首次记录的连接/模型路由），**非 AUTO 专属**。建议：切换/修复连接后对既有 transport 采取明确的新建或迁移流程，而不是无限复用。
2. **[观察] AUTO 下原生自动审阅会批准破坏性越界操作。** 探针 `rm -rf` 一个工作区外的一次性目录被原生自动批准；当前 UI 说明只提到“越界写入/网络访问”。建议在说明或文档中补充“含破坏性操作”，并依赖外层隔离（与计划中受限用户必须提供可执行外层边界的结论一致）。
3. **[观察] 启动入口与配置页的失效提示不一致。** 带冲突配置的 Provider 在“新对话”选择器中被静默过滤（结果正确、fail-closed），但入口未显示阻止原因；配置页列表仍标注 “Available”（原因只在详情页可见）。计划 §7 期望启动入口能看到所需档位与阻止原因。
4. **[观察，既有] 失败会话的会话页不显示失败原因**（本机曾显示一次 401，后续失败仅显示“失败/已停止”）；服务日志存在既有 `[MsgStore:getSnapshot] full patch apply failed … error_message` 噪声。非本次改动引入。

## 6. 专项缺口：「自动审阅后仍需人工确认」

按约定专项尝试 4 类真实探针，均**未**产生需要人工确认的原生请求（全部由原生自行批准/处理，页面与 `/runtime` 的 `pendingPermissions` 始终为空）：

| 探针 | 结果 |
| --- | --- |
| 越界升级写入（`require_escalated`，工作区外文件） | 原生自动审阅批准，无卡片 |
| `request_permissions` 请求越界写权限 | 原生自行批准（对话记录出现 Approve/Deny 询问并被自动解析），无卡片 |
| 越界破坏性命令（`rm -rf` 一次性目录） | 原生自动审阅批准，无卡片 |
| 被沙箱阻断的回环网络请求（`curl http://127.0.0.1:17899`） | 原生自动审阅批准，服务端实际收到请求（200），无卡片 |

因此，本轮**无法**在页面验证“批准 / 拒绝 / 过期失效”的人工审批闭环；该项明确记为**未验收**。未使用 fixture 或模拟请求替代，也未放宽开放标准。

## 7. 验证边界与剩余限制

- 仅验证 Darwin arm64 / Codex 0.161.0 已验证构建（native sha256 `12ac11d2…93e6de`）；其他平台、版本、Electron、自定义 wrapper/PATH 覆盖未验证。
- 真实模型仅 `gpt-6-sol` + 本机既有中转连接；其他模型、账号类型与连接形态未验证。
- 未执行任何外部网络副作用操作；网络探针仅限本机回环。
- MCP/宿主工具审批类别未覆盖（隔离 `CODEX_HOME` 未配置 MCP server）；Computer Use 类应用审批不在本档范围。
- “自动审阅后仍需人工确认”分支缺真实证据（见第 6 节）；该缺口决定最终开放结论。

## 8. 截图证据

| 文件 | 说明 |
| --- | --- |
| `01-permission-dropdown-auto.png` | 三档下拉展开，含 Codex 专属 AUTO 说明 |
| `02-provider-form-auto-selected.png` | AUTO 已选中的新建表单 |
| `03-provider-saved-auto.png` | 保存后详情：执行权限=自动同意（沙箱） |
| `04-auto-conflict-disabled.png` | 高级 TOML 冲突：AUTO 置灰 + 原因，保存/测试禁用 |
| `05-legacy-start-rejected.png` | 历史失效 Provider 启动失败（会话页） |
| `06-legacy-provider-diagnostic.png` | 历史失效配置在设置页保留原值并显示原因 |
| `07-narrow-provider-detail.png` | 390×844 Provider 详情 |
| `08-narrow-permission-dropdown.png` | 窄屏三档下拉与说明可读 |
| `09-narrow-permission-selected.png` | 窄屏选中 AUTO |
| `10-narrow-conversation.png` | 窄屏会话与真实工具调用结果 |
| `11-desktop-provider-detail-auto.png` | 桌面刷新后 Provider 仍为 AUTO（一致性） |
