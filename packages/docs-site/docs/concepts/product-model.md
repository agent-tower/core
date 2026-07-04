---
title: 产品模型
description: Agent Tower 的核心业务对象。
---

# 产品模型

Agent Tower 的核心对象关系是：

```text
Project -> Task -> Workspace -> Session -> ExecutionProcess
```

团队模式会在 Task 下增加 TeamRun：

```text
Task -> TeamRun -> TeamMember
                -> RoomMessage -> WorkRequest -> AgentInvocation -> Session
```

## Project

Project 是一个本地 Git 仓库。它是所有任务的归属边界。

Project 保存：

- 仓库路径
- 主分支
- 初始化脚本
- 本地配置复制规则
- 快捷命令
- 归档状态

## Task

Task 是看板上的工作项。它描述“要让 agent 完成什么”。

Task 包含：

- 标题
- 描述
- 优先级
- 状态
- 排序位置
- 所属 Project

## Workspace

Workspace 是 Task 的执行环境。默认情况下它对应一个 git worktree 和任务分支；在部分流程中也可以表示项目主目录模式或 TeamRun 专用子 workspace。

Workspace 包含：

- worktree 路径
- workspace kind
- 实际工作目录
- 分支名
- 状态
- setup 进度
- commit message
- 预览目标
- 多个 session

## Session

Session 是一次 agent 执行。它记录 agent 类型、prompt、provider、状态、日志快照和 token usage。

Session 用途包括：

- `CHAT`: 普通 agent 对话或执行
- `COMMIT_MSG`: 生成 commit message 的后台任务

Session 的执行上下文包括：

- `WORKSPACE`: 项目任务 workspace
- `CONVERSATION`: 独立对话目录

## ExecutionProcess

ExecutionProcess 表示底层 PTY/进程记录。它用于追踪实际启动的 CLI 进程。

## Provider

Provider 是 agent 的具体配置实例。例如：

- Claude Code 的某个 profile
- Codex 的某个 profile
- Gemini CLI 配置
- Cursor Agent 配置

Provider 可以包含环境变量、CLI 设置和默认项。

## Attachment

Attachment 是用户上传的文件。它可以在任务描述或后续消息中注入给 agent。

## Conversation

Conversation 是不绑定具体 Project/Task 的独立 agent 对话。它有自己的工作目录和 session，适合临时问答或不需要 worktree 隔离的单次上下文。

## TeamRun

TeamRun 表示一次团队协作运行，属于某个 Task。它包含：

- 成员和成员配置快照
- Team Room 公开消息和私聊消息
- WorkRequest 队列
- AgentInvocation 执行记录
- 主 workspace 和成员专用 workspace 关系

成员配置包括能力开关、workspace 策略、触发策略、session 策略和队列管理策略。

## NotificationSettings

通知设置包括：

- OS 通知
- 飞书 webhook
- 测试通知入口
