---
title: 项目与任务
description: Project 和 Task 的使用方式。
---

# 项目与任务

Project 和 Task 是 Agent Tower 的入口对象。

## Project

Project 表示一个本地 Git 仓库。

它保存：

- 仓库路径
- 主分支
- 初始化脚本
- 需要复制到 workspace 的本地配置
- 快捷命令
- 归档状态

Project 不复制你的主仓库。只有创建 workspace 时，系统才会基于这个仓库创建 git worktree。

## Task

Task 是具体工作项。它属于某个 Project，并在看板上流转。

Task 状态：

| 状态 | 含义 |
| --- | --- |
| `TODO` | 待执行 |
| `IN_PROGRESS` | 有 session 正在执行，或任务处于进行中 |
| `IN_REVIEW` | agent 已完成，等待人工审查 |
| `DONE` | 已合并或确认完成 |
| `CANCELLED` | 已取消 |

## 任务描述建议

给 agent 的任务描述应包含：

- 目标
- 修改范围
- 不要改什么
- 验收方式
- 需要运行的测试或命令

不建议只写：

```text
修一下这个 bug
```

更好的写法：

```text
修复任务详情页切换项目后仍显示旧 session 日志的问题。

范围：
- 只改前端 session log store 和相关 hook
- 保持现有 UI 不变

验收：
- 增加或更新 store 测试
- 运行 pnpm --filter web lint
```

## 任务重试

任务可以 retry。重试会归档当前 workspace，并把任务重置为 `TODO`，方便用新的 workspace 重新执行。
