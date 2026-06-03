---
title: MCP 集成
description: 让外部 agent 直接操作 Agent Tower。
---

# MCP 集成

Agent Tower 内置 MCP server，让外部 AI agent 可以直接读取任务板、启动 workspace session、查看 diff，以及继续与已有 session 交互。

如果你要在 TeamRun 中使用 Team Room、私聊或 WorkRequest 控制工具，还需要确保每个 Agent CLI 都配置了 Agent Tower MCP server。具体见 [团队模式](../guide/team-mode.md)。

## 架构

```text
AI Agent (Claude Code / Cursor / others)
    │
    │ stdio (MCP protocol)
    │
agent-tower-mcp
    │
    │ HTTP
    │
Agent Tower Backend
```

MCP server 只是轻量 HTTP 代理层，不直接访问数据库，也不绕过业务规则。

## 前置条件

在使用 MCP 之前，Agent Tower 后端必须先运行。

```bash
agent-tower
```

如果你在源码开发：

```bash
pnpm --filter @agent-tower/server dev
```

## 配置

### 推荐方式

生产和普通本地使用推荐指向默认后端地址 `http://127.0.0.1:12580`：

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "args": [],
      "env": {
        "AGENT_TOWER_URL": "http://127.0.0.1:12580"
      }
    }
  }
}
```

### 自定义后端地址

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "args": [],
      "env": {
        "AGENT_TOWER_URL": "http://127.0.0.1:12580"
      }
    }
  }
}
```

## 可用工具

### Projects

| Tool | 说明 |
| --- | --- |
| `list_projects` | 列出所有项目 |

### Tasks

| Tool | 说明 |
| --- | --- |
| `list_tasks` | 列出某个项目下的任务，可按状态过滤 |
| `create_task` | 在项目下创建任务 |
| `get_task` | 获取任务详情 |
| `update_task` | 更新任务标题、描述或状态 |
| `delete_task` | 删除任务 |

### Providers

| Tool | 说明 |
| --- | --- |
| `list_providers` | 列出已配置 provider 及其可用性状态 |

### Workspaces

| Tool | 说明 |
| --- | --- |
| `start_workspace_session` | 创建 workspace、创建 session，并立即启动 agent |
| `get_workspace_diff` | 获取 workspace 当前 diff |
| `merge_workspace` | 将 workspace squash merge 回主分支 |

### Sessions

| Tool | 说明 |
| --- | --- |
| `stop_session` | 停止运行中的 session |
| `send_message` | 向运行中或已结束的 session 发送消息 |

### Context

| Tool | 说明 |
| --- | --- |
| `get_context` | 获取当前目录对应的 project/task/workspace 上下文，仅在 worktree 目录内可用 |

## 常见链路

### 让 agent 直接领取任务

1. `list_projects`
2. `list_tasks`
3. `list_providers`
4. `start_workspace_session`

### 查看结果并合并

1. `get_task`
2. `get_workspace_diff`
3. `merge_workspace`

### 继续已有 session

1. `get_task`
2. 找到现有 workspace / session
3. `send_message`
