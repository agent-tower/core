[English](./README.md) | **简体中文**

# Agent Tower

> 你的终端会话窗口（Claude Code / Codex ...）太多了？这里是它们的指挥中心。

## 为什么做这个项目

刚开始用 Claude Code 的时候，我开一个终端，无聊地等它吐完所有字符。后来我学聪明了——开多个终端，同时跑不同的任务，甚至同时开不同的项目。效率直接起飞，这可把我牛逼坏了。

爽了没两天，就发现了问题：

- **视觉混乱**：桌面上全是 Claude Code 终端，我经常搞不清楚哪个窗口是哪个任务。
- **编辑冲突**：多个任务改到同一个文件，合代码时一堆冲突。后来我用 Git Worktree 隔离每个任务，但手动输入命令做拆分、变基、合并，依然很繁琐。
- **手机访问**：总是坐在电脑前盯着终端，有时候挺枯燥的。我在阳台玩手机的时候，为什么不能看看我的 AI 牛马们干得怎么样了？
- **模型费用**：任务开多了，token 账单看得我肉疼。其实很多简单任务用便宜的模型就够了，但手动改配置太麻烦——就算用 ccswitch 之类的工具，也得等当前任务跑完才能切。

于是 Agent Tower 就这么被逼出来了——一个看板，把所有 Agent 的任务、终端、代码变更收到一个界面里。自动创建隔离分支、按任务选模型、手机远程访问、完成后通知你来 review。

## 核心能力

### 🎯 一个看板管所有 Agent

不用再开一堆终端窗口了。所有项目、所有任务、所有 Agent，一个页面搞定。创建任务，选择 Agent，点击启动——输出、进度、代码变更实时可见。任务完成后自动流转到"待审查"，你来决定合不合并。

### 🔀 Git Worktree 自动隔离

每个任务自动创建独立 Git 分支，Agent 在各自的隔离环境中工作，从根本上杜绝代码冲突。完成后一键合并回主分支，变更视图里逐行审查。

### 💰 按任务选 Provider，省钱不费心

每个任务独立选择 Provider。翻译任务丢给 MiniMax，做计划用 Opus，执行交给 Codex——各司其职，不用等上一个任务跑完再切。Agent Tower 帮你把钱花在刀刃上。

### 📱 手机也能盯进度

Cloudflare 隧道一键开启，手机浏览器直接访问看板。出门在外也能看 Agent 跑到哪了。跑完了？桌面通知或飞书群消息提醒你来 review。

### 🤖 支持主流 AI Agent

- **Claude Code** · **Gemini CLI** · **Cursor Agent** · **Codex**

不绑定单一厂商，用哪个顺手就用哪个。每个 Agent 支持自定义 Profile 配置变体。

### 📡 MCP 协议集成

内置 MCP 服务器，Agent 能直接读取任务板、认领任务、报告进度。不只是你在管 Agent——Agent 也能主动协作。

## 快速开始

**推荐方式：全局安装**（最简单，一行命令搞定）

```bash
npm install -g agent-tower
agent-tower
```

打开 `http://localhost:12580`，开始使用。

> 前置要求：Node.js >= 18

### 配置 MCP（可选）

让 Claude Code 能直接操作任务板：

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "args": []
    }
  }
}
```

### 从源码开发

```bash
git clone https://github.com/nicepkg/agent-tower.git
cd agent-tower
pnpm setup          # 安装依赖 + 构建共享包
pnpm dev            # 启动所有服务的开发模式
```

## 架构概览

```
┌─────────────────────────────────────────────────┐
│                   浏览器 (React)                  │
│  看板页 ─ 终端视图 ─ 代码编辑器 ─ Git 变更视图      │
│  TanStack Query (服务端缓存) + Zustand (UI 状态)   │
└──────────────────┬──────────────────────────────┘
                   │ HTTP REST + Socket.IO (/events)
┌──────────────────┴──────────────────────────────┐
│                Fastify 服务端                      │
│  ┌───────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ REST API  │ │ Socket.IO│ │  MCP Server    │  │
│  │ (16 路由) │ │ (实时通信) │ │ (Agent 集成)   │  │
│  └─────┬─────┘ └────┬─────┘ └───────┬────────┘  │
│        └──────┬──────┘               │           │
│        ┌──────┴──────┐               │           │
│        │   服务层     │               │           │
│        │ Session管理  │               │           │
│        │ Workspace   │               │           │
│        │ Git/Worktree│               │           │
│        │ 通知/隧道    │               │           │
│        └──────┬──────┘               │           │
│        ┌──────┴──────┐               │           │
│        │ AgentPipeline│              │           │
│        │ PTY + Parser │              │           │
│        │ + MsgStore   │              │           │
│        └──────┬──────┘               │           │
│               │ node-pty             │           │
│        ┌──────┴──────┐               │           │
│        │ Agent 执行器 │               │           │
│        │ Claude Code │               │           │
│        │ Gemini CLI  │               │           │
│        │ Cursor Agent│               │           │
│        │ Codex       │               │           │
│        └─────────────┘               │           │
│                                      │           │
│        ┌─────────────┐               │           │
│        │ SQLite      │◄──────────────┘           │
│        │ (Prisma ORM)│                           │
│        └─────────────┘                           │
└─────────────────────────────────────────────────┘
```

### 核心设计理念

**Agent 即团队成员**：Agent Tower 将 AI Agent 类比为团队成员。项目是工作空间，任务是工作项，Agent 是执行者。通过看板管理任务分配，通过终端监控执行过程，通过 Git 集成审查工作成果。

**Pipeline 架构**：每个 Agent Session 由 AgentPipeline 管理，包含三个核心组件：
- **PTY**：伪终端，负责与 Agent CLI 进程交互
- **Parser**：输出解析器，将 Agent 的原始输出结构化为工具调用、代码变更等
- **MsgStore**：消息存储，使用 JSON Patch 增量同步到前端

**Worktree 隔离**：每个任务创建独立的 Git Worktree，Agent 在隔离分支上工作，避免多个 Agent 同时修改代码造成冲突。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Vite 7 + TypeScript 5 |
| 样式 | TailwindCSS v4 + shadcn/ui (Radix UI) |
| 状态 | TanStack Query v5 + Zustand v5 |
| 终端 | xterm.js 5 + Monaco Editor |
| 后端 | Fastify 4 + Socket.IO 4 |
| 数据 | Prisma 5 + SQLite |
| 进程 | node-pty |
| 协议 | MCP (Model Context Protocol) |
| 包管理 | pnpm monorepo |

## 许可证

本项目基于 Apache License 2.0 开源，详情见 [LICENSE](./LICENSE)。
