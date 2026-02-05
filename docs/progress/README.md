# Agent Tower 开发进度

> 最后更新：2026-02-05

## 项目概述

Agent Tower 是一个用于管理 AI Agent 任务的看板 Web 应用。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Vite 7 + TypeScript 5 |
| 样式 | TailwindCSS v4 + shadcn/ui |
| 状态管理 | TanStack Query (服务端) + Zustand (客户端) |
| 后端 | Fastify + Socket.IO |
| 数据库 | Prisma (待配置) |
| 包管理 | pnpm monorepo |

## 已完成功能

### 1. 项目基础架构

- [x] pnpm monorepo 结构
- [x] 共享类型包 `@agent-tower/shared`
- [x] 前端包 `packages/web`
- [x] 后端包 `packages/server`

### 2. 前端 (packages/web)

#### 2.1 基础设施
- [x] Vite 7 + React 19 + TypeScript 5 初始化
- [x] TailwindCSS v4 配置（CSS-first，无 tailwind.config.js）
- [x] 路径别名 `@/*` 配置
- [x] shadcn/ui 组件库集成
  - [x] Button 组件
  - [x] Card 组件

#### 2.2 路由
- [x] React Router 配置
- [x] 懒加载路由（bundle-dynamic-imports 模式）
- [x] RootLayout 布局组件
- [x] HomePage 首页

#### 2.3 状态管理
- [x] TanStack Query 配置
  - [x] QueryClient 配置
  - [x] QueryClientProvider 集成
- [x] Zustand stores
  - [x] `ui-store` - UI 状态（侧边栏、主题）
  - [x] `agent-store` - Agent 状态管理

#### 2.4 API 层
- [x] API 客户端封装 (`lib/api-client.ts`)
- [x] 错误处理 (`ApiError` 类)

#### 2.5 Socket.IO 客户端
- [x] Socket Manager 单例
  - [x] 连接管理
  - [x] 自动重连
  - [x] 命名空间支持
- [x] Hooks
  - [x] `useTerminal` - 终端连接管理
  - [x] `useAgentStatus` - Agent 状态订阅

### 3. 后端 (packages/server)

#### 3.1 基础设施
- [x] Fastify 服务器
- [x] CORS 配置
- [x] 路由注册

#### 3.2 Socket.IO 服务
- [x] Socket.IO 初始化与 Fastify 集成
- [x] 命名空间架构
  - [x] `/terminal` - 终端 PTY 流
  - [x] `/agents` - Agent 状态通知
- [x] 中间件
  - [x] 认证中间件 (`auth.ts`)
  - [x] 错误处理 (`error-handler.ts`)
- [x] Handlers
  - [x] `terminal.handler.ts` - 终端事件处理
  - [x] `agent.handler.ts` - Agent 状态广播

#### 3.3 进程管理
- [x] ProcessManager - PTY 进程管理
- [x] Executors
  - [x] Claude Code Executor
  - [x] Gemini CLI Executor

#### 3.4 业务服务
- [x] Project Service
- [x] Session Service
- [x] Task Service
- [x] Workspace Service

### 4. 共享包 (packages/shared)

- [x] Socket 事件类型定义
  - [x] 命名空间常量
  - [x] Terminal 事件类型
  - [x] Agent 事件类型
  - [x] Payload 类型
  - [x] ACK 响应类型

## 待开发功能

### 前端
- [ ] 终端组件（xterm.js 集成）
- [ ] 看板 UI
- [ ] Agent 列表/详情页面
- [ ] 任务创建/编辑表单

### 后端
- [ ] 数据库 Schema 设计
- [ ] REST API 完善
- [ ] Agent 生命周期管理

### 其他
- [ ] 认证系统
- [ ] 错误监控
- [ ] 日志系统

## 目录结构

```
packages/
├── shared/                     # 共享类型
│   └── src/
│       └── socket/
│           ├── events.ts       # Socket 事件定义
│           └── index.ts
├── server/                     # 后端服务
│   └── src/
│       ├── app.ts              # Fastify 应用
│       ├── index.ts            # 入口
│       ├── socket/             # Socket.IO
│       │   ├── index.ts
│       │   ├── events.ts
│       │   ├── rooms.ts
│       │   ├── middleware/
│       │   └── handlers/
│       ├── process/            # 进程管理
│       ├── executors/          # Agent 执行器
│       ├── services/           # 业务服务
│       └── routes/             # REST 路由
└── web/                        # 前端应用
    └── src/
        ├── App.tsx
        ├── main.tsx
        ├── index.css
        ├── components/ui/      # shadcn/ui 组件
        ├── layouts/            # 布局组件
        ├── pages/              # 页面组件
        ├── routes/             # 路由配置
        ├── stores/             # Zustand stores
        └── lib/
            ├── utils.ts
            ├── api-client.ts
            ├── query-client.ts
            └── socket/         # Socket.IO 客户端
                ├── manager.ts
                └── hooks/
```
