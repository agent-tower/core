---
title: 状态流转
description: Task、Workspace 和 Session 的状态。
---

# 状态流转

Agent Tower 用状态机把任务执行、审查和合并流程固定下来。

## Task 状态

```text
TODO -> IN_PROGRESS -> IN_REVIEW -> DONE
                    \-> CANCELLED
```

| 状态 | 说明 |
| --- | --- |
| `TODO` | 任务已创建，等待执行 |
| `IN_PROGRESS` | 有 session 启动，或任务正在被处理 |
| `IN_REVIEW` | 所有聊天 session 已结束，等待审查 |
| `DONE` | 已完成，通常表示 workspace 已合并 |
| `CANCELLED` | 用户取消 |

自动规则：

- Session 启动时，任务会自动转到 `IN_PROGRESS`
- 任务下所有 `CHAT` session 结束后，任务自动转到 `IN_REVIEW`
- Workspace 成功 squash merge 后，任务推进到 `DONE`

## Workspace 状态

```text
ACTIVE -> MERGED
       -> ABANDONED
```

| 状态 | 说明 |
| --- | --- |
| `ACTIVE` | 当前可执行、审查、rebase、merge |
| `MERGED` | 已合并回主分支 |
| `ABANDONED` | 已归档或被重试流程替换 |

## Session 状态

```text
PENDING -> RUNNING -> COMPLETED
                  -> FAILED
                  -> CANCELLED
```

| 状态 | 说明 |
| --- | --- |
| `PENDING` | 已创建，尚未启动 |
| `RUNNING` | 底层 agent CLI 仍在运行 |
| `COMPLETED` | 正常结束 |
| `FAILED` | 异常失败 |
| `CANCELLED` | 被用户停止 |

## Session 用途

| 用途 | 说明 |
| --- | --- |
| `CHAT` | 普通 agent 执行和后续对话 |
| `COMMIT_MSG` | 生成 commit message |

## 自动提交

普通 `CHAT` session 正常退出后，后端会尝试对 workspace 中未提交变更做兜底 auto-commit。这样 review 阶段可以看到更稳定的 Git 状态。

这不是跳过审查。它只是把 agent 的文件变更固定下来，方便后续 diff、rebase 和 squash merge。
