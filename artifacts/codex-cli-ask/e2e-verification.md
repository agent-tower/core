# Codex CLI ASK 浏览器端到端验收报告

- 结论：**通过**。本轮页面/端到端验收未发现需要返修的缺陷；审批接入的成功与失败路径、停止/续聊、刷新恢复、能力置灰与非法配置拒绝均符合实现说明。
- 验收对象：`8e90de935a959a2e705777bbb8b86bab12923526`（范围 `bd55f89..8e90de93`，含输入框权限标记移除的保留）。
- 验收日期：2026-10-09。执行：测试工程师（TeamRun member）。

## 服务版本与环境

| 项 | 值 |
| --- | --- |
| 目录 | `/Users/shitian/Work/shitian/agent-tower/.worktrees/at/team/ac159203/main/bdbc143e` |
| HEAD | `8e90de935a959a2e705777bbb8b86bab12923526`；开始与结束均为该 SHA，`git status` 除本轮新增 `artifacts/codex-cli-ask/` 外干净 |
| 服务来源 | 该工作树干净 HEAD 上的 `tsc` 全新构建产物 `/tmp/tower-codex-ask-e2e/packages/server/dist/cli.js`（sha256 `9ca20f0c…8e769f`），未使用工作树内可能滞后的 `dist/` |
| 关键新代码 | `dist/runtime/codex-cli-control.js` sha256 `fb923773…143b81`；含 `writeStdin`、turn/start 绑定等收尾改动 |
| Web | `packages/web/dist`（18:54 构建）；`bd55f89..HEAD` 对 `packages/web`、`packages/shared` 无改动；bundle 中不存在“启动权限”字符串 |
| 端口/数据 | `http://127.0.0.1:17861`，独立 data dir/SQLite/工作树/端口；Codex 使用独立 `CODEX_HOME` 副本（仅配置与认证副本，权限 0600，未输出凭据） |
| 环境 | Darwin arm64 / macOS 15.6.1 / Codex CLI 0.161.0 / Node v22.19.0 / agent-browser 0.34.0 |
| 模型连接 | 本机既有 xcode OpenAI-compatible 连接，隔离配置内使用 `gpt-6-sol`；产品默认模型未改 |
| 隔离确认 | QA 服务 `permission-ui-fix-qa`(17843) 未重启/未占用，验收期间 HTTP 200；`~/.codex/config.toml`、`auth.json` mtime 未变化 |

服务启动后 `GET /api/providers/capabilities` 对 CODEXXX CLI 返回 ASK `supported/selectable=true`、AUTO_SANDBOX `CAPABILITY_UNVERIFIED`；实际 spawn 命令行确认 `approval_policy=on-request`、`sandbox_mode=workspace-write`、`approvals_reviewer=user` 与 `app-server --listen stdio://`，证明运行的是新实现而非旧后端。

## 页面验收场景与结果

真实模型（gpt-6-sol）会话 `fd742b3f-a1f3-4f58-8434-4dff36818d00`，原生 thread `01a12068-aa2e-7041-ac04-c5a8066c2361`（全程保持不变）。

| # | 场景 | 结果与证据 |
| --- | --- | --- |
| 1 | 配置并保存显式 Codex CLI ASK | Provider 编辑器三档同屏：请求批准可选、自动同意（沙箱）禁用并给出“此接入方式的原生沙箱档尚未核实”，完全访问可选；选择 ASK 保存成功，详情页显示“执行权限：请求批准”，环境变量 `CODEX_HOME` 已配置；API 与页面一致，无 diagnostics |
| 2 | 命令审批：批准才执行 | 页面出现“需要授权 / Codex command approval”卡片及命令详情；答复前目标文件不存在；点击“本次批准”后 `action-1.txt` 内容 `approved`，本轮完成回到 IDLE |
| 3 | 命令审批：拒绝不执行 | 第二轮卡片点击“本次拒绝”后目标文件未创建，turn 正常结束（无错误） |
| 4 | 已结束旧请求与重复答复 | 对已解决 request `7d4af7f8…` 再次提交 `allow_once` 返回 HTTP 409 `Permission request is no longer active`，未产生任何文件效果 |
| 5 | 工作区外文件修改 | `apply_patch` 目标位于 `/Users/shitian/.tower-codex-ask-e2e-outside/`（cwd 与 /tmp 之外）；页面显示 “Codex file change approval” 与路径，答复前不存在；批准后文件内容 `approved` |
| 6 | 等待中刷新恢复同一请求 | 待审批 request `b97bad85…` 时刷新页面并重新打开任务，`GET /runtime` 仍是同一 requestId，卡片恢复；再次批准后 `action-3.txt`=`refreshed` |
| 7 | 等待审批时停止 → 继续对话 | 待审批时点击停止：turn 立即 IDLE、pending 清空、卡片消失；旧 request 再答复返回 409 `PERMISSION_NOT_FOUND`，`action-5.txt` 未创建；随后新消息再次进入审批并成功执行（`action-6.txt`=`after-stop`），旧按钮已失效、新轮可审批 |
| 8 | 执行中停止（启动标记） | 批准后 `running-7.txt` 在约 1s 内写入 `RUNNING`，确认命令已实际启动；点击停止后旧 wrapper 与 native codex 子进程 3s 内消失（服务进程下无残留子进程）；等待 36s 后 30 秒延迟的 `action-7.txt` 始终未出现 |
| 9 | 停止后清理先于新 started（页面观测） | 停止后检查服务进程树无 codex 子进程残留，随后新轮成功启动并完成；精确的事件顺序断言沿用既有真实进程 fixture，本轮未重复 |
| 10 | thread/resume 与 usage | 多轮共用同一 native thread；停止执行后新轮回复 `RESUMED-OK`，页面显示“已使用: 19.7K tokens”；turn 均落到 IDLE，任务进入“待审查”，未卡永久等待 |
| 11 | 能力/选择原因一致性 | 页面禁用项原因与 `POST /api/providers/capabilities` 草稿结果一致（`CAPABILITY_UNVERIFIED`）；ASK 禁用时未自动升级为完全访问 |
| 12 | 非法直接启动稳定拒绝 | 自定义命令 Provider 保存返回 400 `CAPABILITY_UNVERIFIED`；带 `baseCommandOverride`/`additionalParams` 的草稿能力 ASK `selectable=false`；对工作 Provider 更新附加危险参数返回 400；不存在的 Provider 创建会话返回 400 `Provider not found` |
| 13 | 输入框上方标记移除保留 | 任务详情与移动端输入框上方无“启动权限：请求批准”文本（页面 DOM 计数 0），无遗留空白；审批卡片与 Provider 选择器可正常使用 |
| 14 | 桌面与窄屏 | 1280×800 桌面与 390×844 窄屏均能完整显示审批卡片、命令详情与两个按钮，并实际完成批准/拒绝操作 |

## 缺陷与观察

- 未发现需要返修的功能、交互或状态缺陷。
- 观察（不阻塞、且非本次改动引入）：任务详情输入框旁的停止按钮为纯图标，无 `aria-label`/`title`，读屏可访问性较弱；移动端输入框占位文案为英文 “Message Agent...”，与中文界面混用。
- 日志中出现的 `[MsgStore:getSnapshot] full patch apply failed … value property is not present` 属既有错误条目渲染噪声，未影响本轮页面状态与审批结论。

## 验证边界与缺口

- 真实模型证据仅 `gpt-6-sol` + 本机 xcode 兼容连接；未复测 `gpt-6.1-sol`（已知 503/no channel），未改产品默认模型。
- 仅验证 Darwin arm64 / Codex 0.161.0 已验证构建；其他平台/版本、Electron、自定义 wrapper 未验证。
- 独立问答/计划/MCP elicitation/持久资源授权未开放，本轮未执行代答；FULL_ACCESS 与 ACP 未扩展为本轮验收目标。
- 停止/取消/替换的完整进程矩阵由既有真实进程 fixture 覆盖，本轮只做页面可观测的启动标记、延迟效果与子进程残留检查。

## 截图证据

| 文件 | 说明 |
| --- | --- |
| `01-provider-permission-selector.png` | 三档选择器：ASK 可选、AUTO_SANDBOX 置灰及原因 |
| `02-provider-saved-ask.png` | 保存后 Provider 详情：执行权限=请求批准 |
| `03-pending-command-approval.png` | 桌面命令审批卡片与无权限标记的输入框 |
| `04-refresh-restored-approval.png` | 刷新后恢复的同一审批请求 |
| `05-outside-workspace-file-approval.png` | 工作区外 fileChange 审批卡片 |
| `06-desktop-conversation-no-permission-label.png` | 桌面会话（含 usage、无“启动权限”标记） |
| `07-narrow-home.png` | 窄屏首页 |
| `08-narrow-approval-card.png` | 窄屏审批卡片可读、按钮可操作 |
| `09-provider-selector.png` | Provider 选择器可用 |
