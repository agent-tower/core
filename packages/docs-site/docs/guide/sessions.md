---
title: Session
description: agent 执行与后续对话。
---

# Session

Session 表示一次 agent 执行或一次后续对话。它运行在 workspace 目录中，由后端的 PTY pipeline 管理。

## 创建 Session

创建 session 时需要：

- `workspaceId`
- prompt
- providerId 或 agentType
- 可选 variant

如果提供了 `providerId`，系统会从 provider 推导 agent 类型。

## 启动 Session

启动后，后端会：

1. 根据 provider 选择 executor
2. 在 workspace 目录启动 agent CLI
3. 通过 node-pty 接管 stdout/stdin
4. 把输出写入 MsgStore
5. 尝试用 parser 结构化 agent 输出
6. 通过 Socket.IO 推送给前端

## 后续消息

无论 session 正在运行还是已经结束，都可以通过统一入口发送后续消息。对于支持 session id 的 agent，系统会尽量使用 follow-up 模式延续上下文。

## 日志快照

Session 日志包含两层：

- 原始 stdout
- 结构化 patch 日志

运行中优先读取内存中的 MsgStore。结束后，日志快照会持久化到数据库。

## Token Usage

如果 parser 能从 agent 输出中提取 token usage，前端会展示使用情况。不同 agent 的输出格式不同，所以 token usage 的完整度取决于对应 parser 支持程度。

## Session 状态

| 状态 | 说明 |
| --- | --- |
| `PENDING` | 已创建，尚未启动 |
| `RUNNING` | CLI 进程正在运行 |
| `COMPLETED` | 正常完成 |
| `FAILED` | 执行失败 |
| `CANCELLED` | 被用户停止或取消 |
