---
title: 核心工作流
description: 从创建任务到审查合并的完整流程。
---

# 核心工作流

Agent Tower 的默认流程是：

```text
创建项目 -> 创建任务 -> 创建 workspace -> 启动 agent session -> 审查 diff -> 合并
```

## 1. 创建任务

Task 是看板上的工作项。一个任务应该包含明确目标、约束和验收标准。

示例：

```text
修复 Provider 设置页保存后没有刷新列表的问题。

要求：
- 保持现有 UI 风格
- 增加一个覆盖保存成功后的测试
- 不改动无关设置页
```

任务越清楚，agent 在独立 workspace 中完成后越容易审查。

## 2. 创建 Workspace

启动任务时，Agent Tower 会为任务创建 workspace。workspace 是一个独立 git worktree，并绑定到该任务。

它负责：

- 创建任务分支
- 初始化 worktree 目录
- 复制需要的本地配置
- 执行 setup script
- 承载 agent CLI 的工作目录

## 3. 启动 Session

Session 是一次 agent 执行。启动 session 时需要指定 provider，或直接指定 agent 类型。

一次任务可以有多个 session。例如：

- 第一次 session 完成主要实现
- 第二次 session 根据 review 反馈修复问题
- 第三次 session 只生成 commit message 或补充测试

## 4. 实时查看执行过程

任务详情页会展示：

- 原始终端输出
- 结构化日志
- Todo 面板
- token usage
- 文件编辑器
- Git changes
- 历史记录
- 独立终端 tabs

这让你不必在多个终端和编辑器之间切换。

## 5. 进入审查

普通聊天 session 结束后，后端会尝试：

1. 自动提交未保存的 worktree 改动
2. 持久化日志快照和 token usage
3. 广播 session 完成事件
4. 检查任务是否应进入 `IN_REVIEW`
5. 触发 commit message 生成

当任务进入 `IN_REVIEW` 后，重点是审查 diff，而不是继续盯终端。

## 6. 合并

确认 diff 后，workspace 可以 squash merge 回主分支。合并成功后：

- workspace 标记为 `MERGED`
- task 推进到 `DONE`
- 相关 session 和日志仍可在历史里查看

如果发生冲突，界面会暴露冲突状态和处理入口。见 [审查与合并](./review-and-merge.md)。
