# MCP Server 使用文档

Agent Tower 内置 MCP server，让外部 AI agent 可以通过 MCP 协议直接读取任务板、启动 workspace session、查看 diff，以及继续和已有 session 交互。

## 1. 架构说明

```text
AI Agent (Claude Code / Cursor / others)
    │
    │ stdio (MCP protocol)
    │
agent-tower-mcp / packages/server/src/mcp
    │
    │ HTTP
    │
Agent Tower Backend (Fastify REST API)
    │
    │ Prisma ORM
    │
SQLite
```

MCP server 本身是一个轻量的 HTTP 代理层，不直接访问数据库，也不绕过 Agent Tower 的业务规则。

如果启用了访问密码，MCP 不走浏览器 cookie，而是通过 `AGENT_TOWER_INTERNAL_TOKEN` 这个内部凭证调用后端。Agent Tower 自己启动的 agent/MCP 进程会自动注入该变量；手动配置外部 MCP 客户端时，推荐从设置页复制生成配置，或用客户端支持的安全 env/secret 方式传入，不要写死真实 token。

## 2. 前置条件

在使用 MCP 之前，Agent Tower 后端必须先运行。

### 2.1 全局安装场景

```bash
agent-tower
```

### 2.2 源码开发场景

```bash
pnpm --filter @agent-tower/server dev
```

## 3. 配置方式

### 3.1 推荐方式：使用全局安装的 CLI

如果你已经全局安装了 `agent-tower`，MCP 配置可以直接写成：

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "args": [],
      "env": {
        "AGENT_TOWER_INTERNAL_TOKEN": "${env:AGENT_TOWER_INTERNAL_TOKEN}"
      }
    }
  }
}
```

### 3.2 使用源码构建产物

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "node",
      "args": ["/path/to/agent-tower/packages/server/dist/mcp/index.js"],
      "env": {
        "AGENT_TOWER_INTERNAL_TOKEN": "${env:AGENT_TOWER_INTERNAL_TOKEN}"
      }
    }
  }
}
```

### 3.3 开发模式免构建运行

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "npx",
      "args": ["tsx", "/path/to/agent-tower/packages/server/src/mcp/index.ts"],
      "env": {
        "AGENT_TOWER_INTERNAL_TOKEN": "${env:AGENT_TOWER_INTERNAL_TOKEN}"
      }
    }
  }
}
```

### 3.4 指定后端地址

默认情况下，MCP 进程会按以下优先级寻找后端地址：

1. `AGENT_TOWER_URL`
2. `AGENT_TOWER_PORT`
3. `getDevPort()` 基于 monorepo 路径自动计算的端口

如果 MCP 进程不在当前 monorepo 内运行，建议显式传入 `AGENT_TOWER_URL`：

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "args": [],
      "env": {
        "AGENT_TOWER_URL": "http://127.0.0.1:12345",
        "AGENT_TOWER_INTERNAL_TOKEN": "${env:AGENT_TOWER_INTERNAL_TOKEN}"
      }
    }
  }
}
```

`${env:AGENT_TOWER_INTERNAL_TOKEN}` 表示由 Agent Tower 启动器或 MCP 客户端运行环境注入的变量占位符。如果你的客户端不支持这种占位符，请使用它支持的 secret/env 注入方式。

## 4. 当前可用 Tools

### 4.1 Projects

| Tool | 说明 |
|------|------|
| `list_projects` | 列出所有项目 |

### 4.2 Tasks

| Tool | 说明 |
|------|------|
| `list_tasks` | 列出某个项目下的任务，可按状态过滤 |
| `create_task` | 在项目下创建任务 |
| `get_task` | 获取任务详情 |
| `update_task` | 更新任务标题、描述或状态 |
| `delete_task` | 删除任务 |

### 4.3 Providers

| Tool | 说明 |
|------|------|
| `list_providers` | 列出已配置 provider 及其可用性状态 |

### 4.4 Workspaces

| Tool | 说明 |
|------|------|
| `start_workspace_session` | 为任务创建 workspace、创建 session，并立即启动 agent |
| `get_workspace_diff` | 获取 workspace 当前 diff |
| `merge_workspace` | 将 workspace squash merge 回主分支 |

### 4.5 Sessions

| Tool | 说明 |
|------|------|
| `stop_session` | 停止运行中的 session |
| `send_message` | 向运行中或已结束的 session 继续发送消息 |

### 4.6 Context

| Tool | 说明 |
|------|------|
| `get_context` | 获取当前目录对应的 project/task/workspace 上下文，仅在 worktree 目录内可用 |

## 5. 常见用法

### 5.1 让 agent 直接领取任务并开始执行

典型链路是：

1. `list_projects`
2. `list_tasks`
3. `list_providers`
4. `start_workspace_session`

### 5.2 查看结果并合并

典型链路是：

1. `get_task`
2. `get_workspace_diff`
3. `merge_workspace`

### 5.3 在已有 session 上继续工作

典型链路是：

1. `get_task`
2. 找到现有 workspace / session
3. `send_message`

## 6. 开发与构建

```bash
# 直接运行源码
npx tsx packages/server/src/mcp/index.ts

# 构建 server 包
pnpm --filter @agent-tower/server build

# 运行构建产物
node packages/server/dist/mcp/index.js
```

## 7. 备注

- `get_context` 依赖当前工作目录能映射到某个 Agent Tower worktree
- MCP 工具调用的仍然是 Agent Tower 的后端 API，所以权限与行为和 Web 界面保持一致
- 是否能真正启动某个 agent，取决于本机是否已安装对应 CLI，以及 provider 配置是否可用
