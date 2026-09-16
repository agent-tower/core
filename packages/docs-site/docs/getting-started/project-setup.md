---
title: 项目初始化
description: 创建 Project 时需要配置什么。
---

# 项目初始化

Project 对应一个本地 Git 仓库。Agent Tower 不托管你的代码仓库，它只记录仓库路径，并在需要执行任务时创建独立 git worktree。

## 创建 Project

创建项目时至少需要：

| 字段 | 说明 |
| --- | --- |
| `name` | 项目在看板中的显示名称 |
| `repoPath` | 本地 Git 仓库路径 |
| `mainBranch` | 合并目标分支，默认 `main` |

可选配置：

| 字段 | 说明 |
| --- | --- |
| `description` | 项目说明 |
| `copyFiles` | 创建 workspace 后复制的配置文件列表 |
| `setupScript` | workspace 初始化后执行的脚本 |
| `quickCommands` | 工作台里常用的快捷命令 |

## copyFiles

`copyFiles` 用来把根仓库里的本地配置复制到新 worktree。例如：

```text
.env
.env.local
.npmrc
```

适合复制不提交到 Git、但 agent 执行时需要的配置。

## setupScript

`setupScript` 会在 workspace 创建后执行。常见用途：

```bash
pnpm install
pnpm db:generate
```

Setup 在后台执行，可以与 Agent 输出同时进行。任务详情的启动卡片会同时展示 Agent 启动和 Setup 进度；Agent 启动完成后，如果 Setup 仍在运行，卡片会保留到 Setup 结束，日志区域持续显示 Agent 输出。

配置的 Setup 命令会直接显示在卡片中；命令产生输出后，卡片才提供“查看 Setup 输出”。打开任务或重新连接时，卡片会查询当前 Setup 进度。

脚本应尽量幂等。每个任务可能创建新的 worktree，非幂等脚本会让恢复和重试变得困难。

## mainBranch

merge、rebase 和 diff review 都围绕项目的主分支工作。建议保持它和真实 Git 仓库的默认集成分支一致，例如：

```text
main
develop
```

## 归档项目

归档后项目会进入只读状态。已归档项目不能继续启动 session。恢复项目时，如果本地仓库路径已经变更，需要提供新的 `repoPath`。
