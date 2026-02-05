# Agent Tower

AI Agent 任务管理看板应用。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Vite 7 + TypeScript 5 |
| 样式 | TailwindCSS v4 + shadcn/ui |
| 状态管理 | TanStack Query (服务端状态) + Zustand (客户端状态) |
| 后端 | Fastify + Socket.IO |
| 数据库 | Prisma |
| 包管理 | pnpm monorepo |

## 项目结构

```
packages/
├── shared/          # 共享类型包 (@agent-tower/shared)
├── server/          # 后端服务 (@agent-tower/server)
└── web/             # 前端应用
```

## 架构设计

### Socket.IO 命名空间

| 命名空间 | 用途 |
|----------|------|
| `/terminal` | 终端 PTY 流（Agent 输出/输入） |
| `/agents` | Agent 状态通知 |

### 前端状态管理

- **TanStack Query**: 服务端数据缓存、请求去重、后台刷新
- **Zustand**: 客户端 UI 状态、Agent 状态

### 关键目录

```
packages/server/src/
├── socket/           # Socket.IO 服务
│   ├── handlers/     # 事件处理器
│   └── middleware/   # 认证、错误处理
├── executors/        # Agent 执行器 (Claude Code, Gemini CLI)
├── process/          # PTY 进程管理
├── services/         # 业务服务
└── routes/           # REST API

packages/web/src/
├── components/ui/    # shadcn/ui 组件
├── lib/socket/       # Socket.IO 客户端
│   └── hooks/        # useTerminal, useAgentStatus
├── stores/           # Zustand stores
├── pages/            # 页面组件
└── routes/           # 路由配置
```

## 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm --filter web dev        # 前端
pnpm --filter @agent-tower/server dev  # 后端

# 构建
pnpm --filter web build
pnpm --filter @agent-tower/server build
pnpm --filter @agent-tower/shared build
```

## 代码规范

- 使用 TypeScript 严格模式
- 前后端共享类型定义放在 `@agent-tower/shared`
- Socket 事件使用常量定义，避免魔法字符串
- React 组件使用函数式组件 + Hooks
