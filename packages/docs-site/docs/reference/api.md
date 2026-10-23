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

`PUT /api/projects/:id` 的 `mainBranch` 设置新建根 worktree 的默认基础分支，必须是已有本地分支。已有 workspace 保留自己的基础分支；旧记录的 `baseBranch` 为空时，服务端在同一事务内将其固定为修改前的默认值。新建根工作区从配置的分支创建并保存 `baseBranch`；显式指定起点的 TeamRun 成员工作区仍从父分支创建。

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
| `GET` | `/api/tasks/:taskId/setup-progress` | 获取任务下 ACTIVE workspace 的 Setup 进度快照，返回与 `workspace:setup_progress` 相同的 payload 数组（包含有界 stdout/stderr） |
| `GET` | `/api/workspaces/:id` | 获取 workspace 详情 |
| `GET` | `/api/projects/:projectId/workspace-branches` | 项目设置：本地分支及可配置的活跃根 workspace，返回紧凑 DTO |
| `PATCH` | `/api/workspaces/:id/base-branch` | 修改根 workspace 的基础分支；body 为 `baseBranch` 和原值 `expectedBaseBranch`（允许为 null），拒绝托管 Agent 调用 |
| `GET` | `/api/workspaces/:id/diff` | 获取 workspace diff |
| `POST` | `/api/workspaces/:id/merge` | squash merge；可用 `stopActiveServices: true` 明确允许先停止源 workspace 的活跃后台服务 |
| `POST` | `/api/workspaces/:id/archive` | 归档 workspace |
| `DELETE` | `/api/workspaces/:id` | 删除 workspace |
| `POST` | `/api/workspaces/:id/open-editor` | 在 IDE 中打开 workspace |
| `POST` | `/api/workspaces/:id/rebase` | rebase workspace |
| `GET` | `/api/workspaces/:id/git-status` | 获取所查目录的 Git 状态 |
| `POST` | `/api/workspaces/:id/conflict-context` | owner 只读核验原冲突证明并换签；id 为原 source workspace |
| `POST` | `/api/workspaces/:id/abort-operation` | 中止当前 Git 操作 |
| `POST` | `/api/workspaces/:id/reactivate` | 唤醒休眠 workspace |
| `POST` | `/api/system/cleanup` | 清理可清理的 workspace |
| `POST` | `/api/system/hibernate-idle` | 手动触发空闲 workspace 休眠 |

Setup 进度快照保存在当前服务进程内，运行态保留至脚本结束，终态最多保留 10 分钟；服务重启后不保留。前端可在打开任务或 Socket 重连时读取快照，补偿错过的进度事件。

基础分支修改仅适用于 ACTIVE 的 WORKTREE 根 workspace，且不能由 TeamRun 成员所有。目标必须是已有本地分支，与源分支不同且具有共同历史；Agent 正在执行、Git 操作未结束或 `expectedBaseBranch` 已过期时返回 409。保存更新 `baseBranch`、清空旧生成提交消息，广播 `workspace:git_changed`（`reason: base-branch`）；不 checkout、rebase 或修改提交历史。

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


## 会话正文翻译（服务端入口）

翻译默认关闭。设置、会话正文对照、任务/独立对话用户投递、PUBLIC Agent 房间正文对照、现有团队用户投递及 TEAM_INITIAL 新建团队首条原子投递均已接入。

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/translation-settings` | 独立翻译配置，凭据仅返回是否设置 |
| `PUT` | `/api/translation-settings` | `expectedRevision` 与凭据 `keep/replace/clear` 保存意图 |
| `POST` | `/api/translation-settings/test` | 临时草稿测试，不保存配置或历史 |
| `GET` | `/api/sessions/:id/translations` | `blockIds` 逗号分隔（最多 100），可选 `cursor`；返回 `items/nextCursor`，每页最多 100 条 |
| `POST` | `/api/sessions/:id/translations/:sourceId/retry` | `{expectedRevision}`；仅已有可重试来源，采用当前配置 |

这些入口要求应用 owner 或受信任 internal 身份，拒绝托管 Agent credential；密码关闭时沿用正常本地 owner 入口，写操作保留同源校验。来源读取还要求会话属于可读的未删除对话或未删除任务/未归档项目，内部自动提交会话不提供翻译 overlay。

只翻译新增或继续更新的 `assistant_message` 正文。原文即时输出，完整长段落在父正文仍输出时即可提交翻译，遇工具/思考或显式块完成时提交剩余正文；尾块在轮结束时提交。日志 textBlock.paragraphs 记录已封口段落的 UTF-16 end 和 translationEpoch；段落 overlay 的 blockId 为父 blockId 加 :p序号，sourceRevision 沿用父版本。客户端可用共享 getTranslationTextBlocks 投影并按原文字节匹配译文。思考、工具参数、工具结果和静态历史不进入翻译。会话停止不会删除已完成且仍可读的展示翻译。

`translation:invalidated` 是独立 Socket 通知，仅携带 `sessionId/sourceId/sourceRevision/overlayRevision`，发给订阅该 Session 且认证有效的 owner 浏览器。通知只用于失效缓存；重连和刷新使用 REST 补读，按 revision 丢弃旧响应。译文不写入原文 patch 流，也不表示 Agent 活跃或触发派活。

## PUBLIC Agent 房间正文翻译

启用时新增的 PUBLIC Agent 房间消息自动登记。历史未标记消息不回填；关闭期间的消息不在重新开启后补翻。译文仅用于桌面/移动房间展示，不改变原始消息、派活或 Agent 输入。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/team-runs/:id/translations?messageIds=a,b` | 已加载消息ID去重后最多100；返回完整权威summary快照，有界preview |
| `GET` | `/api/team-runs/:id/messages/:messageId/translation` | 单条完整原文/译文及版本 |
| `POST` | `/api/team-runs/:id/translations/:sourceId/retry` | `{expectedRevision}`为sourceRevision；仅已有可重试项，使用当前配置 |

这些入口拒绝Agent credential，遵循owner/internal及同源写入策略。缺失、不合格或失去资格的消息不返回summary项；单条缺失404，版本冲突409，容量不足429。读取不会创建来源或重翻。已成功且仍可读的历史译文不因关闭或换语言消失。

独立 `translation:invalidated` 房间分支仅含 `teamRunId/messageId/sourceId/sourceRevision/overlayRevision`；只作为失效信号，重连与刷新以REST为权威，不承诺退订重订后完全没有多余旧信号。

## 用户输入投递与翻译

浏览器的 `POST /api/sessions/:id/start`、`POST /api/sessions/:id/message`、`POST /api/conversations` 和 `POST /api/conversations/:id/message` 返回 **202 MessageDeliverySubmission**：`operationId`、`destinationId`、`sessionId`、`state` 和 `delivery`。202 只确认意图已持久化；仅 `delivery.state === SENT` 表示 Driver 输入提交已确认。Conversation 客户端再按 destinationId 获取实体。

用户输入使用稳定 UUID `clientSubmissionId`，相同请求重试返回同一操作，修改内容复用该 ID 返回409。创建 Workspace 和待启动 Session 也接受该字段，各自保存创建 fingerprint。附件用 `attachmentIds` 独立传递；Task 原字段及用户日志保留原文。普通 Agent MCP 输入沿用原调用路径；可信 internal 的用户输入需显式携带 `x-agent-tower-input-origin: user`。

每个投递通道最多64条未决意图、实例最多512条。仅 SENT/CANCELLED 释放额度，翻译失败、暂停和 UNKNOWN 继续占额。超限返回429、`code: DELIVERY_QUEUE_FULL`、`accepted: false`；首次 Conversation/Session 的创建随事务回滚。相同已有 UUID 先恢复操作，不受容量拒绝。

AI 冲突处理的 owner 请求使用 `systemAction: resolve_conflicts` 和 Git 冲突响应/只读 `git-status` 返回的 `resolutionContextToken`。服务端验证当前调用身份、真实操作目标和用户选定 Session（须属于源或目标 workspace），重建并冻结完整指令；客户端 message/附件不会成为系统指令，也不会外发翻译。相同已受理 UUID 先返回原操作，签名过期或进程重启不改变冻结正文；不同目的/意图复用 UUID 返回409。

未受理的签名会随进程密钥或有效期失效，返回409 `CONFLICT_CONTEXT_INVALID`、`accepted: false`。保留原提交 UUID/输入；对带持久恢复证明且仍未改变的 merge/rebase 现场，使用 `POST /api/workspaces/:sourceWorkspaceId/conflict-context`，body 为 `{ "resolutionContextToken": "原 token" }`，返回 `{ "resolutionContextToken": "新 token" }`。该 owner 接口按证明定位真实 worktree/项目目录，核验原身份、源/目标实体及目录、HEAD、Git 操作元数据和未合并 index，保留原源/目标 Session 范围，不写 Git、不重做操作、不创建投递。普通 `git-status` 仅返回所查目录状态，不能用于推断跨目录接收权限。旧版 token 无持久证明、服务端恢复密钥丢失或现场/实体变化时仍返回409，不能恢复未经核实的历史授权。若已 abort 且无可验证资料，须用户检查目标/策略后明确重新执行原 Git 操作；刷新、核验和重试发送不会执行 Git，再次操作成功则无需发送冲突指令。旧的无签名系统请求仅能从仍存在的真实现场只读重建。

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/message-deliveries?scopeType=SESSION&scopeId=:id` | 每页最多100；亦支持 CONVERSATION、TEAM_TASK（scopeId 为 taskId），cursor 取 nextCursor；filter=pending 排除历史，filter=sent 倒序查询已发送 |
| `GET` | `/api/message-deliveries/:id` | 恢复单个输入操作、原文和冻结的实际发送正文 |
| `POST` | `/api/message-deliveries/:id/actions` | action、expectedRevision 和 UUID actionId；重复相同 actionId 幂等，过期 revision 返回409 |

动作包括 retry_translation、send_original、retry_delivery、cancel。DELIVERY_UNKNOWN 不自动重投，只能在核对未发送后 confirm_not_sent，或 end_unknown 结束操作（Agent 可能已收到）。ACCEPTED 仅为 ConversationTurn 入队，可在 dispatch claim 前取消；DISPATCHING 不能宣称撤回。关闭/重开翻译设置不自动释放之前的暂停项。

查询和人工动作仅允许现有 owner 策略，拒绝 Agent credential；写入校验同源。

## 团队用户投递与固定任务输入

owner 浏览器及显式 internal-user 的 `POST /api/team-runs/:id/messages` 必须携带 UUID `clientSubmissionId`，返回202、`operationId/state/destination/delivery`，destination.kind 为 TEAM_ROOM，无 sessionId。相同 UUID/请求恢复同操作，修改正文、附件或路由复用 UUID 返回409。有效团队 Agent 保留201发布路径；solo或无效Agent不回退为用户。

202表示受理，TEAM_USER 的 SENT表示唯一房间消息、全部派活、共享输入引用和发布凭据已原子提交；CONFIRM仍待批准，不表示成员已运行。附件与mentions/target及实际收件人在受理时冻结。前序正文或共享任务输入失败会阻塞同Task通道，关闭开关不自动发送原文。

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/team-runs/:id/task-inputs` | owner共享输入摘要，每页最多50，cursor取nextCursor |
| `GET` | `/api/team-runs/:id/task-inputs/:snapshotId` | owner单项完整原文/已采纳正文 |
| `POST` | `/api/team-runs/:id/task-inputs/:snapshotId/actions` | `{action,expectedRevision,actionId}`；action为retry_translation或send_original |
| `GET` | `/api/team-runs/:id/task-input?view=preview\|full` | 仅当前团队Agent credential，固定本次Invocation的ACCEPTED快照 |

MCP `get_team_task_input` 与Agent输入GET使用同一快照；Task后续编辑不改变该Invocation的prompt或输入。无引用的历史Invocation返回409 `LEGACY_TASK_INPUT_NOT_SNAPSHOTTED`，不补造历史。普通get_task/get_context继续提供Task元数据。Task编辑不触发翻译，仅实际投递/调度消费者登记共享版本。

owner房间消息显示用户原文，可按需对照冻结的实际发送正文；Agent房间读取和prompt仅使用实际投递文本，不包含owner原文副本。团队 `message-delivery:invalidated` 仅携带 taskId/teamRunId/operationId/deliveryRevision，限当前认证和订阅有效的owner；刷新/重连以REST为权威。待发重试应保留原UUID/body，并与新草稿及附件分离。

新建团队的 `POST /api/tasks/:taskId/team-runs` 同样要求稳定 UUID `clientSubmissionId`。无等待时返回201真实 TeamRun；等待翻译或前序时返回202 MessageDeliverySubmission，目的为 `TEAM_ROOM_PENDING`（taskId/plannedTeamRunId），不含 destinationId。pending 不提前创建团队、成员或派活；SENT 后目的转为 `TEAM_ROOM`，才可使用真实 teamRunId 导航。首条采纳正文同时作为固定任务输入，不重复翻译；等待期间 Task 原字段变化会推进来源版本并撤销旧尝试。
