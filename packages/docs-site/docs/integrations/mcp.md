---
title: MCP 集成
description: 让外部 agent 直接操作 Agent Tower。
---

# MCP 集成

Agent Tower 内置 MCP server，让外部 AI agent 可以直接读取任务板、启动 workspace session、管理 workspace 后台服务、查看 diff，以及继续与已有 session 交互。

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

如果启用了访问密码，MCP 不能使用浏览器 cookie。Agent Tower 会为自己启动的 agent/MCP 进程签发只绑定当前 session/invocation 的 `AGENT_TOWER_AGENT_CREDENTIAL`，不会把应用级 internal token 暴露给托管 Agent。手动配置第三方 MCP 客户端时，推荐从设置页复制生成的 MCP 配置；如果手写配置，需要包含 `AGENT_TOWER_INTERNAL_TOKEN` env，占位符形式如下，不要写死真实 token。

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

### Workspace 后台服务

以下工具只在 MCP 进程绑定了当前 workspace 时注册，用于运行需要跨 Agent turn 持续存在的开发服务器、watcher 或 worker：

| Tool | 说明 |
| --- | --- |
| `start_workspace_service` | 用稳定名称和结构化 `command`、`args` 启动长期服务，可指定 workspace 内的相对目录 |
| `list_workspace_services` | 列出当前 workspace 的服务定义、期望状态和运行状态 |
| `get_workspace_service_logs` | 按 `runtime_instance_id` 与 `after_seq` 游标读取有界的内存日志 |
| `send_workspace_service_input` | 向运行中的服务 PTY 写入输入 |
| `control_workspace_service` | 使用 `stop` 或 `restart` 控制已有服务 |

后台服务由 workspace 持有，不属于启动它的 Agent session，因此 session 完成、停止或页面断开不会结束服务。已经完全停止且不再期望运行的服务定义不会出现在列表中，也不占用每个 workspace 最多 20 个服务的配额；同名同配置启动时仍可复用保存的定义。普通构建、测试和一次性命令仍使用 Agent 终端；不要用 `nohup`、`disown` 或 shell 后台任务代替这些工具。

后台服务工具要求 Agent Tower 签发的 workspace session credential。Solo session 绑定当前 workspace；TeamRun session 还绑定 invocation，并在每次请求重验成员的 `runCommands` capability。同一个 DriverSession 在自然完成后的 follow-up 中继续使用有效 credential；显式停止 Session、启动失败或关闭 DriverSession 后 credential 立即失效。缺少 credential 的 Agent 请求和与 credential 冲突的自报 identity 都会被拒绝。

当前 Web UI 和浏览器 REST 只开放只读能力：同源且通过 AccessAuth 的请求可以列出 workspace service 并读取有界日志。启动、更新、输入、停止或重启仍只允许 Agent/MCP/internal；即使请求携带 access-auth 签发的有效浏览器 cookie，或自报 session/invocation/internal identity，也不能换取控制权限。

启动参数不接受 shell 命令字符串、绝对工作目录或自定义环境变量。项目继续通过自己的 `.env` 和启动脚本加载配置。服务崩溃后不会自动重启；workspace 休眠、归档或删除时会停止服务并清除期望运行状态，之后唤醒不会自动恢复。日志仅保存在当前 Agent Tower 进程的有界内存中，应用重启后不会保留。

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

- `AGENT_TOWER_AGENT_CREDENTIAL`
- `AGENT_TOWER_TEAM_RUN_ID`
- `AGENT_TOWER_MEMBER_ID`
- `AGENT_TOWER_INVOCATION_ID`
- `AGENT_TOWER_SESSION_ID`

其中 `AGENT_TOWER_AGENT_CREDENTIAL` 是后端签发并绑定当前 session/invocation 的 MCP 凭据；其余变量提供 TeamRun 上下文，后端会拒绝与 credential 绑定不一致的身份。不要在共享配置中写死这些值。`AGENT_TOWER_INTERNAL_TOKEN` 只用于应用级内部进程或手动配置的可信 MCP 客户端。

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
