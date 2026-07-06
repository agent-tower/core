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

如果启用了访问密码，MCP 不能使用浏览器 cookie。Agent Tower 会为自己启动的 agent/MCP 进程注入 `AGENT_TOWER_INTERNAL_TOKEN`，MCP 调后端 API 时会使用这个内部凭证。手动配置第三方 MCP 客户端时，推荐从设置页复制生成的 MCP 配置；如果手写配置，需要包含 `AGENT_TOWER_INTERNAL_TOKEN` env，占位符形式如下，不要写死真实 token。

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
        "AGENT_TOWER_URL": "http://127.0.0.1:12580",
        "AGENT_TOWER_INTERNAL_TOKEN": "${env:AGENT_TOWER_INTERNAL_TOKEN}"
      }
    }
  }
}
```

如果当前 MCP 客户端不支持 `${env:...}` 占位符，请从 Agent Tower 设置页复制生成配置，或用该客户端支持的安全 secret/env 注入方式传入 `AGENT_TOWER_INTERNAL_TOKEN`。不要把真实 token 提交到项目配置中。

### 自定义后端地址

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "args": [],
      "env": {
        "AGENT_TOWER_URL": "http://127.0.0.1:12580",
        "AGENT_TOWER_INTERNAL_TOKEN": "${env:AGENT_TOWER_INTERNAL_TOKEN}"
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
| `start_workspace_session` | 创建 workspace、创建 session，并立即启动 agent；默认使用 worktree，也支持 `main_directory` |
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

### Team Room

Team Room 工具始终在 MCP server 中注册，但大多数工具需要当前 MCP 进程带有 TeamRun 身份。TeamRun 由 Agent Tower 启动 agent session 时注入：

- `AGENT_TOWER_INTERNAL_TOKEN`
- `AGENT_TOWER_TEAM_RUN_ID`
- `AGENT_TOWER_MEMBER_ID`
- `AGENT_TOWER_INVOCATION_ID`
- `AGENT_TOWER_SESSION_ID`

其中 `AGENT_TOWER_INTERNAL_TOKEN` 用于 MCP 后端鉴权；其余变量用于 TeamRun 成员身份和上下文。不要在共享配置中写死这些值。

| Tool | 说明 |
| --- | --- |
| `post_room_message` | 发送公开 Team Room 消息，可通过结构化 mentions 创建 WorkRequest |
| `post_private_message` | 给指定成员发送私聊消息，并为收件人创建 WorkRequest |
| `list_room_messages` | 列出当前成员可见的房间消息 |
| `get_room_message` | 获取单条房间消息完整内容 |
| `list_team_members` | 列出成员 ID、状态、能力、workspace/session/队列策略和 provider |
| `list_member_work_requests` | 列出当前成员可见的 pending/queued WorkRequest |
| `approve_work_request` | 批准 pending WorkRequest，并尝试启动下一项工作 |
| `reject_work_request` | 拒绝 pending WorkRequest |
| `cancel_work_request` | 取消 pending 或 queued WorkRequest |
| `stop_member_work` | 停止某个成员当前工作，并可同时取消其排队请求 |

权限由 TeamRun 成员身份和能力开关共同决定。普通成员通常只能看到自己的队列；具备队列管理能力的成员可以看到团队 pending 队列。

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
