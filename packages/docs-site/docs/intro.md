---
title: 概览
description: Agent Tower 是什么、为什么需要它，以及它如何配合现有 agent 工具工作。
slug: /intro
---

# Agent Tower 文档

Agent Tower 是一个本地优先的 AI coding agent 控制台。它不是一个新的 agent、模型或代码生成工具，也不会替代 Claude Code、Codex、Gemini CLI、Cursor Agent 等已有工具。

它的角色是管理和编排这些 agent：为任务创建独立 worktree，启动对应 agent CLI，记录执行过程，展示终端输出和结构化日志，收集代码变更，并把 review、rebase、merge 等后续流程放进同一个界面里。

## 它解决什么问题

当你只跑一个任务时，直接开终端就够了。但当你开始并行运行多个 agent、多个项目、多个 worktree 时，问题会迅速变复杂：

- 终端窗口太多，不知道哪个任务跑到哪一步
- 多个任务同时改同一仓库，容易互相覆盖或产生冲突
- agent 的输出、Todo、token usage、文件变更分散在不同地方
- 任务完成后还要手动看 diff、rebase、merge
- 人不在电脑前时，很难继续跟进任务状态
- 外部 agent 没法直接读取任务板、领取任务或回写进度

Agent Tower 的目标不是让 agent 更聪明，而是让多个 agent 能更稳定、更可控地一起工作。

## 它怎么工作

Agent Tower 的核心对象关系是：

```text
Project -> Task -> Workspace -> Session -> ExecutionProcess
```

含义如下：

- `Project`: 一个本地 Git 仓库
- `Task`: 看板中的工作项
- `Workspace`: 某个任务对应的独立 git worktree
- `Session`: 一次 agent 执行或一次后续对话
- `ExecutionProcess`: 底层 PTY/CLI 进程记录

更多细节见 [产品模型](./concepts/product-model.md)。

## 文档路线

第一次使用建议按这个顺序阅读：

1. [快速开始](./getting-started/quick-start.md)
2. [项目初始化](./getting-started/project-setup.md)
3. [核心工作流](./guide/workflow.md)
4. [Agent Provider](./integrations/agent-providers.md)
5. [MCP 集成](./integrations/mcp.md)
6. [团队模式](./guide/team-mode.md)

如果你在开发 Agent Tower 本身，请从 [源码开发](./getting-started/source-development.md) 和 [仓库结构](./reference/repository-layout.md) 开始。

## 当前边界

Agent Tower 当前默认是单用户、本地优先的工具，不是云端多租户系统。它会管理本机上的仓库、worktree、终端进程和 SQLite 数据库。

当前不是目标的能力包括：

- 多用户账号系统
- 细粒度权限控制
- 云端托管 agent 执行
- 对远程 Git 服务做完整代码托管
