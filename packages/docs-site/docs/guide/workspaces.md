---
title: Workspace
description: git worktree 隔离模型。
---

# Workspace

Workspace 是 Agent Tower 保证并行安全的核心。每个 workspace 对应一个任务分支和一个独立 git worktree。

## 为什么使用 git worktree

多个 agent 直接在同一个工作目录里执行，会出现几个问题：

- 文件互相覆盖
- 测试产物混在一起
- 很难判断每个任务具体改了什么
- 合并时缺少清晰边界

git worktree 让每个任务有自己的工作目录和分支。agent 可以像在普通仓库里一样执行命令，但它的改动被隔离在任务 workspace 中。

## 创建过程

创建 workspace 时，系统会：

1. 确认任务所属 Project
2. 从主仓库创建任务分支
3. 创建 git worktree 目录
4. 复制 Project 配置的 `copyFiles`
5. 执行 `setupScript`
6. 记录 workspace 状态和路径

## Workspace 状态

| 状态 | 说明 |
| --- | --- |
| `ACTIVE` | 可继续执行 session、查看 diff、rebase 或 merge |
| `MERGED` | 已合并回主分支 |
| `ABANDONED` | 已归档或不再使用 |

## Git 操作

Workspace 支持：

- 查看 diff
- 查看 Git status
- rebase 到主分支
- abort 当前 Git 操作
- squash merge
- 处理 merge/rebase 冲突
- 在 IDE 中打开 workspace

## 休眠与恢复

空闲 workspace 可以休眠，以减少本地工作区堆积。需要继续任务时，可以 reactivate，把 workspace 恢复为可操作状态。

## 使用建议

- 每个 task 尽量对应一个清晰的工作目标
- 不要让一个 workspace 长期承担多个不相关需求
- 合并前先审查 diff，而不是只相信 agent 的完成提示
- 冲突较多时，优先 rebase 后让 agent 处理局部冲突，再人工复核
