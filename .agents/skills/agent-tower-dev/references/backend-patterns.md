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
