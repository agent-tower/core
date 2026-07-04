---
title: Socket.IO 事件
description: 当前可订阅的实时事件。
---

# Socket.IO 事件

Socket.IO 命名空间是 `/events`。

当前实现中，大多数 session、task、workspace 和 TeamRun 事件会直接广播到 `/events` namespace。`subscribe`/`unsubscribe` 仍是统一客户端协议，其中独立 terminal topic 会实际加入 `terminal:{id}` room 并返回订阅确认。

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
| `workspace:git_changed` | server -> client | workspace Git/文件变化轻量信号 |
| `team-run:invalidated` | server -> client | TeamRun 相关缓存失效信号 |

`session:subscribed` 和 `session:unsubscribed` 仍是 shared 包中的保留常量，但当前 SocketGateway 不会发出这两个事件。客户端订阅 session topic 时应以 `subscribe` / `unsubscribe` ack 作为确认。

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

workspace git changed payload：

```ts
{
  workspaceId: string;
  taskId: string;
  projectId: string;
  workingDir: string;
  reason: 'worktree' | 'git-dir' | 'refresh' | 'unknown';
}
```

TeamRun invalidated payload：

```ts
{
  teamRunId: string;
  taskId?: string;
  projectId?: string;
  scopes: Array<
    | 'team-run'
    | 'team-members'
    | 'room-messages'
    | 'work-requests'
    | 'agent-invocations'
    | 'task'
    | 'workspaces'
  >;
  reason:
    | 'team-run-created'
    | 'team-members-updated'
    | 'room-message-created'
    | 'work-request-updated'
    | 'agent-invocation-updated'
    | 'member-work-stopped'
    | 'team-review-updated';
}
```
