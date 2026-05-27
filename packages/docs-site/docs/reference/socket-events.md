---
title: Socket.IO 事件
description: 当前可订阅的实时事件。
---

# Socket.IO 事件

Socket.IO 命名空间是 `/events`。

## Client events

| Event | 方向 | 说明 |
| --- | --- | --- |
| `subscribe` | client -> server | 订阅 topic |
| `unsubscribe` | client -> server | 取消订阅 topic |
| `input` | client -> server | 发送 session 输入 |
| `resize` | client -> server | 调整 session 终端尺寸 |
| `terminal:input` | client -> server | 独立终端输入 |
| `terminal:resize` | client -> server | 独立终端尺寸调整 |

## Server events

| Event | 方向 | 说明 |
| --- | --- | --- |
| `session:subscribed` | server -> client | session 订阅成功 |
| `session:unsubscribed` | server -> client | session 取消订阅 |
| `session:stdout` | server -> client | session stdout |
| `session:patch` | server -> client | session 结构化 patch |
| `session:exit` | server -> client | session 退出 |
| `session:completed` | server -> client | session 完成 |
| `session:sessionId` | server -> client | agent session id |
| `session:error` | server -> client | session 错误 |
| `task:updated` | server -> client | task 更新 |
| `task:deleted` | server -> client | task 删除 |
| `agent:status_changed` | server -> client | agent 状态变化 |
| `terminal:stdout` | server -> client | 独立终端输出 |
| `terminal:exit` | server -> client | 独立终端退出 |
| `terminal:subscribed` | server -> client | 独立终端订阅成功 |
| `terminal:unsubscribed` | server -> client | 独立终端取消订阅 |
| `workspace:setup_progress` | server -> client | workspace 初始化进度 |
| `workspace:commit_message_updated` | server -> client | commit message 更新 |
| `workspace:hibernated` | server -> client | workspace 进入休眠 |

## 常见 payload

订阅 payload：

```ts
{
  topic: 'session' | 'task' | 'agent' | 'terminal' | 'project';
  id?: string;
}
```

session stdout payload：

```ts
{
  sessionId: string;
  data: string;
}
```

workspace setup payload：

```ts
{
  workspaceId: string;
  taskId: string;
  status: 'running' | 'completed' | 'failed';
  currentCommand?: string;
  currentIndex?: number;
  totalCommands: number;
  error?: string;
}
```
