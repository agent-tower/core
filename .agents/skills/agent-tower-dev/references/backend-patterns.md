# 后端开发模式

## 生命周期与分层

以 `packages/server/src/app.ts` 为组合根。Route 解析 HTTP，Service 维护业务状态，manager/pipeline 拥有长生命周期资源，EventBus 连接业务和 Socket。

在 `onReady` 启动 timer、watcher、Socket 或 worker 时，在 `onClose` 添加对应停止路径。`core/container.ts` 只持有需要共享生命周期的实例；普通 Service 通常由 route 实例化。`getTerminalManager()` 因延迟加载原生 `node-pty` 而保持 async。

## Route 与 Service

优先参考同领域代码：常规 CRUD 看 `tasks.ts`/`task.service.ts`，编排看 `team-runs.ts`，文件与代理边界看 `files.ts`/`previews.ts`，进程控制看 `sessions.ts`/`workspaces.ts`。

添加端点时：

1. 用 Zod 解析不可信输入；multipart、proxy 等特殊 route 沿用邻近模式。
2. 让 Route 处理 status/error mapping，让 Service 处理事务、状态约束、副作用和补偿。
3. 在 `routes/index.ts` 注册正确 prefix；`previews` 同时拥有 `/api/previews`、独立 gateway listener 与兼容 `/view`，不要机械复制。
4. 使用 `ServiceError` 体系表达业务失败，但沿用当前 route 的 payload；错误响应尚未全局统一。

使用共享 `prisma`，server import 保留 `.js`。跨多行状态更新使用 transaction；数据库提交后的外部动作要有失败状态、重试或补偿。

## Prisma 数据边界

- 使用 UUID string 主键，业务状态通常保存为 `String` 并由 shared 类型约束。
- JSON string 字段在 Service mapper 中解析和序列化，并兼容旧值或损坏值。
- 为队列扫描、软删除和关系查找添加 index。
- Task 删除包含软删除和 `TaskCleanupJob` 文件系统清理，不能只依赖 cascade。
- 对外 DTO 经 mapper 转换，不直接扩散 Prisma row。

SQLite 在 `buildApp()` 注册路由前统一启用 WAL/busy timeout，并执行带版本号的幂等启动数据迁移。发布 CLI 使用 `prisma db push`，所以需要修改历史数据的 schema 变更不能只写 Prisma migration SQL；还要加入 `database-maintenance.service.ts` 的 runtime migration，并在同一事务末尾推进 `AppSettings.dataMigrationVersion`。

Task 看板热路径使用 `GET /api/task-board` 的紧凑 DTO，固定批量查询 task、首选 workspace 和 latest session；完整 description、workspace/session 历史按详情接口读取。不要在列表 mapper 中加载完整关系、正文或按 project/task 循环查询。

Task 创建边界对超长单一 `title` 输入做确定性拆分：`TaskService` 按完整 Unicode code point 边界从原文一次派生展示 title、已消费范围和保留原始空白的剩余 body，再将 body 放在独立传入的 description 之前。该不变量只约束创建，不改变既有 update 契约，也不回写历史 Task 或 RoomMessage。普通的独立 title/description 保持各自语义；TeamRun 首条消息、WorkRequest instruction 和 Agent prompt 统一拼接 `title + description`，只用 trim 判断 description 是否为空，实际内容保留 description 原始空白，不得通过比较文本内容猜测是否来自 autosplit。

Project 的 Git capability 是持久化读模型。Project/Task/board 列表只读保存值，不运行 `git rev-parse`；创建、恢复、显式 refresh，以及 Worktree/TeamRun 这类危险操作前才实时探测并回写。旧库 null capability 可以做廉价 `.git` fallback，但不能在列表请求启动 Git 子进程。

Project 列表的 `lastActivityAt` 是后端聚合读模型：取最近一条未删除 Task 的 `createdAt`，无任务时回退 Project `createdAt`；Task 后续更新不推进该时间。项目选择器必须使用该字段排序，不要从受筛选和分页限制的 task board 在前端反推。

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
- 预期跨 Agent turn 持续运行的 server、watcher 和 worker 必须走 workspace-context background service MCP；普通 Agent PTY 仍在 turn 结束时清理整棵进程树，不使用 `nohup`、`disown` 或字符串拦截绕过。
- `WorkspaceBackgroundService` 定义归 workspace，独立 PTY 归 app-owned process manager；Agent Session/CLI/ACP/Socket 结束不停止它。显式 stop、workspace hibernate/archive/delete、task/project cleanup 会先停止进程树并将 desired state 置为 STOPPED；reactivate 不恢复。desired/runtime 都是 STOPPED 且没有 runtime identity 的完整停止定义保留用于同名同配置重启，但不出现在列表中，也不占每 workspace 20 个服务的配额；新建或重新激活完整停止定义都必须在 workspace lifecycle barrier 内检查配额。merge 默认阻止仍有活跃 runtime 的源 workspace，只有调用方明确确认 `stopActiveServices` 时，才能在完成 merge gate 后先停止服务、重新检查再合并。start/restart 与 merge、hibernate、archive、delete、task/project cleanup 必须共用 app 级 workspace lifecycle barrier，并在 barrier 内完成 stop、文件系统动作和终态写入。应用优雅关闭只停止 runtime 并保留 desired state，启动时重建仍有效的 desired RUNNING 服务。
- 后台服务命令使用 `command + args[]` 和 workspace 内相对 cwd，不接受任意 env 或 shell 字符串；托管 Agent 使用服务端签发并绑定 session/invocation 的 opaque credential，不接触应用级 internal token。后端从 credential 恢复身份并绑定 session/workspace，TeamRun 还重验 invocation、active member 与 `runCommands`。credential 跟随 DriverSession/MCP transport，跨自然完成与 follow-up 保持有效，只在 DriverSession dispose、显式 Session stop/delete、启动失败或 app destroy 时撤销。workspace-service REST 只允许通过 AccessAuth 的 browser caller 读取 list/logs；start/update/input/stop/restart 仍仅限 Agent/MCP/internal 并在 route/service 双层拒绝 browser，公共 status cookie、缺少 Origin/Referer 或自报 identity 都不能换取控制权限。服务自然退出只记录 EXITED/FAILED，不自动 crash restart；日志仅为内存有界 buffer，实体删除时显式释放。日志 seq 只在同一 `runtimeInstanceId` generation 内有效；增量请求携带上一响应的 generation，响应返回 manager 的真实 generation 与独立 `reset`/`truncated`/`hasMore`，客户端按 generation 替换缓存且不能把正常分页当成日志丢失。
- Unix workspace background process 的 root PTY 与 descendant process group 所有 poll/signal 都必须经过可注入 identity adapter，并在发送信号前复验 PID/PGID、birth identity 和每次 launch 的唯一 ownership token；禁止回退到未校验的 `pty.kill`/`child.kill`。Linux 使用 `/proc` start ticks，macOS 的秒级 start marker 必须与唯一 launch token 组合，避免同秒 PID/PGID 复用误杀。Windows 保留 `taskkill /T /F` tree-kill 路径。

## 认证与安全

HTTP 同时受 tunnel session 和可选 access password 保护；应用级内部进程/手动 MCP 使用 internal token，托管 Agent 使用 per-session/invocation credential，浏览器使用签名 HttpOnly cookie 与同源写请求检查，Socket namespace 有对应认证。

- 公共 endpoint 白名单保持最小，Agent CLI 安装接口保持 local-only。
- Access password Cookie 名称必须在请求时根据规范化的绝对 data directory 派生，不能在模块加载阶段缓存，也不能按端口区分；这样同一 hostname 上的正式、开发和桌面实例不会互相覆盖。读取时只兼容当前实例名与旧版 `agent-tower-access`，preview 的过滤与目标 Cookie 隔离必须识别整个合法名称族。
- 使用 `writeErrorLog` 脱敏，不记录 token、cookie、prompt、provider secret 或 TeamRun identity。
- Preview UI 通过 `/api/previews/:workspaceId/sessions` 获取独立根路径 gateway；本地会话使用 gateway 端口，远程会话按 workspace 复用独立 Quick Tunnel。客户端每 30 秒续租，释放或失联后进入 10 分钟空闲回收；target 改变和 server shutdown 立即清理。`/view/:workspaceId` 仅保留旧客户端兼容，不再作为新 UI 主链路。
- Gateway bootstrap 必须使用 workspace preview token 换取独立 HttpOnly Cookie；AccessAuth secret 轮换时同步使 gateway secret 失效。目标仍只允许 loopback。外层 Agent Tower 的 access/tunnel/gateway Cookie 不得转发给目标；若目标本身也是 Agent Tower，其同名认证 Cookie 必须按 workspace 改名隔离，并在转发前恢复目标原名。远程跨站 iframe 的目标 Cookie 使用 `Secure; SameSite=None; Partitioned`，同时剥离传给目标的 Cloudflare 客户端标识头，避免目标误判为自身 tunnel 流量。代理保留目标根路径、HTTP/WebSocket 和流式响应，只做 frame header、同 target 绝对 redirect、Cookie domain/basePath 与可选 bridge 注入，不恢复通用 HTML/CSS/JS 路径重写。修改 gateway、redirect、WebSocket、header、cookie 或 idle lifecycle 时运行 integration tests。
- 文件 route 复用 realpath/root/symlink 检查，不直接读写用户拼出的路径。
- Codex inline visualization 只从有效 `CODEX_HOME/visualizations/YYYY/MM/DD/<threadId>` 读取当前 Session snapshot 绑定的 thread 文件；文件名、realpath containment、大小和 iframe CSP/sandbox 都必须在服务端约束，不能把 Agent 返回的路径直接交给浏览器。
- `agent-download` 是 provider-neutral 的文件交付意图。CHAT turn 的运行时 prompt 会说明 `::agent-download{file="relative/path"}`；Session 完成后从 assistant/来源 invocation 消息提取声明，将通过 workspace/conversation 身份解析、realpath/symlink/大小校验的文件复制到 `data/artifacts`，按 Session + sourcePath 记录 hash 元数据。下载只能读取校验后的持久化副本；不得把客户端提供的 workingDir 或 Agent 原始路径直接作为下载文件。

## MCP

MCP 是 REST 客户端，不直接访问 Prisma。普通工具位于 `mcp/tools/`，TeamRun room/queue 工具目前在 `mcp/server.ts`。

使用 Zod 定义输入并复用 HTTP 业务行为。区分全局、workspace-context 和 TeamRun invocation 工具。TeamRun 身份只能来自进程注入的环境变量，不能接受 agent 自报 member/invocation id 绕过 capability 或可见性。工具变化同步 MCP tests 和公开文档。

涉及 Prisma、timer、watcher、Socket 或 child process 的测试使用隔离 data dir/database，并显式销毁资源。
