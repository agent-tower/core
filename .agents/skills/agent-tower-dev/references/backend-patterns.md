# 后端开发模式

## 生命周期与分层

以 `packages/server/src/app.ts` 为组合根。Route 解析 HTTP，Service 维护业务状态，manager/pipeline 拥有长生命周期资源，EventBus 连接业务和 Socket。

在 `onReady` 启动 timer、watcher、Socket 或 worker 时，在 `onClose` 添加对应停止路径。`core/container.ts` 只持有需要共享生命周期的实例；普通 Service 通常由 route 实例化。`getTerminalManager()` 因延迟加载原生 `node-pty` 而保持 async。

## Route 与 Service

优先参考同领域代码：常规 CRUD 看 `tasks.ts`/`task.service.ts`，编排看 `team-runs.ts`，文件与代理边界看 `files.ts`/`previews.ts`，进程控制看 `sessions.ts`/`workspaces.ts`。

添加端点时：

1. 用 Zod 解析不可信输入；multipart、proxy 等特殊 route 沿用邻近模式。
2. 让 Route 处理 status/error mapping，让 Service 处理事务、状态约束、副作用和补偿。
3. 在 `routes/index.ts` 注册正确 prefix；`previews` 同时拥有 `/api/previews` 与 `/view`，不要机械复制。
4. 使用 `ServiceError` 体系表达业务失败，但沿用当前 route 的 payload；错误响应尚未全局统一。

使用共享 `prisma`，server import 保留 `.js`。跨多行状态更新使用 transaction；数据库提交后的外部动作要有失败状态、重试或补偿。

## Prisma 数据边界

- 使用 UUID string 主键，业务状态通常保存为 `String` 并由 shared 类型约束。
- JSON string 字段在 Service mapper 中解析和序列化，并兼容旧值或损坏值。
- 为队列扫描、软删除和关系查找添加 index。
- Task 删除包含软删除和 `TaskCleanupJob` 文件系统清理，不能只依赖 cascade。
- 对外 DTO 经 mapper 转换，不直接扩散 Prisma row。

Schema 变化后更新 Prisma client，并为可发布数据变化提供 migration；`db:push` 只用于无需保留历史的开发库。

## EventBus 与 Socket.IO

实时链路：

```text
Service/Manager -> EventMap -> SocketGateway -> shared event/payload -> web sync hook
```

添加事件时同步四处，并释放 Gateway/React listener。命名空间固定为 `/events`；部分业务事件在 namespace 广播后由前端按 payload 过滤，不要假设所有 topic 都精确进入 room。

`team-run:invalidated` 和 `workspace:git_changed` 是重新查询信号，不是完整状态快照。依赖实时事件的数据必须在重连后重新读取 authoritative REST state。

## Workspace 与后台资源

- `WORKTREE` 使用独立 branch/worktree；`MAIN_DIRECTORY` 直接使用项目目录并支持非 Git Solo。
- Agent、文件、终端和 preview 使用 DTO 的 `workingDir`，先判断 Git capability/workspace kind。
- 复用 `WorkspaceService` 与 `WorktreeManager`，不在 Route 或前端拼接 branch/worktree 路径。
- watcher、hibernation 和异步 cleanup 必须随 workspace/task 生命周期注册、恢复、释放或重试。

## 认证与安全

HTTP 同时受 tunnel session 和可选 access password 保护；内部进程使用 internal token，浏览器使用 HttpOnly cookie 与同源写请求检查，Socket namespace 有对应认证。

- 公共 endpoint 白名单保持最小，Agent CLI 安装接口保持 local-only。
- 使用 `writeErrorLog` 脱敏，不记录 token、cookie、prompt、provider secret 或 TeamRun identity。
- Preview 只代理 loopback，token 绑定 workspace；修改 rewrite、redirect、WebSocket 或 cookie 时运行 integration tests。
- 文件 route 复用 realpath/root/symlink 检查，不直接读写用户拼出的路径。

## MCP

MCP 是 REST 客户端，不直接访问 Prisma。普通工具位于 `mcp/tools/`，TeamRun room/queue 工具目前在 `mcp/server.ts`。

使用 Zod 定义输入并复用 HTTP 业务行为。区分全局、workspace-context 和 TeamRun invocation 工具。TeamRun 身份只能来自进程注入的环境变量，不能接受 agent 自报 member/invocation id 绕过 capability 或可见性。工具变化同步 MCP tests 和公开文档。

涉及 Prisma、timer、watcher、Socket 或 child process 的测试使用隔离 data dir/database，并显式销毁资源。
