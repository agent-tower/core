# Claude CLI「请求批准（ASK）」页面审批流程 E2E 验证

- 日期：2026-10-09
- 结论：**有条件通过**。核心原生审批闭环（ASK 可选、卡片、批准/拒绝、刷新恢复、拒绝/停止后 409、输入隔离）通过；发现 1 个与验收项「等待审批时停止」直接相关的 **UI 缺陷（高优先级）**。
- 基线：`a063ddf9243f6eb6201397798012cd2d8a16de24`（工作区干净，未 checkout、无产品源码改动、未新增提交；本次只新增本报告与截图）。
- 测试者角色：独立临时环境中的浏览器/API 验证；代码审查并行进行，不由本报告替代。

## 1. 环境与归属证据

| 项 | 值 |
| --- | --- |
| Tower 服务 | workspace service `claude-ask-e2e`：`node packages/server/dist/cli.js --host 127.0.0.1 --port 17861 --data-dir /tmp/tower-claude-ask-e2e/data --web-dir <worktree>/packages/web/dist` |
| 服务归属 | `lsof` 显示进程 cwd = 本 worktree 根目录；数据目录为本轮新建的独立 SQLite；启动 08:23:14Z、停止 08:32:11Z（exit 0），端口 17861 已释放 |
| 代码版本 | 启动前 `git rev-parse HEAD` = `a063ddf9…`（与交付一致）；`dist` 构建于源码最后修改之后，含本轮新增 `runtime/claude-cli-control.js`、`utils/cli-duplex-channel.js`；运行中服务的能力接口只在本交付中才会对 Claude CLI 返回 ASK selectable |
| Claude 原生 | `claude 2.1.293 (Claude Code)`，Darwin arm64，与 implementation-report 记录的已验证构建一致 |
| 浏览器 | `agent-browser 0.34.0`，独立 session `tower-claude-ask-qa-1016`（已 close，未使用 `close --all`） |
| 认证隔离 | 复制 `~/.claude/settings.json` 的 env 到独立 `CLAUDE_CONFIG_DIR`（临时目录），provider env 只写入该目录路径；未修改全局配置、未输出凭据、未写入全局 Claude 会话目录 |
| 现有 QA | `permission-ui-fix-qa`（PID 34538 / runtimeInstanceId `caa84444-…` / startedAt 03:39:00Z / data-dir `/tmp/tower-permission-ui.XauGPU`）全程未触碰；清理后仍 `http://127.0.0.1:17843` 返回 200 |
| 模型 | 复用本机 Anthropic 兼容端点（与实现 smoke 相同），未修改任何全局设置 |

## 2. 用例结果

| # | 验收点 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 已验证原生组合下 ASK 可选择 | 通过 | Provider 编辑页三档选择器：`请求批准` 可选中；截图 `e2e/04c-options.png`；`/api/providers/capabilities` 返回 `ASK supported/authorized/selectable=true` |
| 2 | 未知/未验证组合仍置灰，无自动升级 | 通过 | Claude CLI `AUTO_SANDBOX=false (CAPABILITY_UNVERIFIED)`，置灰项带 `aria-describedby` 可读原因「此接入方式的原生沙箱档尚未核实。」；矩阵中其它 Agent 维持原规则（如 Pi ACP ASK=`AGENT_MODE_UNSUPPORTED`，其它 CLI ASK=`RUNTIME_MODE_UNSUPPORTED`） |
| 3 | 原生审批请求出现正确卡片 | 通过 | `turnState=AWAITING_PERMISSION`、`executionPermission=ASK`，卡片显示「启动权限：请求批准 / 需要授权 / Bash / command: printf … / description: … / 本次批准 / 本次拒绝」；截图 `e2e/01-pending-approval.png` |
| 4 | 批准才写文件 | 通过 | 点击「本次批准」后 `ask-approved-2.txt` 创建，内容 `ask-e2e-approved`；轮次回到 `IDLE` |
| 5 | 拒绝不写文件 | 通过 | 续聊新请求点击「本次拒绝」：目标文件不存在，轮次正常结束，模型回复「The action was denied by the user. I'm stopping here and will not retry the command.」；截图 `e2e/02-approve-reject-result.png` |
| 6 | 续聊仍 ASK | 通过 | 同会话第二条消息产生**新的**原生请求（新 requestId），流程与首轮一致，未回退为自动执行 |
| 7 | 刷新/重连后 pending 可恢复 | 通过 | 卡片出现后整页重新加载，卡片与同一 requestId 由 REST 运行时状态恢复，随后批准成功执行 |
| 8 | 重复/过期答复 409 | 通过 | 已答复请求再次 resolve → `409 {"error":"Permission request is no longer active"}`（两次独立验证） |
| 9 | 停止后旧卡片/迟到答复失效（服务端） | 通过 | 等待审批时 `POST /conversations/:id/stop`：轮次 `IDLE`、`pendingPermissions=0`、会话 `CANCELLED`、目标文件未创建；随后同 requestId resolve → `409 PERMISSION_NOT_FOUND` |
| 10 | 等待审批时从页面点击「停止」 | **失败** | 见第 3 节缺陷 D1 |
| 11 | 刷新后从页面点击「停止」 | 通过 | 重新加载页面后同一按钮发起 `POST .../stop` → 会话 `CANCELLED`、pending 清零、`ask-stop-6.txt` 未创建 |
| 12 | 任意 terminal input 不能答协议 | 通过 | 通过 Socket.IO `input` 注入伪造 `control_response(behavior=allow)`：服务端拒绝 `terminal_input_disabled`（日志：`Native protocol stdin cannot be written through terminal input`），请求仍 pending、文件未创建；运行时 `capabilities.terminalInput=false` |
| 13 | 控制原始 payload 不进入浏览器/日志 | 通过（有界） | 浏览器可见会话日志（28 条）不含 `control_request/control_response/can_use_tool/request_id`；页面文本无原始 JSON；启动日志对 prompt 与 `--settings` 做脱敏；覆盖各轮审批的 PTY 日志窗口未见原始控制帧 |

其它观察：ASK 启动参数显式包含 `--permission-prompt-tool stdio --permission-prompts host`、`--input-format/--output-format=stream-json`、`--disallowedTools=AskUserQuestion` 与 `--resume <native session>`；审批完成后轮次正常收尾（`IDLE`/`COMPLETED`），未见「结果已出但一直运行中」。

## 3. 缺陷 D1：等待审批时页面「停止」按钮无任何效果

- 严重级别：高（直接对应验收项「等待审批时停止，旧卡片/迟到答复失效」）。
- 复现步骤：
  1. 使用 Claude CLI + ASK Provider，新建独立对话，发送需要 Bash 的任务；
  2. 页面出现「需要授权」卡片后（**不要刷新页面**），点击右下角「停止」按钮；
  3. 观察服务端：没有任何 `POST /conversations/:id/stop`；运行时保持 `AWAITING_PERMISSION`、卡片仍在；随后（重复/迟到的）批准仍会执行动作并写出文件（实测 `ask-stop-4.txt` 被创建）。
- 期望结果：停止应使当前审批卡片失效，迟到答复返回 409，动作不得执行。
- 关键对比：**同一按钮在整页刷新后工作正常**（用例 11），说明不是权限或后端停止逻辑问题，而是前端状态判断。
- 现场证据：3 次点击（含 2 次 JS 原生 `click()`）均观察到 DOM 点击事件，但 `window.fetch` 无调用、服务端无 stop 请求；按钮未被禁用（`disabled=false`）；API 侧会话状态为 `RUNNING`。
- 根因假设（供实现成员参考，未改代码）：
  - 停止按钮的可见性来自运行时轮次状态（`AgentSessionPanel.tsx:109-110` `useSessionActivity`：`isActive` 为真即可见）；
  - 但 `ConversationPage.handleStop` 的前置条件是会话详情查询里的 `isRunning(activeConversation.status)`（`ConversationPage.tsx:553-556`）；
  - 等待审批期间该详情缓存可能落后于实际状态（`POST /message` 应答被 `setQueryData` 缓存，而队列随后才把状态置为 RUNNING），于是 guard 静默 return，表现为“按钮点了没反应”；
  - 相关文件未在本交付 diff 内（该逻辑上一次变更为 `fa0ca45d`），但 ASK 让 `AWAITING_PERMISSION` 成为 CLI 主路径上的常见状态，因此该缺陷在新功能下可稳定触发。
- 建议处理：交负责人决定由实现成员修复（统一按钮可见性与停止判断的活跃状态来源，或停止请求始终使 pending 失效），修复后需重跑用例 10。

## 4. 覆盖边界与未验证项

- 授权拒绝 403（受限部署策略）未在本轮浏览器中重跑；按派活约定，此项结合既有契约/单元证据，不视为浏览器已通过。
- 「双击/两个浏览器同时批准」的并发竞态未真实并发触发；仅验证了“答复后重复提交 → 409”。
- 原始 payload 日志检查为有界抽查（浏览器可见日志 + 覆盖审批过程的 PTY 窗口 + 启动行脱敏），不是对 PTY 缓冲区的逐字节全量扫描。
- 仅覆盖已验证的 `Claude 2.1.293 / Darwin arm64` 构建；其它版本、平台、router/自定义命令组合按设计保持置灰，未测试。
- 使用本机 Anthropic 兼容端点模型，非官方 Anthropic 模型组合。

## 5. 证据文件

- `artifacts/claude-cli-ask/e2e/01-pending-approval.png`：等待审批卡片（含命令与说明）。
- `artifacts/claude-cli-ask/e2e/02-approve-reject-result.png`：批准后模型确认写入、拒绝后模型确认停止。
- `artifacts/claude-cli-ask/e2e/03-pending-before-stop.png`：被点击「停止」但无效果的 pending 现场。
- `artifacts/claude-cli-ask/e2e/04c-options.png`：三档选择器（ASK 选中、沙箱档置灰并给出原因）。

## 6. 清理

- 已停止 `claude-ask-e2e`（exit 0，端口 17861 释放），删除临时数据目录 `/tmp/tower-claude-ask-e2e` 与临时脚本；无残留子进程；未改动现有 `permission-ui-fix-qa` 及其数据/Provider/PID/代际。
