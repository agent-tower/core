---
title: 架构
description: Agent Tower 当前代码库的真实架构。
---

# 架构

Agent Tower 是一个本地优先、单用户的 AI agent 调度平台。核心能力包括任务看板、Git worktree 隔离、实时终端/日志、Provider 管理、TeamRun 协作、MCP 集成、附件、预览代理、通知、移动端访问和桌面端壳。

## 改造前：CLI Pipeline

```text
Web / Desktop
      │ REST + Socket.IO
      ▼
SessionManager
      │ 选择 Executor、维护 PTY/Pipeline、处理业务状态
      ▼
BaseExecutor -> PTY -> AgentPipeline -> Parser -> MsgStore -> EventBus
```

这个结构把业务会话和 CLI 进程生命周期放在同一个模块中，适合单向读取 CLI 输出，但不适合需要双向请求、能力协商和权限响应的 ACP。

## 当前架构：Runtime Core + Drivers

```text
┌──────────────────────────────────────────────────────────────────┐
│ Web / Desktop                                                    │
│ Provider 选择 Runtime · 日志/计划/工具 · Permission Prompt       │
└───────────────────────────────┬──────────────────────────────────┘
                                │ REST + Socket.IO (/events)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ SessionManager                                                   │
│ Session/Task/TeamRun · Snapshot · Auto-commit · 结束后处理        │
└───────────────────────────────┬──────────────────────────────────┘
                                │ run / cancel / permission
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ RuntimeCoordinator                                               │
│ Tower session 隔离 · 单 active turn · 状态机 · 迟到事件过滤       │
└───────────────────────┬───────────────────────┬──────────────────┘
                        │                       │
              ┌─────────▼─────────┐   ┌─────────▼──────────────┐
              │ CLI Driver        │   │ Generic ACP Driver     │
              │ Executor + PTY    │   │ ACP SDK + permission   │
              │ Pipeline + Parser │   │ session new/load       │
              └─────────┬─────────┘   └──────────┬─────────────┘
                        │              ┌──────────▼─────────────┐
                        │              │ ACP Agent Registry     │
                        │              │ Agent Definitions      │
                        │              │ launch + config policy │
                        │              └──────────┬─────────────┘
                        └───────────┬─────────────┘
                                    ▼
                         MsgStore / Runtime events
                                    │
                                    ▼
                         EventBus -> Socket -> UI
```

`AgentType` 表示 Codex、Claude Code 等 Agent 身份；`RuntimeType` 表示 `CLI` 或 `ACP` 执行协议。Provider 同时选择二者，创建 Session 时会固化 Runtime，已有 Session 不会因为后来修改 Provider 而静默切换协议。

ACP Driver 本身不包含具体 Agent 的专属启动逻辑。它只管理协议连接、通用生命周期和临时启动资源清理，并从 `AcpAgentRegistry` 取得对应 Agent Definition。Definition 负责 Provider 投影、可执行文件解析、adapter/原生 ACP 启动、Session metadata、模型和权限模式配置。新增 ACP Agent 时通常只增加 Definition 和 Provider 能力，不复制 RuntimeCoordinator 或 ACP Driver。

当前用户可见 Runtime 支持矩阵：

| Agent | CLI | ACP |
| --- | --- | --- |
| Claude Code | 是 | 是 |
| Gemini CLI | 是 | 是 |
| Cursor Agent | 是 | 是 |
| Codex | 是 | 是 |
| Qwen Code | 否 | 是 |
| Kiro CLI | 否 | 是 |
| OpenCode | 否 | 是 |
| Pi Coding Agent | 否 | 是 |
| Grok Build | 否 | 是 |

Claude Code 与 Codex 通过随 Agent Tower 发布的 ACP adapter 及其兼容 Runtime 启动，不依赖全局 CLI。Gemini CLI、Cursor Agent、Kiro CLI、OpenCode 和 Grok Build 直接启动各自的原生 ACP 子命令。Pi Coding Agent 通过 `pi-acp` 启动，并在会话级隔离目录中加载 `pi-mcp-adapter`；它不会修改用户的全局 settings/MCP 配置，临时目录会在启动失败、进程退出或 Session 关闭时删除。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 19 + Vite 7 + TypeScript 5 |
| 样式 | TailwindCSS v4 + shadcn/ui |
| 状态管理 | TanStack Query v5 + Zustand v5 |
| 实时通信 | Socket.IO 4 |
| 后端 | Fastify 4 |
| 数据库 | Prisma 5 + SQLite |
| 进程管理 | node-pty + ACP adapter process manager |
| Git | 原生 git CLI 封装 |
| 协议扩展 | MCP SDK + Agent Client Protocol SDK |
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
| `src/runtime` | RuntimeCoordinator、CLI Driver、通用 ACP Driver、ACP Agent Registry、进程与事件投影 |
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

## Runtime 输出链路

```text
CLI: PTY -> AgentPipeline -> Parser ─┐
                                     ├-> MsgStore JSON Patch
ACP: adapter/native ACP -> protocol update -> Projector ───┘
  -> EventBus.emit('session:patch')
  -> SocketGateway 转发到 /events namespace
  -> 前端增量更新日志 / Todo / token usage
```

关键点：

- `MsgStore` 保存 patch、sessionId 以及 CLI raw stdout，并能重建快照
- ACP stdout 是协议帧，不作为用户日志广播或写入快照
- 快照按低频 checkpoint 持久化，终态会强制 flush
- parser 会尽量把原始终端输出结构化为标准化消息
- ACP Projector 把 message、tool、plan 和 usage 映射到相同的标准化消息
- Runtime state 通过 REST 恢复，Socket 事件只负责实时通知和缓存失效

## TeamRun 协作

TeamRun 把一个 Task 下的工作拆成成员、房间消息、工作请求和 agent invocation：

```text
Task -> TeamRun -> TeamMember
                -> RoomMessage -> WorkRequest -> AgentInvocation -> Session
                -> main workspace / dedicated child workspace
```

TeamRun 支持 `AUTO` 和 `CONFIRM` 两种模式。成员通过 Team Room 公开消息或私聊协作，`@` 提及会创建 WorkRequest；调度器根据成员的触发策略、workspace 策略、session 策略和队列策略启动或排队后续工作。

## 预览代理

Workspace 可以配置一个 Agent Tower 服务器能访问的预览目标，例如 `127.0.0.1:5173` 或 `192.168.1.20:8080`。目标始终由服务器代为访问，浏览器通过两种入口之一查看：

- **同源代理（`/view/:workspaceId/`）**：所有环境的通用入口，复用 Agent Tower 自身的地址与 access/tunnel 认证。首次打开时先返回一个 bootstrap 页面注册作用域为 `/view/:workspaceId/` 的 Service Worker，再重新导航；Worker 把受控页面发出的同源根路径请求、指向目标自身的绝对地址请求改写到代理前缀并带上标记头，服务端据此跳过改写直接转发。注入的 bridge 脚本在嵌入模式下用 `history.replaceState` 把页面地址虚拟化为目标根路径（SPA 路由无需 base path），接管 WebSocket、链接点击、表单提交、工具栏命令，并把 `localStorage`/`sessionStorage` 按 workspace 命名空间隔离。无法使用 Worker 时降级为 plain 模式：服务端改写静态 HTML/CSS 引用，bridge 改写 fetch/XHR/EventSource。逃逸出前缀的请求（Referer 位于 `/view/...`，或带预览上下文 Cookie 的嵌入导航）由全局 onRequest 钩子 307 重定向回代理。
- **直连网关**：`http://` 页面在服务器主机上按 workspace 获得一个独立端口的根路径网关，预览页拥有独立 origin，无需任何改写。客户端先用 `no-cors` 探测该端口，不可达时自动改用同源代理。网关入口由已登录会话签发短期 bootstrap token 换取网关自己的 HttpOnly Cookie，客户端续租，空闲 10 分钟后回收。

两种入口都转发 HTTP、WebSocket 与流式响应，剥离 frame 限制，改写同目标 redirect 与 Cookie；外层 Agent Tower 的 access/tunnel Cookie 不会转发给目标服务，目标自己的登录 Cookie 会按 workspace 隔离。Docker 等无法暴露动态端口的部署通过 `AGENT_TOWER_PREVIEW_FORCE_SAME_ORIGIN=true` 固定使用同源代理，不再需要额外的 Cloudflare Quick Tunnel。
