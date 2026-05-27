---
title: 审查与合并
description: 如何审查 agent 的结果并合并 workspace。
---

# 审查与合并

Agent Tower 的目标不是自动把 agent 结果直接合进主分支，而是把结果推进到可审查状态。

## 进入 IN_REVIEW

普通聊天 session 结束后，如果任务下没有仍在运行的聊天 session，任务会进入 `IN_REVIEW`。

此时应重点看：

- Git changes
- 关键文件 diff
- 测试输出
- agent 的 Todo 是否有未完成项
- commit message 是否准确

## Diff 审查

建议按这个顺序审查：

1. 先看文件列表，确认没有越界修改
2. 再看核心业务文件
3. 再看测试文件
4. 最后看格式化、锁文件、生成文件

如果发现问题，可以直接发后续消息给 session，或打开 workspace 在 IDE 里处理。

## Rebase

如果主分支变化较快，可以在合并前对 workspace 执行 rebase。发生冲突时，workspace 会暴露 Git 操作状态，方便进入冲突解决流程。

## Squash Merge

merge 使用 squash merge 流程。这样每个 task 默认对应一个合并提交，主分支历史更容易审阅。

merge 成功后：

- Task 状态变为 `DONE`
- Workspace 状态变为 `MERGED`
- 返回合并提交 SHA

## 冲突处理

冲突通常来自：

- 多个 agent 修改同一文件
- 主分支已改动任务依赖的代码
- agent 修改了生成文件或锁文件

处理建议：

- 先读冲突文件，不要盲目接受一侧
- 让 agent 解释冲突原因可以节省时间，但最终仍要人工复核
- 冲突解决后运行相关测试
- 如果冲突范围太大，考虑 retry 任务创建新 workspace
