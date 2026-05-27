---
title: 架构
description: Agent Tower 当前代码库的真实架构。
---

# 架构

Agent Tower 是一个本地优先、单用户的 AI agent 调度平台。核心能力包括任务看板、Git worktree 隔离、实时终端/日志、Provider 管理、MCP 集成、附件、通知和移动端访问。

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
│  Extras: Tunnel / Notifications / Attachments / Commit messages    │
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
│   └── docs-site/   # Docusaurus 文档站
├── docs/            # 项目内部文档和历史设计资料
├── design/          # 设计稿与实验性资料
├── scripts/         # 构建/发布脚本
└── pnpm-workspace.yaml
```

## 后端分层

`packages/server` 中主要模块：

| 目录 | 职责 |
| --- | --- |
| `src/routes` | REST API 路由注册与参数校验 |
| `src/services` | 项目、任务、工作区、会话、终端、通知、隧道等业务逻辑 |
| `src/core` | 轻量容器与进程内 EventBus |
| `src/pipeline` | AgentPipeline，负责单个 session 的 PTY 生命周期 |
| `src/output` | agent 输出解析、MsgStore、JSON Patch、Todo/Token 提取 |
| `src/executors` | Claude Code、Gemini CLI、Cursor Agent、Codex 执行器 |
| `src/socket` | Socket.IO namespace、room 转发、订阅协议 |
| `src/git` | worktree、merge、rebase、冲突状态和 Git 错误封装 |
| `src/mcp` | MCP server 与 tool 注册 |

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
  -> SocketGateway 转发到 session room
  -> 前端增量更新日志 / Todo / token usage
```

关键点：

- `MsgStore` 保存 stdout、patch、sessionId 等消息，并能重建快照
- 快照会被 debounce 持久化到数据库
- parser 会尽量把原始终端输出结构化为标准化消息
- 不同 agent 的输出格式不同，结构化能力取决于对应 parser
