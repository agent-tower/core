# 三档执行权限：修复后的独立 UI 验收启动说明

本说明只准备后续验收入口，尚未启动 UI 服务、执行浏览器操作或产生截图。原 QA 报告 `artifacts/e2e/execution-permission-v1-report.md` 保留：测试成员 MCP 审批策略阻塞，真实交互覆盖为 0。组件测试（包括文件名带 browser 的 happy-dom 测试）不能视为浏览器通过。

## 工具与前提

- 当前 worktree 的正常终端：核对分支/HEAD，执行有限构建，创建临时目录。
- Workspace service MCP：`list_workspace_services`、`start_workspace_service`、`get_workspace_service_logs`、`control_workspace_service`；需要 PTY 输入时使用 `send_workspace_service_input`。
- Team Room MCP：读取完整派活、确认成员 ID、发布结果；需 `list_room_messages`、`get_room_message`、`list_team_members`、`post_room_message`、自己的队列工具。
- 浏览器工具：已安装的 agent-browser（先读 agent-browser/E2E skill），或团队批准的浏览器 MCP。浏览器须连接本次确认归属的独立服务。
- 若工具仍报“requires approval, but approval policy is never”，由负责人处理工具可用性，验收保持阻塞。不要调整成员权限、借普通终端后台启动服务或测试归属未知的既有端口。

## 隔离启动

1. 正常终端执行 `git status --short`、`git rev-parse HEAD`，与修复 result 的目标 SHA 核对。构建顺序为 `pnpm --filter @agent-tower/shared build` → `pnpm --filter @agent-tower/server build` → `pnpm --filter web build`。
2. 正常终端执行 `mktemp -d /tmp/tower-permission-ui.XXXXXX`，记录返回目录为 `<QA_DATA_DIR>`；执行 `pwd`，记录绝对路径为 `<WORKTREE>`。目录须全新，不能指向用户的生产或开发数据目录。
3. `list_workspace_services` 确认本 worktree 的服务状态。使用以下 `start_workspace_service` 结构化参数，将占位符替换为第 2 步结果：

```json
{
  "service_name": "permission-ui-fix-qa",
  "command": "node",
  "args": [
    "packages/server/dist/cli.js",
    "--host", "127.0.0.1",
    "--port", "17843",
    "--data-dir", "<QA_DATA_DIR>",
    "--web-dir", "<WORKTREE>/packages/web/dist"
  ],
  "relative_cwd": "."
}
```

该 CLI 创建独立 SQLite、Provider 配置及认证配置，并直接托管本 worktree 的前端构建。无需 Vite/watch 服务；不要使用 `pnpm dev`，当前 dev 入口会固定使用共享的 `~/.agent-tower-dev` 数据目录。

4. 通过 `get_workspace_service_logs` 有界读取日志（建议 limit=50），并用 `list_workspace_services` 核对命令、cwd、运行状态与归属，再打开 `http://127.0.0.1:17843`。若端口占用导致退出，停止该 QA 服务并更换独立端口；不要操作未知端口的进程。首次登录按该独立实例的认证流程完成，凭据不放进房间或报告。
5. 在临时目录创建无外部副作用的测试仓库/项目，仅创建无真实凭据的测试 Provider。UI 操作无需运行模型。失效旧 Codex ACP 示例应在服务停止时写入该 QA data dir 的 `providers.json`，或通过旧备份导入，不写用户数据。

## 恢复验收时优先检查

- 固定三个选项、置灰原因、键盘不可选、英文文案、Agent/runtime 切换、新建 ASK 默认。
- 旧 Codex ACP `config.permissionMode=ASK`、`acpPermissionMode=ASK` 和缺省：诊断保持可见、保存/测试阻止；明确点选新的 ASK 后解除；刷新及备份导入后不丢迁移标记。
- 同 ID 导入改变 CLI→ACP 后，旧 CLI Session 启动/续聊返回明确错误。活动 ACP 继续使用启动模式，新 transport 核对当前 Provider 的 Agent/runtime。
- Gemini CLI FULL_ACCESS 的无模型参数解析通过 `scripts/verify-gemini-permission-args.mts` 单独重现，不能以 UI 保存成功替代运行验证。
- 受限策略/Pi 无可用模式仍需专用可注入策略 fixture；普通应用默认是 LocalOwner，首版没有用户/RBAC 开关。现有 Service 单测证明策略交集，尚无该场景的真实 UI 验收。

## 收尾

使用 `control_workspace_service` 的 stop 停止本 QA 服务，确认 desired/runtime 已 STOPPED、没有 runtime identity，再清理本次临时数据和仓库。开始/结束记录分支与 HEAD，截图按 Team Room 图片契约交付，发布真实执行过的覆盖范围；工具拒绝时继续报告覆盖为 0。
