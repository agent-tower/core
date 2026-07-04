---
title: 架构
description: Agent Tower 当前代码库的真实架构。
---

# 架构

Agent Tower 是一个本地优先、单用户的 AI agent 调度平台。核心能力包括任务看板、Git worktree 隔离、实时终端/日志、Provider 管理、TeamRun 协作、MCP 集成、附件、预览代理、通知、移动端访问和桌面端壳。

## 总览

```text
┌─────────────────────────────────────────────────────────────────────┐
│                           Browser / Mobile                         │
│  React Router ─ TanStack Query ─ Zustand ─ Socket.IO Client        │
│  Task Kanban ─ Task Detail ─ Log Stream ─ Workspace Panel          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                    HTTP REST + Socket.IO (/events)
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                         Fastify Application                         │
│  Routes ─ Services ─ EventBus ─ SocketGateway ─ MCP HTTP Client    │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ SessionManager + AgentPipeline                              │   │
│  │ PTY stdout/stderr -> Parser -> MsgStore -> JSON Patch -> UI │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  Executors: Claude Code / Gemini CLI / Cursor Agent / Codex        │
│  Git: WorktreeManager / git-cli / merge / rebase / conflict check  │
│  Extras: TeamRun / Tunnel / Notifications / Attachments / Preview  │
│          Commit messages / Agent CLI environment bootstrap         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                     Prisma ORM + SQLite Database
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 19 + Vite 7 + TypeScript 5 |
| 样式 | TailwindCSS v4 + shadcn/ui |
| 状态管理 | TanStack Query v5 + Zustand v5 |
| 实时通信 | Socket.IO 4 |
| 后端 | Fastify 4 |
| 数据库 | Prisma 5 + SQLite |
| 进程管理 | node-pty |
| Git | 原生 git CLI 封装 |
| 协议扩展 | MCP SDK |
| 包管理 | pnpm monorepo |

## Monorepo 结构

```text
agent-tower/
├── packages/
│   ├── shared/      # 前后端共享类型、Socket 事件、日志适配、端口工具
│   ├── server/      # Fastify + Prisma + Socket.IO + MCP
│   ├── web/         # React 前端
│   ├── desktop/     # Electron 桌面壳和打包脚本
│   └── docs-site/   # Docusaurus 文档站
├── docs/            # 项目内部文档和历史设计资料
├── design/          # 设计稿与实验性资料
├── scripts/         # 构建/发布脚本
├── Dockerfile
├── docker-compose.yml
└── pnpm-workspace.yaml
```

## 后端分层

`packages/server` 中主要模块：

| 目录 | 职责 |
| --- | --- |
| `src/routes` | REST API 路由注册与参数校验 |
| `src/services` | 项目、任务、工作区、会话、团队协作、终端、通知、隧道、预览代理等业务逻辑 |
| `src/core` | 轻量容器与进程内 EventBus |
| `src/pipeline` | AgentPipeline，负责单个 session 的 PTY 生命周期 |
| `src/output` | agent 输出解析、MsgStore、JSON Patch、Todo/Token 提取 |
| `src/executors` | Claude Code、Gemini CLI、Cursor Agent、Codex 执行器 |
| `src/socket` | Socket.IO namespace、room 转发、订阅协议 |
| `src/git` | worktree、merge、rebase、冲突状态和 Git 错误封装 |
| `src/mcp` | MCP server 与 tool 注册 |

## 桌面端

`packages/desktop` 是 Electron 壳。开发模式下它启动 workspace 中构建后的 server 和 web；打包模式下它从 app resources 中启动 bundled server runtime，并加载 bundled Web 静态资源。

当前桌面端还提供 MCP 配置复制入口。打包模式下 MCP 配置指向 bundled runtime，不要求用户安装全局 `agent-tower-mcp`。

## 前端组织

`packages/web` 主要围绕看板和任务详情组织：

| 目录 | 职责 |
| --- | --- |
| `src/routes` | 路由定义 |
| `src/layouts` | 根布局与设置页布局 |
| `src/pages` | 首页看板、设置页、demo 页 |
| `src/components/task` | 任务列表、任务详情、启动 agent 对话框 |
| `src/components/workspace` | 编辑器、变更视图、终端、Git 操作、历史视图 |
| `src/components/agent` | 日志流、Todo 面板、Token 用量 |
| `src/hooks` | TanStack Query hooks |
| `src/lib/socket` | Socket 连接和订阅 |
| `src/stores` | UI 状态与 agent 状态 |

## Session Pipeline

```text
PTY.onData
  -> MsgStore.pushStdout()
  -> Parser.processData()
  -> MsgStore.pushPatch()
  -> EventBus.emit('session:patch')
  -> SocketGateway 转发到 /events namespace
  -> 前端增量更新日志 / Todo / token usage
```

关键点：

- `MsgStore` 保存 stdout、patch、sessionId 等消息，并能重建快照
- 快照会被 debounce 持久化到数据库
- parser 会尽量把原始终端输出结构化为标准化消息
- 不同 agent 的输出格式不同，结构化能力取决于对应 parser

## TeamRun 协作

TeamRun 把一个 Task 下的工作拆成成员、房间消息、工作请求和 agent invocation：

```text
Task -> TeamRun -> TeamMember
                -> RoomMessage -> WorkRequest -> AgentInvocation -> Session
                -> main workspace / dedicated child workspace
```

TeamRun 支持 `AUTO` 和 `CONFIRM` 两种模式。成员通过 Team Room 公开消息或私聊协作，`@` 提及会创建 WorkRequest；调度器根据成员的触发策略、workspace 策略、session 策略和队列策略启动或排队后续工作。

## 预览代理

Workspace 可以配置一个本机 loopback 预览目标，例如 `127.0.0.1:5173`。后端通过 `/view/:workspaceId` 做同源反向代理，并对 HTML/CSS/JS 中的常见绝对路径做重写。预览目标只允许 `localhost`、`127.0.0.1` 或 `::1`，避免把 Agent Tower 变成任意外部代理。
