---
name: agent-tower-dev
description: >-
  Agent Tower 项目开发指南。在 Agent Tower 项目中进行任何开发工作时自动加载：添加 REST API 路由、编写 Service、
  创建前端 TanStack Query hooks、添加 Socket.IO 事件、修改 Prisma schema、实现新的 Agent Executor/Parser、
  或扩展 MCP tools。涵盖后端（Fastify + Prisma + Socket.IO）、前端（React + TanStack Query + Zustand）、
  Pipeline（PTY + Parser + MsgStore）三层架构的开发模式与约定。
---

# Agent Tower 开发指南

## 架构概览

```
Project → Task → Workspace (git worktree) → Session (AI agent) → ExecutionProcess
```

三层分包：`packages/shared`（类型）、`packages/server`（后端）、`packages/web`（前端）。

## 开发命令

```bash
pnpm install                                    # 安装依赖
pnpm --filter @agent-tower/shared build         # 构建共享包（改类型后必须先构建）
pnpm --filter @agent-tower/server dev           # 后端开发
pnpm --filter web dev                           # 前端开发
```

## 后端开发

后端分层：`Routes → Services → Prisma/EventBus`。详见 [references/backend-patterns.md](references/backend-patterns.md)。

### 添加新 API 端点

1. 在 `packages/server/src/services/` 创建 `{resource}.service.ts`，注入 `EventBus`/`SessionManager`
2. 在 `packages/server/src/routes/` 创建路由文件，使用 Zod 校验 + `handleError()` 统一错误处理
3. 在 `packages/server/src/routes/index.ts` 的 `registerRoutes()` 中注册路由
4. 如需实时推送，在 `EventBus` 的 `EventMap` 中添加事件类型

### 关键约定

- 服务通过 `packages/server/src/core/container.ts` 单例获取：`getEventBus()`, `getSessionManager()` 等
- 错误使用 `packages/server/src/errors.ts` 中的 `ServiceError` 子类：`NotFoundError`, `ValidationError`, `InvalidStateTransitionError`
- 数据库操作直接使用 `prisma` 全局实例（从 `../utils/index.js` 导入）
- 数据库 status/agentType 等使用 `String` 类型，由 TypeScript enum 控制（不用 Prisma enum）

## 前端开发

前端分层：`Pages → Components → Hooks → Stores → API`。详见 [references/frontend-patterns.md](references/frontend-patterns.md)。

### 添加新数据查询/操作

1. 在 `packages/web/src/hooks/query-keys.ts` 添加 query key
2. 在 `packages/web/src/hooks/use-{resource}.ts` 编写 `useQuery`/`useMutation` hooks
3. API 调用通过 `apiClient`（`@/lib/api-client`）

### 关键约定

- Query hooks 用 `enabled: !!id` 控制条件查询
- Mutation 成功后通过 `queryClient.invalidateQueries()` 刷新缓存
- 共享类型从 `@agent-tower/shared` 导入
- UI 组件使用 shadcn/ui（Radix UI），样式用 TailwindCSS v4
- 客户端状态用 Zustand（`packages/web/src/stores/`）

## Socket.IO 事件

命名空间 `/events`，通过 room 订阅区分 topic。详见 [references/backend-patterns.md](references/backend-patterns.md) 的 Socket.IO 部分。

添加新事件：
1. 在 `packages/server/src/core/event-bus.ts` 的 `EventMap` 添加事件类型
2. 在 `packages/shared/src/socket/events.ts` 添加事件常量
3. 在 `packages/server/src/socket/socket-gateway.ts` 添加 EventBus → Socket.IO 转发

## Pipeline 与 Executor

添加新的 Agent 类型或修改 Parser。详见 [references/pipeline-patterns.md](references/pipeline-patterns.md)。

### Pipeline 生命周期

```
PTY.onData → MsgStore.pushStdout + Parser.processData()
PTY.onExit → Parser.finish() + MsgStore.pushFinished()
MsgStore.onPatch → EventBus.emit('session:patch')
```

### 添加新 Agent Executor

1. 在 `packages/server/src/executors/` 创建 `{agent}.executor.ts`，继承 `BaseExecutor`
2. 实现 `getAvailabilityInfo()`, `getCapabilities()`, `spawn()`, `spawnFollowUp()`
3. 在 `packages/server/src/executors/index.ts` 注册到 factory

## 数据库变更

```bash
# 修改 packages/server/prisma/schema.prisma 后
cd packages/server && npx prisma migrate dev --name <migration-name>
```

## 共享类型

修改 `packages/shared/src/` 下的类型后，必须先构建共享包：
```bash
pnpm --filter @agent-tower/shared build
```

导出路径：`@agent-tower/shared`, `@agent-tower/shared/socket`, `@agent-tower/shared/types`, `@agent-tower/shared/log-adapter`。
