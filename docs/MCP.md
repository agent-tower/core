# MCP Server 使用文档

agent-tower 提供 MCP (Model Context Protocol) 服务端，让 AI agent（Claude Code、Cursor、Kiro 等）可以通过 MCP 协议直接操作任务看板。

## 前置条件

agent-tower 后端必须先运行：

```bash
cd /path/to/agent-tower
pnpm dev
```

MCP 服务器是一个独立的 stdio 进程，通过 HTTP 代理调用后端 REST API。

## 配置方式

### Claude Code

在 `~/.claude.json` 中添加：

```json
{
  "mcpServers": {
    "agent_tower": {
      "command": "node",
      "args": ["/path/to/agent-tower/packages/server/dist/mcp/index.js"]
    }
  }
}
```

开发阶段可用 tsx 免构建：

```json
{
  "mcpServers": {
    "agent_tower": {
      "command": "npx",
      "args": ["tsx", "/Users/shitian/Work/shitian/github/agent-tower/packages/server/src/mcp/index.ts"]
    }
  }
}
```

### Cursor

在 `~/.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "agent_tower": {
      "command": "node",
      "args": ["/path/to/agent-tower/packages/server/dist/mcp/index.js"]
    }
  }
}
```

### 指定后端地址

默认情况下 MCP 服务器通过 `getDevPort()` 自动计算后端端口（基于 monorepo 路径的 FNV-1a 哈希），无需手动配置。

如果需要显式指定后端地址（例如 MCP 进程不在 monorepo 内运行），通过 `env` 设置：

```json
{
  "mcpServers": {
    "agent_tower": {
      "command": "node",
      "args": ["/path/to/agent-tower/packages/server/dist/mcp/index.js"],
      "env": {
        "AGENT_TOWER_URL": "http://127.0.0.1:12345"
      }
    }
  }
}
```

环境变量优先级：`AGENT_TOWER_URL` > `AGENT_TOWER_PORT` > `getDevPort()` 自动计算。

## 可用 Tools

配置完成后，AI agent 可以使用以下工具：

| Tool | 描述 |
|------|------|
| `list_projects` | 列出所有项目 |
| `list_tasks` | 列出项目任务（支持状态过滤） |
| `create_task` | 创建任务 |
| `get_task` | 获取任务详情 |
| `update_task` | 更新任务标题/描述/状态 |
| `delete_task` | 删除任务 |
| `start_workspace_session` | 创建工作空间并启动 AI agent 会话 |
| `get_workspace_diff` | 获取工作空间代码 diff |
| `merge_workspace` | 合并工作空间到主分支 |
| `stop_session` | 停止运行中的会话 |
| `send_message` | 向会话发送消息 |
| `get_context` | 获取当前工作空间上下文（仅在 worktree 目录内时可用） |

## 开发与构建

```bash
# 开发模式直接运行
npx tsx packages/server/src/mcp/index.ts

# 构建
pnpm --filter @agent-tower/server build

# 构建后运行
node packages/server/dist/mcp/index.js
```

## 架构说明

```
AI Agent (Claude Code / Cursor / Kiro)
    │
    │  stdio (MCP 协议)
    │
MCP Server (packages/server/src/mcp/)
    │
    │  HTTP (fetch)
    │
agent-tower Backend (Fastify REST API)
    │
    │  Prisma ORM
    │
SQLite Database
```

MCP 服务器是一个轻量级的 HTTP 代理层，不直接访问数据库，所有操作通过后端 REST API 完成。
