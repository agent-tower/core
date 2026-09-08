---
title: Session
description: agent 执行与后续对话。
---

# Session

Session 表示一个可包含多轮 turn 的业务会话。常规任务 session 运行在 workspace 目录中，独立对话 session 运行在 conversation 工作目录中；具体由 CLI 或 ACP Runtime 执行。

## 创建 Session

创建 session 时需要：

- `workspaceId`
- prompt
- providerId 或 agentType
- 可选 variant

如果提供了 `providerId`，系统会从 provider 推导 agent 类型。

## 启动 Session

启动后，后端会：

1. 从 Session 固化的 `runtimeType` 选择 Runtime Driver
2. CLI Driver 启动 PTY/Pipeline，或 ACP Driver 建立连接并创建/恢复外部 session
3. Driver 把输出投影为统一 MsgStore patch
4. RuntimeCoordinator 管理 turn、取消、权限等待和迟到事件
5. SessionManager 持久化快照并执行 Task、TeamRun 和 Git 后处理
6. 通过 Socket.IO 推送实时变化

## 后续消息

无论 session 正在运行还是已经结束，都可以通过统一入口发送后续消息。对于支持 session id 的 agent，系统会尽量使用 follow-up 模式延续上下文。

独立对话的后续消息先写入持久化 `ConversationTurn` 队列，接口完成入队后返回 HTTP `202 Accepted`，不会等待 ACP 初始化或模型回复。每个 Session 的队列按入队顺序串行执行；服务重启会把中断中的 turn 恢复为待处理状态。消息内容会立即写入对话日志，运行状态和最终回复仍通过现有 Session REST/Socket 日志链路获取。

后续消息可以指定新的 `providerId`，用于在继续对话时切换 provider。这个切换只支持相同 `agentType` 和相同 `runtimeType`；切换 Agent 身份或在 CLI/ACP 之间切换都需要新建 Session。

ACP Runtime 会持久化 Agent 返回的 external session ID。内存连接仍存在时直接复用；服务重启后仅在 Agent 声明支持 `session/load` 时恢复。

## 停止与删除

一轮回复完成后，ACP 会话可能保留连接以便继续对话。显式停止 Session 会等待相关进程退出；删除独立对话或清理所属 workspace 时，也会停止这些空闲连接。

如果进程清理失败或尚未确认完成，删除操作会保留对话目录与记录，供再次尝试。清理进行期间不能新建或续发该资源的 Session。

## 权限请求

ACP Agent 可以在 turn 中请求工具权限。`ASK` 模式下，Session 仍保持 `RUNNING`，Runtime 的细粒度状态变为 `AWAITING_PERMISSION`。前端重连后会重新请求 `/sessions/:id/runtime`，不会依赖已经错过的 Socket 事件还原待处理权限。

## 日志快照

Session 日志包含两层：

- 原始 stdout
- 结构化 patch 日志

运行中优先读取内存中的 MsgStore。结束后，日志快照会持久化到数据库。

## Token Usage

如果 parser 能从 agent 输出中提取 token usage，前端会展示使用情况。不同 agent 的输出格式不同，所以 token usage 的完整度取决于对应 parser 支持程度。

## 下载 Agent 产物

Agent 创建用户需要下载的交付文件后，会在回复中输出独立一行的下载意图：

```text
::agent-download{file="output/report.pdf"}
```

路径必须相对于当前 Session 工作目录，使用正斜杠，不能包含绝对路径或 `..`。Agent Tower 会在 Session 完成时校验文件并复制到受管理的产物目录；消息中的意图会显示为下载按钮。下载读取持久化副本，因此 workspace 合并、休眠或清理后不会依赖原文件路径。

服务端发布时会记录文件名、MIME、大小和 SHA-256，并在下载前再次验证受管理副本。浏览器可以确认服务器完整返回了文件，但无法确认用户是否最终在系统保存对话框中完成保存。

## Session 状态

| 状态 | 说明 |
| --- | --- |
| `PENDING` | 已创建，尚未启动 |
| `RUNNING` | Runtime 中存在正在执行或等待权限的 turn |
| `COMPLETED` | 正常完成 |
| `FAILED` | 执行失败 |
| `CANCELLED` | 被用户停止或取消 |

## 独立对话

独立对话通过 `/conversations` 页面使用，不绑定 Project、Task 或 Workspace。它适合临时问答、轻量上下文整理，或不需要 Git worktree 隔离的 agent 对话。
