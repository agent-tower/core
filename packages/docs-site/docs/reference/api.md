---
title: REST API
description: 当前代码库中公开的主要 REST 端点。
---

# REST API

下面是当前代码库公开的主要 REST 端点。接口会随着实现变化，文档站只记录当前已存在的行为。

## System

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/agents` | 列出可用 AI agent |
| `GET` | `/api/system/cursor-agent-models` | 查询 Cursor Agent 可用模型 |
| `GET` | `/api/system/slash-command-catalog` | 获取 slash command 目录 |
| `GET` | `/api/system/skill-catalog` | 获取 skill 目录 |
| `GET` | `/api/system/mcp-config` | 获取当前运行环境的 MCP 客户端配置 |
| `GET` | `/api/system/workspace-context` | 根据 cwd 解析 workspace 上下文 |

## Projects

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/projects` | 列出项目 |
| `POST` | `/api/projects` | 创建项目 |
| `GET` | `/api/projects/:id` | 获取项目详情 |
| `PUT` | `/api/projects/:id` | 更新项目 |
| `POST` | `/api/projects/:id/archive` | 归档项目 |
| `POST` | `/api/projects/:id/restore` | 恢复项目 |
| `DELETE` | `/api/projects/:id` | 删除项目，实际执行归档 |

`GET /api/projects` 的每个项目包含 `lastActivityAt`：取该项目最近一条未删除任务的创建时间；没有任务时使用项目创建时间。任务后续更新不会改变该值，客户端可据此按项目活跃度排序，无需加载任务列表。

## Tasks

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/task-board` | 获取跨项目紧凑任务看板；支持 `projectId`、`status`、`page`、`limit` |
| `GET` | `/api/projects/:projectId/tasks` | 获取项目任务列表 |
| `POST` | `/api/projects/:projectId/tasks` | 创建任务 |
| `GET` | `/api/projects/:projectId/tasks/stats` | 获取任务统计 |
| `GET` | `/api/tasks/:id` | 获取任务详情 |
| `GET` | `/api/tasks/:id/body` | 获取完整任务正文和 prompt |
| `PUT` | `/api/tasks/:id` | 更新任务 |
| `PATCH` | `/api/tasks/:id/status` | 更新任务状态 |
| `PATCH` | `/api/tasks/:id/position` | 更新任务位置 |
| `POST` | `/api/tasks/:id/retry` | 重试任务 |
| `DELETE` | `/api/tasks/:id` | 删除任务 |

`/api/task-board` 只返回看板渲染需要的 task、首选 workspace、最新 agent 类型和运行标志，不包含任务正文、完整 workspace 或 session 历史。需要正文时使用 `/api/tasks/:id/body`，需要执行详情时再读取对应 workspace/session 接口。

## Workspaces

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/tasks/:taskId/workspaces` | 创建 workspace |
| `GET` | `/api/tasks/:taskId/workspaces` | 获取任务下所有 workspace |
| `GET` | `/api/workspaces/:id` | 获取 workspace 详情 |
| `GET` | `/api/workspaces/:id/diff` | 获取 workspace diff |
| `POST` | `/api/workspaces/:id/merge` | squash merge；可用 `stopActiveServices: true` 明确允许先停止源 workspace 的活跃后台服务 |
| `POST` | `/api/workspaces/:id/archive` | 归档 workspace |
| `DELETE` | `/api/workspaces/:id` | 删除 workspace |
| `POST` | `/api/workspaces/:id/open-editor` | 在 IDE 中打开 workspace |
| `POST` | `/api/workspaces/:id/rebase` | rebase workspace |
| `GET` | `/api/workspaces/:id/git-status` | 获取 Git 状态 |
| `POST` | `/api/workspaces/:id/abort-operation` | 中止当前 Git 操作 |
| `POST` | `/api/workspaces/:id/reactivate` | 唤醒休眠 workspace |
| `POST` | `/api/system/cleanup` | 清理可清理的 workspace |
| `POST` | `/api/system/hibernate-idle` | 手动触发空闲 workspace 休眠 |

Merge readiness 和实际 merge 锁内都会检查后台服务；候选 workspace 存在 `STARTING`、`RUNNING`、`STOPPING` 服务，或任意状态仍保留 runtime identity 时，默认以 `409 WORKSPACE_HAS_ACTIVE_SERVICE` 阻止合并。用户明确确认后，merge 请求可携带 `stopActiveServices: true`，服务端会在 workspace lifecycle barrier 和 merge target lock 内先停止这些服务，再重新检查并执行合并；停止后的服务不会自动恢复。

### Workspace 后台服务

这些接口管理由 workspace 持有的长期进程。服务不会因启动它的 Agent session 完成、停止或 Socket 断开而退出；workspace 休眠、归档或删除时会停止。日志是有界内存 buffer，应用重启后不保留。`desiredState` 与 `runtimeState` 都是 `STOPPED` 且没有 runtime identity 的定义不会出现在列表中，也不计入每个 workspace 最多 20 个服务的配额；同名同配置启动时仍可复用该定义。

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/workspaces/:workspaceId/services` | 列出服务及 desired/runtime 状态 |
| `PUT` | `/api/workspaces/:workspaceId/services/:name` | 幂等启动服务；body 为 `command`、可选 `args[]` 和 workspace 内 `relativeCwd` |
| `GET` | `/api/workspaces/:workspaceId/services/:name/logs` | 读取日志；支持 `runtimeInstanceId`、`afterSeq` 和 `limit` |
| `POST` | `/api/workspaces/:workspaceId/services/:name/input` | 写入 PTY；body 为 `{ "data": "..." }` |
| `POST` | `/api/workspaces/:workspaceId/services/:name/stop` | 停止整棵进程树并清除期望运行状态 |
| `POST` | `/api/workspaces/:workspaceId/services/:name/restart` | 停止后用已保存的结构化命令重启 |

启动接口不接受 shell 命令字符串、绝对 cwd 或自定义 env。项目配置继续由自身 `.env` 和启动脚本读取。服务名只允许字母、数字、点、下划线和连字符，最长 64 个字符。

同源且通过 access auth 的浏览器可以调用两个只读 GET：服务列表与服务日志。浏览器不能调用启动/更新、输入、停止或重启接口，这些控制操作仍会返回 `WORKSPACE_SERVICE_BROWSER_UNAVAILABLE`。公共 status 端点签发的 cookie、缺少 Origin/Referer 或自报 session/invocation/internal identity 都不能换取控制权限。

日志响应包含真实 `runtimeInstanceId`、`oldestSeq`、`nextSeq`、`reset`、`truncated` 和 `hasMore`。首次读取可以省略 `runtimeInstanceId`；后续增量读取应同时提交上一响应的 `runtimeInstanceId` 和最后消费的 seq（作为 `afterSeq`）。当请求代际与当前 runtime 不一致或游标已重置时，服务端忽略旧游标、返回当前代际并将 `reset` 设为 true，客户端必须丢弃旧代际缓存。`truncated` 仅表示更早日志已被有界 buffer 丢弃，或最新页读取省略了无法再向前获取的内容；`hasMore` 只表示当前游标后还有正常分页，完整追平后不会触发日志丢失提示。

托管 MCP 使用服务端签发的 per-session/invocation credential，后端从 credential 恢复不可修改的 identity：Solo session 必须绑定目标 workspace；TeamRun session 还会重验 invocation/session/workspace、活跃成员和 `runCommands` capability。credential 跟随 DriverSession/MCP transport 跨自然完成与 follow-up 保持有效，在 DriverSession 关闭、显式停止 Session、启动失败或应用退出时撤销。应用级内部调用仍可使用 `x-agent-tower-internal-token`。

后台服务 start/restart 与 workspace merge、hibernate、archive、delete、task/project cleanup 共用 workspace lifecycle barrier。终态操作会在 barrier 内禁止新 start、停止全部 runtime，再完成文件系统或状态变更。

稳定业务错误码包括：

| HTTP | Code | 含义 |
| --- | --- | --- |
| `401` | `WORKSPACE_SERVICE_AUTH_REQUIRED` / `ACCESS_AUTH_INVALID_AGENT_CREDENTIAL` | 缺少 Agent 身份，或 Agent credential 无效/身份冲突 |
| `403` | `WORKSPACE_SERVICE_BROWSER_UNAVAILABLE` | 浏览器尝试启动、更新、输入、停止或重启服务 |
| `400` | `VALIDATION_ERROR` / `CWD_NOT_FOUND` / `CWD_OUTSIDE_WORKSPACE` | 输入或相对目录无效 |
| `403` | `INTERNAL_CALLER_IDENTITY_REQUIRED` / `INTERNAL_SESSION_NOT_FOUND` | internal caller 缺少或使用无效 session identity |
| `403` | `SESSION_WORKSPACE_MISMATCH` | session 不属于目标 workspace |
| `403` | `INVOCATION_IDENTITY_REQUIRED` / `INVOCATION_SESSION_MISMATCH` / `INVOCATION_WORKSPACE_MISMATCH` | TeamRun invocation identity 缺少或绑定不匹配 |
| `403` | `TEAM_RUN_MEMBER_CAPABILITY_REQUIRED` | TeamRun 成员没有 `runCommands` |
| `404` | `WORKSPACE_NOT_FOUND` / `WORKSPACE_SERVICE_NOT_FOUND` | workspace 或服务不存在 |
| `409` | `WORKSPACE_NOT_ACTIVE` / `SERVICE_SPEC_CONFLICT` / `SERVICE_BUSY` / `SERVICE_NOT_RUNNING` | workspace 或服务状态不允许操作 |
| `429` | `WORKSPACE_SERVICE_LIMIT_REACHED` | workspace 已达到 20 个未完全停止服务的数量上限 |
| `500` | `SERVICE_START_FAILED` / `SERVICE_START_CLEANUP_FAILED` / `SERVICE_STOP_TIMEOUT` | 启动、失败补偿或进程树清理失败 |

## Sessions

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/workspaces/:workspaceId/sessions` | 创建 session |
| `GET` | `/api/sessions/:id` | 获取 session 详情 |
| `POST` | `/api/sessions/:id/start` | 启动 session |
| `POST` | `/api/sessions/:id/stop` | 停止 session |
| `POST` | `/api/sessions/:id/message` | 给 session 发送消息 |
| `GET` | `/api/sessions/:id/logs` | 获取日志快照 |
| `GET` | `/api/sessions/:id/visualizations/:file` | 读取当前 Codex thread 的内联可视化 HTML |
| `GET` | `/api/sessions/:id/artifacts/download?path=...` | 校验并下载 Session 声明的持久化产物 |

## Conversations

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/conversations` | 列出独立对话 |
| `POST` | `/api/conversations` | 创建独立对话并将首条 prompt 持久化入队；接口返回后由后台启动 session |
| `GET` | `/api/conversations/:id` | 获取独立对话详情 |
| `POST` | `/api/conversations/:id/message` | 向独立对话发送后续消息；消息持久化入队后返回 `202`，ACP turn 在后台串行执行 |
| `POST` | `/api/conversations/:id/stop` | 停止独立对话 session |
| `DELETE` | `/api/conversations/:id` | 删除独立对话 |

## Providers

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/providers` | 列出 providers |
| `GET` | `/api/providers/capabilities[?agentType=CODEX&model=...]` | 获取 Provider 能力；指定 Codex 模型时返回该 runtime 声明的推理强度档位 |
| `GET` | `/api/providers/backup` | 导出 provider 备份 |
| `POST` | `/api/providers/import/preview` | 预览导入 |
| `POST` | `/api/providers/import` | 导入备份 |
| `GET` | `/api/providers/:id` | 获取 provider 详情 |
| `POST` | `/api/providers` | 创建 provider |
| `PUT` | `/api/providers/:id` | 更新 provider |
| `DELETE` | `/api/providers/:id` | 删除 provider |
| `POST` | `/api/providers/reload` | 重新加载 provider 配置 |

## Profiles

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/profiles` | 获取合并后的 profile 配置 |
| `GET` | `/api/profiles/defaults` | 获取默认 profile 配置 |
| `POST` | `/api/profiles/reload` | 重新加载 profile 配置 |
| `GET` | `/api/profiles/:agentType` | 获取某 agent 下的所有 variant |
| `GET` | `/api/profiles/:agentType/:variant` | 获取某个 variant 配置 |
| `PUT` | `/api/profiles/:agentType/:variant` | 创建或更新 variant 配置 |
| `DELETE` | `/api/profiles/:agentType/:variant` | 删除用户自定义 variant |

## Notifications

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/notifications/settings` | 获取通知配置 |
| `PUT` | `/api/notifications/settings` | 更新通知配置 |
| `POST` | `/api/notifications/test` | 测试通知 |

## Tunnel

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/tunnel/status` | 获取 tunnel 状态 |
| `GET` | `/api/tunnel/health` | tunnel 健康检查 |
| `POST` | `/api/tunnel/bootstrap` | bootstrap |
| `POST` | `/api/tunnel/start` | 启动 tunnel |
| `POST` | `/api/tunnel/regenerate` | 重新生成 tunnel 访问 token 并启动 |
| `POST` | `/api/tunnel/stop` | 停止 tunnel |

## Files and Git

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/filesystem/browse` | 浏览目录 |
| `GET` | `/api/filesystem/complete` | 文件路径自动补全 |
| `GET` | `/api/filesystem/validate` | 校验路径是否为 Git 仓库 |
| `GET` | `/api/files/tree` | 列目录树 |
| `GET` | `/api/files/read` | 读文件 |
| `POST` | `/api/files/write` | 写文件 |
| `GET` | `/api/files/image` | 读取 workspace 中的图片文件 |
| `GET` | `/api/git/changes` | 查看变更 |
| `GET` | `/api/git/diff` | 查看单文件 diff |
| `GET` | `/api/git/log` | 查看提交历史 |
| `GET` | `/api/git/commit-files` | 查看某次提交变更文件 |
| `GET` | `/api/git/commit-diff` | 查看某次提交的单文件 diff |

## Attachments and App Settings

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/attachments/upload` | 上传附件 |
| `GET` | `/api/attachments/metadata` | 批量获取附件元数据 |
| `GET` | `/api/attachments/:id/file` | 读取附件文件 |
| `GET` | `/api/attachments/by-path` | 按路径查询附件 |
| `GET` | `/api/app-settings` | 读取应用设置 |
| `PUT` | `/api/app-settings` | 更新应用设置 |
| `GET` | `/api/app-settings/commit-message-defaults` | 获取 commit message 默认值 |

## Terminals

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/terminals` | 创建独立终端 |
| `DELETE` | `/api/terminals/:terminalId` | 销毁独立终端 |

## TeamRun

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/member-presets` | 列出成员预设 |
| `GET` | `/api/member-presets/:id` | 获取成员预设 |
| `POST` | `/api/member-presets` | 创建成员预设 |
| `PATCH` | `/api/member-presets/:id` | 更新成员预设 |
| `DELETE` | `/api/member-presets/:id` | 删除成员预设 |
| `GET` | `/api/team-templates` | 列出团队模板 |
| `GET` | `/api/team-templates/:id` | 获取团队模板 |
| `POST` | `/api/team-templates` | 创建团队模板 |
| `PATCH` | `/api/team-templates/:id` | 更新团队模板 |
| `DELETE` | `/api/team-templates/:id` | 删除团队模板 |
| `POST` | `/api/tasks/:taskId/team-runs` | 为任务创建 TeamRun |
| `GET` | `/api/tasks/:taskId/team-run` | 获取任务关联的 TeamRun |
| `GET` | `/api/team-runs/:id` | 获取 TeamRun 详情 |
| `POST` | `/api/team-runs/:id/messages` | 发送 Team Room 公开消息 |
| `POST` | `/api/team-runs/:id/private-messages` | 发送 Team Room 私聊消息 |
| `GET` | `/api/team-runs/:id/messages` | 列出 Team Room 消息 |
| `GET` | `/api/team-runs/:id/messages/:messageId` | 获取单条 Team Room 消息 |
| `GET` | `/api/team-runs/:id/members` | 列出 TeamRun 成员 |
| `POST` | `/api/team-runs/:id/members` | 添加 TeamRun 成员 |
| `PATCH` | `/api/team-runs/:id/members/:memberId` | 更新 TeamRun 成员 |
| `POST` | `/api/team-runs/:id/members/:memberId/remove` | 移除 TeamRun 成员 |
| `GET` | `/api/team-runs/:id/work-requests` | 列出 TeamRun WorkRequest |
| `GET` | `/api/team-runs/:id/members/:memberId/work-requests` | 列出成员 WorkRequest 队列 |
| `POST` | `/api/team-runs/work-requests/:id/approve` | 批准 WorkRequest |
| `POST` | `/api/team-runs/work-requests/:id/reject` | 拒绝 WorkRequest |
| `POST` | `/api/team-runs/work-requests/:id/cancel` | 取消 WorkRequest |
| `POST` | `/api/team-runs/:id/members/:memberId/stop` | 停止成员当前工作 |
| `GET` | `/api/team-runs/:id/invocations` | 列出 TeamRun agent invocation |

## Agent CLI Environment

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/agent-cli/manifest` | 获取可检测/安装的 Agent CLI manifest |
| `GET` | `/api/agent-cli/status` | 获取本机 Agent CLI 状态 |
| `POST` | `/api/agent-cli/status/refresh` | 刷新本机 Agent CLI 状态 |
| `POST` | `/api/agent-cli/install-previews` | 创建安装预览 |
| `GET` | `/api/agent-cli/install-previews/:id` | 获取安装预览 |
| `POST` | `/api/agent-cli/install-tasks` | 创建安装任务 |
| `GET` | `/api/agent-cli/install-tasks/:id` | 获取安装任务 |
| `GET` | `/api/agent-cli/install-tasks/:id/logs` | 获取安装任务日志 |
| `POST` | `/api/agent-cli/install-tasks/:id/cancel` | 取消安装任务 |

安装执行类接口带本机访问限制，用于避免远程 tunnel 触发本机安装。

## Preview

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/previews/:workspaceId/status` | 获取 workspace 预览代理状态 |
| `PUT` | `/api/previews/:workspaceId/config` | 配置 workspace 预览目标 |
| `POST` | `/api/previews/:workspaceId/sessions` | 打开本地或远程独立预览会话 |
| `POST` | `/api/previews/:workspaceId/sessions/:sessionId/heartbeat` | 续租预览会话并刷新入口凭证 |
| `DELETE` | `/api/previews/:workspaceId/sessions/:sessionId` | 释放预览会话 |
| `ANY` | `/view/:workspaceId` | 兼容旧客户端的同源代理入口 |
| `ANY` | `/view/:workspaceId/*` | 兼容旧客户端的同源代理子路径 |

预览目标只允许 loopback HTTP/HTTPS 地址。新客户端通过 session API 获取独立根路径 gateway URL；远程 session 会按 workspace 复用独立 Quick Tunnel。session API 使用现有 access password/tunnel session，gateway URL 使用短期 bootstrap token 换取独立 HttpOnly Cookie，并支持 HTTP 与 WebSocket 转发。`/view/:workspaceId` 仅用于兼容。
