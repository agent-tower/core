# Agent Tower - 架构设计文档

## 1. 整体架构

### 1.1 架构概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Agent Tower                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Frontend (React + Vite)                       │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │   │
│  │  │  看板页  │ │ 任务详情 │ │ 终端面板 │ │   Git 操作面板   │   │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                    REST API / WebSocket / SSE                           │
│                              │                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Backend (Node.js + Fastify)                   │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │                      Routes Layer                         │   │   │
│  │  │  /projects | /tasks | /workspaces | /sessions | /terminal │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  │                              │                                   │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │                    Services Layer                         │   │   │
│  │  │  ProjectService | TaskService | WorkspaceService | ...    │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  │                              │                                   │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐                  │   │
│  │  │  Executors │ │ Git Manager│ │  Process   │                  │   │
│  │  │ (AI 代理)  │ │ (Worktree) │ │  Manager   │                  │   │
│  │  └────────────┘ └────────────┘ └────────────┘                  │   │
│  │                              │                                   │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │                  Database (SQLite + Prisma)               │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      AI Agent Executors                          │   │
│  │         ┌────────────────┐       ┌────────────────┐             │   │
│  │         │  Claude Code   │       │   Gemini CLI   │             │   │
│  │         │   Executor     │       │    Executor    │             │   │
│  │         └────────────────┘       └────────────────┘             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| **后端框架** | Fastify | 高性能，TypeScript 原生支持 |
| **数据库** | SQLite + Prisma | 本地优先，类型安全 ORM |
| **进程管理** | node-pty | 伪终端支持，处理交互式 CLI |
| **Git 操作** | simple-git | 轻量级，Promise API |
| **实时通信** | WebSocket + SSE | 终端交互 + 事件推送 |
| **前端框架** | React 18 + Vite | 现代化开发体验 |
| **状态管理** | Zustand + TanStack Query | 轻量 + 服务端状态缓存 |
| **UI 组件库** | shadcn/ui + TailwindCSS | 可定制，基于 Radix UI |
| **包管理** | pnpm | Monorepo 支持，磁盘效率高 |

---

## 2. 项目结构

### 2.1 Monorepo 根目录

```
agent-tower/
├── packages/
│   ├── server/              # 后端服务
│   └── web/                 # 前端应用
├── docs/                    # 项目文档
│   ├── PROJECT_SPEC.md      # 项目规格说明
│   └── ARCHITECTURE.md      # 架构设计 (本文档)
├── package.json             # Monorepo 根配置
├── pnpm-workspace.yaml      # pnpm 工作空间配置
├── tsconfig.json            # 根 TypeScript 配置
├── .gitignore
└── README.md
```

### 2.2 后端结构 (packages/server)

```
packages/server/
├── src/
│   ├── index.ts             # 应用入口
│   ├── app.ts               # Fastify 应用配置
│   │
│   ├── routes/              # API 路由层
│   │   ├── index.ts         # 路由注册
│   │   ├── projects.ts      # 项目相关路由
│   │   ├── tasks.ts         # 任务相关路由
│   │   ├── workspaces.ts    # 工作空间相关路由
│   │   ├── sessions.ts      # 会话相关路由
│   │   └── system.ts        # 系统路由 (健康检查等)
│   │
│   ├── services/            # 业务逻辑层
│   │   ├── project.service.ts
│   │   ├── task.service.ts
│   │   ├── workspace.service.ts
│   │   └── session.service.ts
│   │
│   ├── executors/           # AI 代理执行器
│   │   ├── index.ts         # 执行器注册与工厂
│   │   ├── base.executor.ts # 执行器基类
│   │   ├── claude-code.executor.ts
│   │   └── gemini-cli.executor.ts
│   │
│   ├── git/                 # Git 操作模块
│   │   └── worktree.manager.ts
│   │
│   ├── process/             # 进程管理模块
│   │   └── process.manager.ts
│   │
│   ├── websocket/           # WebSocket 处理
│   │   └── terminal.handler.ts
│   │
│   ├── events/              # SSE 事件推送
│   │   └── event.emitter.ts
│   │
│   ├── types/               # 类型定义
│   │   └── index.ts
│   │
│   └── utils/               # 工具函数
│       └── index.ts
│
├── prisma/
│   ├── schema.prisma        # 数据库模型定义
│   └── migrations/          # 数据库迁移文件
│
├── package.json
├── tsconfig.json
└── .env.example             # 环境变量示例
```

### 2.3 前端结构 (packages/web)

```
packages/web/
├── src/
│   ├── main.tsx             # 应用入口
│   ├── App.tsx              # 根组件
│   │
│   ├── pages/               # 页面组件
│   │   ├── ProjectList.tsx  # 项目列表页
│   │   ├── ProjectKanban.tsx # 项目看板页
│   │   └── NotFound.tsx     # 404 页面
│   │
│   ├── components/          # UI 组件
│   │   ├── ui/              # shadcn/ui 基础组件
   │   │   ├── button.tsx
│   │   │   ├── card.tsx
│   │   │   ├── dialog.tsx
│   │   │   └── ...
│   │   │
│   │   ├── layout/          # 布局组件
│   │   │   ├── Header.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── Layout.tsx
│   │   │
│   │   ├── kanban/          # 看板相关组件
│   │   │   ├── KanbanBoard.tsx
│   │   │   ├── KanbanColumn.tsx
│   │   │   └── KanbanCard.tsx
│   │   │
│   │   ├── task/            # 任务相关组件
│   │   │   ├── TaskDetail.tsx
│   │   │   ├── TaskForm.tsx
│   │   │   └── TaskStatusBadge.tsx
│   │   │
│   │   ├── terminal/        # 终端相关组件
│   │   │   └── Terminal.tsx
│   │   │
│   │   └── git/             # Git 相关组件
│   │       ├── DiffViewer.tsx
│   │       └── MergePanel.tsx
│   │
│   ├── hooks/               # 自定义 Hooks
│   │   ├── useProjects.ts   # 项目数据 hook
│   │   ├── useTasks.ts      # 任务数据 hook
│   │   ├── useWorkspaces.ts # 工作空间数据 hook
│   │   ├── useSessions.ts   # 会话数据 hook
│   │   └── useTerminal.ts   # 终端 WebSocket hook
│   │
│   ├── stores/              # Zustand 状态管理
│   │   └── ui.store.ts      # UI 状态 (侧边栏、模态框等)
│   │
│   ├── api/                 # API 客户端
│   │   ├── client.ts        # HTTP 客户端配置
│   │   ├── projects.ts      # 项目 API
│   │   ├── tasks.ts         # 任务 API
│   │   ├── workspaces.ts    # 工作空间 API
│   │   └── sessions.ts      # 会话 API
│   │
│   ├── types/               # 类型定义
│   │   └── index.ts
│   │
│   ├── lib/                 # 工具库
│   │   └── utils.ts         # 通用工具函数
│   │
│   └── styles/              # 样式文件
│       └── globals.css      # 全局样式 + Tailwind
│
├── public/                  # 静态资源
│   └── favicon.ico
│
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
└── components.json          # shadcn/ui 配置
```

---

## 3. 分层职责

### 3.1 后端分层

| 层级 | 职责 | 示例 |
|------|------|------|
| **Routes** | 请求处理、参数校验、响应格式化 | 接收 POST /api/tasks，校验参数，调用 service |
| **Services** | 业务逻辑、数据库操作、事务管理 | 创建任务、更新状态、关联工作空间 |
| **Executors** | AI 代理的启动、交互、生命周期管理 | 启动 Claude Code 进程，发送 prompt |
| **Git** | Git 仓库操作、Worktree 管理 | 创建分支、获取 diff、合并代码 |
| **Process** | 进程管理、PTY 交互 | 管理子进程、处理 stdin/stdout |

### 3.2 前端分层

| 层级 | 职责 | 示例 |
|------|------|------|
| **Pages** | 页面级组件、路由入口 | ProjectKanban 页面 |
| **Components** | 可复用 UI 组件 | KanbanCard、TaskForm |
| **Hooks** | 数据获取、状态逻辑封装 | useTasks 封装任务 CRUD |
| **Stores** | 全局 UI 状态管理 | 侧边栏展开状态、当前选中任务 |
| **API** | HTTP 请求封装 | 调用后端 REST API |

---

## 4. 通信机制

### 4.1 REST API

用于常规的 CRUD 操作：

```
GET    /api/projects           # 获取项目列表
POST   /api/projects           # 创建项目
GET    /api/tasks/:id          # 获取任务详情
PATCH  /api/tasks/:id/status   # 更新任务状态
...
```

### 4.2 WebSocket

用于终端实时交互：

```
/ws/terminal/:sessionId

客户端 → 服务端: { type: "input", data: "ls -la\n" }
服务端 → 客户端: { type: "output", data: "total 24\n..." }
```

### 4.3 SSE (Server-Sent Events)

用于服务端事件推送：

```
GET /api/events

事件类型:
- task:status_changed    # 任务状态变更
- session:started        # 会话启动
- session:completed      # 会话完成
- workspace:created      # 工作空间创建
```

---

## 5. 设计决策

### 5.1 为什么不使用共享包 (shared package)？

**决策**: 第一版暂不创建 `packages/shared`

**理由**:
- 项目初期，前后端类型定义变化频繁
- 共享包增加构建复杂度和依赖管理成本
- 当前规模下，类型重复的成本可接受
- 后续如有明确需求，可以再抽取

### 5.2 为什么选择按职责分层而非按领域分层？

**决策**: 后端采用 `routes/services/executors` 的职责分层

**理由**:
- 项目规模中等，领域边界清晰
- 职责分层更直观，新成员容易理解
- 避免过度设计，保持简单
- 如果后续模块增多，可以逐步迁移到领域分层

### 5.3 为什么前端组件按类型分组？

**决策**: 采用 `components/hooks/stores` 的类型分组

**理由**:
- 组件数量预计在 30-50 个，类型分组足够清晰
- 避免过深的目录嵌套
- shadcn/ui 组件统一放在 `components/ui/` 下，便于管理

---

## 6. 文件命名规范

### 6.1 后端

| 类型 | 命名规范 | 示例 |
|------|----------|------|
| 路由文件 | `{resource}.ts` | `projects.ts`, `tasks.ts` |
| 服务文件 | `{resource}.service.ts` | `project.service.ts` |
| 执行器文件 | `{agent-name}.executor.ts` | `claude-code.executor.ts` |
| 类型文件 | `index.ts` 或 `{domain}.types.ts` | `index.ts` |

### 6.2 前端

| 类型 | 命名规范 | 示例 |
|------|----------|------|
| 页面组件 | `PascalCase.tsx` | `ProjectKanban.tsx` |
| UI 组件 | `PascalCase.tsx` | `KanbanCard.tsx` |
| Hooks | `use{Name}.ts` | `useTasks.ts` |
| Stores | `{name}.store.ts` | `ui.store.ts` |
| API 文件 | `{resource}.ts` | `tasks.ts` |

---

## 更新记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2025-02-04 | v0.1 | 初始版本，确定项目结构和分层设计 |
