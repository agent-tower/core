# Claude CLI「请求批准（ASK）」页面重验（第二轮）

- 日期：2026-10-09
- 结论：**通过**。核心 D1（等待审批时页面停止）在固定 SHA 上不复现；批准/拒绝/续聊/刷新恢复及草稿能力更新全部通过。
- 固定基线：`d3e215a4e7fb4a2a8d686f25c760c5044c1cb537`（工作区干净；未 checkout、未提交、未改产品源码；本轮只新增本报告、复验截图与临时环境）。
- 重验对象：修正结果 `38a5c613-1801-4083-976d-054784a2d826` 与 [acceptance-corrections.md](acceptance-corrections.md)。
- 保留：上一轮 [e2e-verification-report.md](e2e-verification-report.md) 与 `e2e/01..04c` 截图原样未改（mtime 仍为 16:25–16:31）。
- 代码审查由审查工程师并行进行，本报告只覆盖真实页面/接口验证。

## 1. 环境与归属证据

| 项 | 值 |
| --- | --- |
| Tower 服务 | workspace service `claude-ask-reverify`：`node packages/server/dist/cli.js --host 127.0.0.1 --port 17862 --data-dir /tmp/tower-claude-ask-reverify/data --web-dir <worktree>/packages/web/dist` |
| 服务归属 | `lsof -p 65204` cwd = 本 worktree 根；listener PID 65233；独立新建 SQLite；启动 09:01:50Z；端口 17862 为本轮专用 |
| 构建来源 | 本轮在固定 SHA 上重跑 `shared → server → web` 构建（exit 0）；`git rev-parse HEAD` = `d3e215a4…`，构建前 `git status` 干净 |
| dist 版本标记 | server：`cli-duplex-channel`/`process-launch` 含 `output_consumed`、`agent-pipeline` 含 `outputEnded`/`pendingExitCode`、`cli-driver` 含 duplex 10s 输出宽限；web：bundle 含 `POST /providers/capabilities`，`ConversationPage` 停止 guard 已无 `isRunning` 前置 |
| Claude 原生 | `claude 2.1.293 (Claude Code)`，Darwin arm64，SHA-256 `4e21122a…105e`，与已验证构建一致 |
| 浏览器 | `agent-browser 0.34.0`，独立 session `tower-ask-reverify-1009`（结束仅 close 本 session，未用 `close --all`） |
| 认证隔离 | 仅把 `~/.claude/settings.json` 的 `ANTHROPIC_*` 复制到独立 `CLAUDE_CONFIG_DIR`（临时目录，0600）；Provider env 只写该目录路径。未改全局配置、未输出凭据 |
| 模型 | 兼容 Anthropic 端点 `deepseek-v4-pro`（与实现者 smoke 同一组合） |
| 现有 QA | `permission-ui-fix-qa`（PID 34538 / runtimeInstanceId `caa84444-…` / 端口 17843）全程未重启或改动；测试前后均返回 200，PID 未变 |

## 2. 核心 D1：新对话出现审批卡片后不刷新点击停止

从 UI 完整新建对话进入（`/conversations` → 新对话 → Provider「Claude CLI ASK Reverify」→ 发送任务），全过程未刷新。

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| 真实审批卡片 | 通过 | 对话 `892265fc…` / session `7319826e…`；runtime `AWAITING_PERMISSION`、pending request `ec7049f3…`；页面显示「启动权限：请求批准 / 需要授权 / Bash / command: printf 'd1-stop-must-not-exist' > d1-stop-target.txt / 本次批准 / 本次拒绝」；截图 `e2e/05-d1-pending-before-stop.png` |
| 不刷新直接点停止 | 通过 | 卡片出现后未 reload、未重新 open；直接点击页面「停止」按钮 |
| stop 确实发送 | 通过 | 浏览器网络日志：`POST http://127.0.0.1:17862/api/conversations/892265fc-2533-45fa-a9fa-582945b65fed/stop (Fetch) 200` |
| runtime 取消 / pending 清除 | 通过 | `turnState=IDLE`、`pendingPermissions=0`；Conversation `CANCELLED`；Session `CANCELLED` |
| 卡片清除 | 通过 | DOM：`本次批准=false`、`本次拒绝=false`、`需要授权=false`、停止按钮=false；页面显示「已停止 · 20261009-170249-892265fc」；截图 `e2e/06-d1-after-stop-no-refresh.png` |
| 迟到批准 409 | 通过 | `POST /api/sessions/7319826e…/permissions/ec7049f3…/resolve {optionId:"allow_once"}` → `409 {"error":"Permission request is no longer active","code":"PERMISSION_NOT_FOUND"}` |
| 目标文件未创建 | 通过 | `d1-stop-target.txt` 不存在（停止前、停止后、迟到批准后均为 0） |

关键对比：上一轮相同入口下该按钮静默无请求（见旧报告 D1）；本轮同一路径发出真实 stop 且闭环完整。

## 3. 回归用例

| # | 验收点 | 结果 | 证据 |
| --- | --- | --- | --- |
| R1 | 批准才写入 | 通过 | 新对话 `3d5be6e6…` / session `40871fb4…`；页面点「本次批准」→ `POST …/permissions/c1961b36…/resolve` 200；`d1-approve-target.txt` 创建，内容 `d1-approve-ok`；轮次回 `IDLE`；截图 `e2e/07-regression-approve-reject.png` |
| R2 | 拒绝不写入 | 通过 | 同一会话续聊第二条消息产生**新的**原生请求 `f8b75b07…`；点「本次拒绝」→ resolve 200；`d1-reject-target.txt` 不存在；模型回复确认动作被拒且不重试 |
| R3 | 续聊保持 ASK | 通过 | 续聊的新 requestId 与首轮不同，仍走人工审批卡片，未退化为自动执行 |
| R4 | 刷新恢复 pending | 通过 | 对话 `b1b932ff…` / session `502212bc…`；卡片出现后整页 reload，卡片与「本次批准/本次拒绝」恢复，runtime requestId 仍为 `2be81644…`；随后批准成功，`d1-refresh-target.txt` 创建；截图 `e2e/08-refresh-restored-pending.png` |

## 4. 新增配置场景（草稿能力更新）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| A. 当前草稿新增/移除 router、cmd/args 即时更新 | 通过 | Provider「Claude CLI ASK Reverify」（已存 config `{}`），在「运行配置 (JSON)」依次输入 `{"claudeCodeRouter":true}`、`{"cmd":{"additionalParams":["--foo"]}}`、`{"cmd":{"baseCommandOverride":"/tmp/wrapper"}}` → ASK 选项均 `disabled=true` 且保持 `pressed=true`、保存按钮 disabled；改回 `{}` → ASK `disabled=false`、保存按钮可用。全程 **4 次 `POST /providers/capabilities`、0 次 `PUT /providers/:id`**，未依赖先保存 |
| B. 编辑导入失效 ASK+覆盖配置 | 通过 | 备份导入 `imported-invalid-ask`（`executionPermission=ASK` + config `{"claudeCodeRouter":true}`）；编辑页 ASK 显示为已选中但置灰，原因可读：「Claude router, custom commands and extra launch arguments have not passed CLI ASK verification.」；沙箱档同时置灰，FULL_ACCESS 仍可选（**无自动升级**）；保存按钮 disabled；截图 `e2e/09-config-imported-invalid-ask.png` |
| B2. 移除覆盖后保持 ASK 直接保存 | 通过 | 草稿 config 改为 `{}` → ASK 变为可选、保存按钮启用；`PUT /providers/imported-invalid-ask` → 200；复核保存结果 `executionPermission=ASK`、`config={}`，无需 FULL_ACCESS |
| C. 空 config 替换已存覆盖 | 通过 | 另导入 `imported-router-check`（已存 config = router）：`GET capabilities` → ASK `selectable=false`；`POST capabilities config={}` → `selectable=true`；`config={router}` → `false`。证明空对象替换已存 config，不回退 |
| D. 切换草稿不串缓存 | 通过 | Provider A 草稿置为 router（失效）后放弃（确认「放弃未保存的修改」）；打开 B（已存 config `{}`）→ ASK 可选；再回 A → ASK 仍可选。查询键含 Agent/Runtime/Provider/模型/草稿 config，未发生跨草稿污染 |

## 5. 隔离性抽查

- runtime `capabilities.terminalInput=false`（ASK session）。
- 可见会话日志（12 条）不含 `control_request` / `control_response` / `can_use_tool` / `request_id` / `permission-prompt-tool` / `ANTHROPIC_AUTH_TOKEN`。
- 通过 Socket.IO 注入伪造 `control_response(behavior=allow)`：服务端拒绝，日志 `code: 'terminal_input_disabled'`（`Native protocol stdin cannot be written through terminal input`）；请求保持 pending、目标文件未创建，随后经页面停止正常收尾。
- 启动日志对 prompt 与 `--settings` 脱敏，`ANTHROPIC_AUTH_TOKEN=(not set)`。

## 6. ASK-only 策略与受限主体

- 本轮浏览器验证运行在默认本地 owner 策略下（支持档位均可授权）。**浏览器没有验证受限主体**：本轮未新增用户模型、未改策略实现，因此“普通用户不可选 FULL_ACCESS”不是浏览器结论。
- 作为补充，独立重跑实现者指出的 route 证据：`pnpm exec vitest run packages/server/src/routes/__tests__/providers.test.ts -t "ASK-only"` → 1 passed。该用例注入 `getAllowedModes: () => ['ASK']`，覆盖：FULL_ACCESS `authorized=false/selectable=false`；`POST /providers`、`/providers/test` 返回 403 `POLICY_MODE_DENIED`；草稿 config 解析与凭据不回传。可据此认为受限策略的服务端路径成立，但不等于真实页面已用受限账号走通。

## 7. 覆盖边界与未验证项

- 仅覆盖已验证原生组合 `Claude 2.1.293 / Darwin arm64`；其它版本、平台、router/自定义命令组合按设计保持置灰，未测试。
- 真实模型 smoke 仍只有 `deepseek-v4-pro`；官方 Anthropic 模型组合未验收。
- 未触发真实并发竞态（双击/双浏览器同时批准）；仅验证重复/迟到答复 409。
- 原始 payload 日志检查为有界抽查（浏览器可见日志 + 覆盖审批的 PTY 窗口 + 启动行脱敏），非逐字节全量扫描。
- 未覆盖 CLI headless 交互、其它 Agent 模式、问答/计划确认、多用户/RBAC、资源隔离。
- 未合并、未发布。

## 8. 证据文件

- `e2e/05-d1-pending-before-stop.png`：D1 审批卡片现场（含停止按钮）。
- `e2e/06-d1-after-stop-no-refresh.png`：不刷新点击停止后的「已停止」状态，卡片已清除。
- `e2e/07-regression-approve-reject.png`：批准写入 / 拒绝不写入后的会话。
- `e2e/08-refresh-restored-pending.png`：整页刷新后 pending 卡片恢复。
- `e2e/09-config-imported-invalid-ask.png`：导入失效 ASK + 覆盖配置的编辑态（ASK 置灰带原因、保存禁用）。
- 上一轮 `e2e/01-pending-approval.png`、`02-approve-reject-result.png`、`03-pending-before-stop.png`、`04c-options.png` 原样保留。

## 9. 清理

- 停止并移除本轮 `claude-ask-reverify` 服务；关闭本任务浏览器 session；删除 `/tmp/tower-claude-ask-reverify` 临时数据/配置/脚本；确认无本轮残留子进程。
- `permission-ui-fix-qa` 及其数据、Provider、PID/代际全程未触碰。
