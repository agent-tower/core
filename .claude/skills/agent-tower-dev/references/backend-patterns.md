# 后端开发模式

## 目录结构

```
packages/server/src/
├── core/             # 服务容器 (container.ts) + EventBus (event-bus.ts)
├── errors.ts         # ServiceError 层级
├── pipeline/         # AgentPipeline
├── output/           # 输出解析器 + MsgStore
├── executors/        # Agent 执行器
├── mcp/              # MCP 服务器
├── git/              # Git CLI + WorktreeManager
├── services/         # 业务服务层
├── routes/           # REST API 路由
├── socket/           # Socket.IO 网关
└── middleware/       # HTTP 中间件
```

## 路由模式 (Route)

**范本文件**：`packages/server/src/routes/tasks.ts`

关键要素：
- 文件顶部用 Zod 定义请求校验 schema
- 每个路由文件有自己的 `handleError()` 函数，统一处理 `ZodError` → 400、`ServiceError` → 对应状态码、未知错误 → 500
- 导出 `async function xxxRoutes(app: FastifyInstance)` 函数
- 在函数内通过 `container.ts` 获取依赖并实例化 Service
- 每个端点用 `try/catch` + `handleError`

**路由注册**：参照 `packages/server/src/routes/index.ts`，在 `registerRoutes()` 中用 `app.register(routes, { prefix })` 注册。

## 服务模式 (Service)

**范本文件**：`packages/server/src/services/task.service.ts`

关键要素：
- 构造函数注入 `EventBus` 和/或 `SessionManager`
- 用 `prisma` 全局实例操作数据库（从 `../utils/index.js` 导入）
- 资源不存在时 throw `NotFoundError`，校验失败 throw `ValidationError`
- 需要通知前端时通过 `this.eventBus.emit()` 发射事件

## 错误类型

参照 `packages/server/src/errors.ts`：`ServiceError`（基类）、`NotFoundError`、`ValidationError`、`InvalidStateTransitionError`。

## 服务容器

参照 `packages/server/src/core/container.ts`：通过 `getEventBus()`、`getSessionManager()` 等获取单例。注意 `getTerminalManager()` 是 async 的。

## EventBus

参照 `packages/server/src/core/event-bus.ts`：`EventMap` 定义所有事件类型。添加新事件直接在 `EventMap` 中加键值对。

## Socket.IO

**网关范本**：`packages/server/src/socket/socket-gateway.ts`
**事件常量**：`packages/shared/src/socket/events.ts`

架构：
- 单一命名空间 `/events`
- Room 模式：`session:{id}`, `terminal:{id}`, `task:{id}`, `project:{id}`, `agent:{id}`, `agent:all`
- `SocketGateway.registerEventBusForwarders()` 负责 EventBus → Socket.IO 转发

添加新事件的接触点：
1. `EventMap` 加事件类型
2. `events.ts` 加常量
3. `SocketGateway` 加转发逻辑

## Prisma

**Schema 位置**：`packages/server/prisma/schema.prisma`

关键约定：
- status/agentType 等用 `String` 类型，由应用层 TypeScript enum 控制（不用 Prisma enum）
- UUID 主键：`id String @id @default(uuid())`
- 修改 schema 后：`cd packages/server && npx prisma migrate dev --name <name>`

## 进程域 (Process Scope)

服务端启动的每个外部进程树都属于一个"进程域"：独立终端、`runOwnedCommand`/`spawnOwnedProcess`（git、CLI 安装与探测命令）。Linux 上进程域由 `prebuilds/linux-<arch>/agent-tower-scope` supervisor 托管（源码 `packages/server/native/scope-helper/`，构建 `node scripts/build-scope-helper.mjs`，支持 zig / cc / docker）：

- supervisor 是 child subreaper，后代无论 `setsid`、清空环境、父进程先退出都留在域内；停止时它负责转发信号、超时升级，**域为空时才退出**，其退出事件就是清理确认。主进程不再采样 `/proc`。
- 服务端接口在 `src/runtime/process-scope/`：`getDefaultProcessScopeRuntime()` 返回 supervisor 后端或 `null`（兼容后端：macOS/Windows、无 supervisor、`AGENT_TOWER_PROCESS_SCOPE=compat`）。`requestStop(pid, signal)` 转发优雅信号，`forceStop(pid)` 立即升级；**绝不能 SIGKILL supervisor 本身**，否则后代脱离域。
- 新的启动点请走 `spawnOwnedProcess`/`runOwnedCommand` 或 `TerminalManager`，不要直接 `spawn` 长生命周期进程。测试里用 `processScope: null` / `scope: null` 固定兼容后端，用假 runtime 验证 supervised 路径。
- 尚未迁移：CLI/ACP 会话与后台服务的 PTY wrapper（`process-launch.ts`）、`AcpProcessManager`、Windows Job Object。
- **命令助手进程**（`src/runtime/command-helper/`）：Linux 上 Node 用 `fork()` 启动子进程，服务端进程变大后每次启动都会阻塞事件循环 0.1–0.3 s（耗时来自 V8 堆之外的内存）。服务端入口（`cli.ts`、开发用 `index.ts`）在进程还小时 fork 一个小助手进程；助手运行时 `runOwnedCommand` 把命令交给它执行（同样的进程域、停止规则、超时和输出上限），否则在本进程执行。开关 `AGENT_TOWER_COMMAND_HELPER`：`auto`（默认，仅 Linux）、`on`（所有平台）、`off`（关闭）。
  - 助手退出时，进行中的命令以 `ERR_COMMAND_HELPER_EXITED` 拒绝，**绝不自动重跑**；退避重启期间命令回到本进程执行，连续失败后不再重启。服务端退出（含 SIGKILL）时助手停止它的命令后退出。
  - 助手卡住不回应时：命令超过“超时 + 停止宽限期”仍无结果，以 `ERR_COMMAND_HELPER_UNRESPONSIVE` 拒绝，助手被 SIGTERM/SIGKILL 替换；`stopCommandHelper()` 最多等 20 s。`on` 在 Linux 以外没有进程域 supervisor，助手崩溃或被强制停止时，正在运行的命令可能成为孤儿进程。
  - 查询与订阅：`isCommandHelperRunning()`、`onCommandHelperAvailabilityChange()`。流式的 `spawnOwnedProcess`、终端、Agent 会话不经过助手。
  - 测试默认不启动助手；让某个测试文件走助手：`npx vitest run --config vitest.command-helper.config.ts <file>`。
  - 服务端每分钟输出一行 `[runtime-metrics]`：事件循环延迟 p50/p99/max、经助手/本进程执行的命令数、助手重启次数和内存。
