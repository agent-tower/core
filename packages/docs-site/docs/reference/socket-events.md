---
title: Socket.IO 事件
description: 当前可订阅的实时事件。
---

# Socket.IO 事件

Socket.IO 命名空间是 `/events`。

当前实现中，大多数 session、task、workspace 和 TeamRun 事件会直接广播到 `/events` namespace。`subscribe`/`unsubscribe` 仍是统一客户端协议，其中独立 terminal topic 会实际加入 `terminal:{id}` room 并返回订阅确认。

服务端按工作目录维护 Git 状态，只向 `workspace-git:<workspaceId>` 房间中已订阅该 workspace 且授权有效的 socket 推送。

## Client events

| Event | 方向 | 说明 |
| --- | --- | --- |
| `subscribe` | client -> server | 订阅 topic |
| `unsubscribe` | client -> server | 取消订阅 topic |
| `workspace-git:subscribe` | client -> server | 订阅 workspace 的 Git 状态，成功时在确认中返回当前快照 |
| `workspace-git:unsubscribe` | client -> server | 取消该 workspace 的 Git 订阅 |
| `workspace-git:refresh` | client -> server | 请求重新检查已订阅 workspace 的 Git 状态 |
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
| `workspace:git_changed` | server -> client | 广播 workspace 基础分支或 worktree 的变动通知 |
| `workspace:git_state` | server -> client | 向订阅者推送带版本的完整 Git 状态 |
| `workspace:git_subscription_ended` | server -> client | 已确认的 Git 订阅终止，附终止原因 |
| `team-run:invalidated` | server -> client | TeamRun 相关缓存失效信号 |

`WorkspaceService` 发出的 `workspace:git_changed` 由网关在 `/events` 广播。服务端发送的 `reason` 有两种。

- `base-branch` 表示基础分支已修改，或新建的 `MAIN_DIRECTORY` workspace 可能改变共享目录的比较基准。
- `worktree` 表示 worktree 已恢复、重建，或定向执行的 workspace 已同步到指定提交。

服务端据此重新登记受影响的 Git 订阅。Web 客户端收到 `base-branch` 时会使 workspace 元数据、项目分支列表、任务及 workspace 整体差异缓存失效。没有订阅覆盖时，两种通知都会使变更列表、Git 状态和提交历史过期，已打开的视图通过 REST 重读。重连时也会重新查询 workspace 元数据。

`session:subscribed` 和 `session:unsubscribed` 仍是 shared 包中的保留常量，但当前 SocketGateway 不会发出这两个事件。客户端订阅 session topic 时应以 `subscribe` / `unsubscribe` ack 作为确认。

## Git 状态订阅

发送 `workspace-git:subscribe` 时传入 `workspaceId` 和确认回调。成功的确认带 `ok: true` 和当前快照，后续状态变化由 `workspace:git_state` 推送。失败的确认带 `ok: false`、`code` 和 `message`。`code` 为 `INVALID_PAYLOAD`、`NOT_FOUND`、`WORKSPACE_GIT_UNAVAILABLE` 或 `WORKSPACE_GIT_SUBSCRIPTION_DENIED`。

客户端按 `workspaceId` 保存快照。首次收到状态或 `epoch` 改变时采用整份快照。同一 `epoch` 内只接受更高的 `version`，忽略相同或更低的版本。`state.changes` 与 `GET /api/git/changes` 的响应结构相同，`state.status` 与 `GET /api/workspaces/:id/git-status` 的响应结构相同。

窗口重新获得焦点或标签页恢复可见时，可用 `workspace-git:refresh` 请求重新检查目录。服务端对同一 socket 和同一 workspace 每秒最多接受一次刷新请求，退订再订阅也沿用这个限制。刷新和退订均无确认。

若快照暂时投递失败，服务端从 `250` 毫秒开始将重试间隔逐次加倍，最长 `5` 秒，有新快照时改发新快照。重新登记订阅遇到临时故障时，服务端依次等待 `1`、`2`、`5`、`10`、`30` 秒重试。

`workspace:git_subscription_ended` 只发给已获成功确认的订阅者。`NOT_FOUND` 表示 workspace 已不存在，`WORKSPACE_GIT_UNAVAILABLE` 表示 Git 状态不可用或重新登记重试耗尽。收到后应将该订阅标为失效。Web 客户端会通过 REST 重读已打开的变更列表、Git 状态和提交历史。

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
  updatedAt: number; // 服务端进度更新时间，毫秒
  status: 'running' | 'completed' | 'failed';
  currentCommand?: string;
  currentIndex?: number;
  totalCommands: number;
  error?: string;
  output?: string; // bounded stdout/stderr from setup commands
}
```

workspace git changed payload：

```ts
{
  workspaceId: string;
  taskId: string;
  projectId: string;
  workingDir: string;
  reason: 'base-branch' | 'worktree' | 'git-dir' | 'refresh' | 'unknown';
}
```

三个 Git 客户端事件共用的请求 payload：

```ts
{ workspaceId: string }
```

`workspace-git:subscribe` 的确认：

```ts
type WorkspaceGitSubscribeAck =
  | ({ ok: true } & WorkspaceGitStatePayload)
  | { ok: false; code: string; message: string };
```

`workspace:git_state` 的 payload：

```ts
type WorkspaceGitStatePayload = {
  workspaceId: string;
  epoch: string;
  version: number;
  state: WorkspaceGitState;
};

type WorkspaceGitState = {
  changes: { uncommitted: WorkspaceGitChangeEntry[]; committed: WorkspaceGitChangeEntry[] };
  status: GitOperationStatus;
  headOid: string | null;
  baseBranch: string;
};

type WorkspaceGitChangeEntry = {
  status: string;
  path: string;
  additions?: number;
  deletions?: number;
  token: string;
};
```

`workspace:git_subscription_ended` 的 payload：

```ts
{
  workspaceId: string;
  code: 'NOT_FOUND' | 'WORKSPACE_GIT_UNAVAILABLE';
  message: string;
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
