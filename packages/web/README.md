# `packages/web`

Agent Tower 的前端应用，基于 React、Vite、TanStack Query、Zustand 和 Socket.IO Client 构建。

## 主要职责

- 展示项目与任务看板
- 展示任务详情、日志流、Todo、token usage
- 提供 workspace 工作台：编辑器、终端、Git changes、历史视图
- 通过 REST API 读写数据
- 通过 Socket.IO 订阅任务、会话、终端和工作区实时事件

## 开发命令

```bash
pnpm --filter web dev
pnpm --filter web build
pnpm --filter web lint
```

默认情况下，前端使用相对路径 `/api` 和同源 Socket.IO `/events`。
开发模式下 Vite 会把 `/api`、`/socket.io`、`/view` 代理到后端，避免浏览器直连后端端口。

如果后端运行在动态端口，显式配置代理目标即可：

```bash
# 终端 1：启动后端，记录输出里的端口
pnpm --filter @agent-tower/server dev

# 终端 2：把前端同源请求代理到该后端端口
VITE_API_PROXY_TARGET=http://localhost:33952 pnpm --filter web dev --port 5175
```

也兼容旧变量：

```bash
VITE_API_URL=http://localhost:33952/api pnpm --filter web dev --port 5175
```

在 dev 模式中，如果 `VITE_API_URL` / `VITE_SOCKET_URL` 是本机绝对地址，浏览器端仍会使用同源相对路径，由 Vite 代理到目标后端。这样可以在 `http://localhost:5175` 打开设置页的“Agent 环境”，测试检测、预览和日志轮询流程，同时不放宽后端 local-only 安全规则。

## 目录概览

```text
src/
├── routes/        # 路由定义
├── layouts/       # 页面布局
├── pages/         # 看板页、设置页、demo 页
├── components/
│   ├── task/      # 任务列表、任务详情、启动 Agent 对话框
│   ├── workspace/ # 编辑器、终端、Git 视图、历史视图
│   ├── agent/     # 日志流、Todo、token usage
│   └── ui/        # 通用 UI 组件
├── hooks/         # TanStack Query hooks
├── lib/
│   ├── api-client.ts
│   └── socket/    # Socket manager 与订阅 hooks
└── stores/        # Zustand stores
```

## 关键实现约定

- 服务端状态优先走 TanStack Query
- 客户端 UI 状态使用 Zustand
- 应用启动时只建立一个 Socket 连接，各功能按需订阅 room
- 共享类型与 Socket 事件定义来自 `@agent-tower/shared`

## 相关文档

- 根目录 `README.md`
- `docs/ARCHITECTURE.md`
- `docs/PROJECT_SPEC.md`
