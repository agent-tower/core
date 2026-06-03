---
title: 团队模式
description: 使用 TeamRun、Team Room 和多个 agent 协作完成任务。
---

# 团队模式

团队模式通过 TeamRun 把一个任务拆给多个 Agent 成员。成员在同一个 Team Room 中沟通，用户或成员可以通过 `@` 提及其他成员来创建 WorkRequest，Agent 完成工作后通过 RoomMessage 回报结果。

## 适用场景

- 一个任务需要实现、审查、测试等多个角色协作。
- 需要让多个 Agent 在独立或共享 workspace 中并行工作。
- 希望所有决策、请求和结果都沉淀在同一个 Team Room 中。

普通单人任务仍然可以使用 Solo Agent 流程。只有需要团队协作时才创建 TeamRun。

## Agent MCP 前置要求

每个 TeamRun 成员背后的 Agent CLI 都必须能访问 Agent Tower MCP server。否则 Agent 只能完成普通代码任务，无法可靠使用 Team Room、私聊、WorkRequest 控制等 room 工具。

生产和普通本地使用推荐统一配置正式 MCP server：

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

`AGENT_TOWER_URL` 只表示 MCP server 应连接哪个 Agent Tower 后端。TeamRun 身份不是手工写在配置里的，它会在 TeamRun 启动 Agent session 时由 Agent Tower 注入。

Team Room 和私聊相关工具依赖这些受信任身份变量：

- `AGENT_TOWER_TEAM_RUN_ID`
- `AGENT_TOWER_MEMBER_ID`
- `AGENT_TOWER_INVOCATION_ID`
- `AGENT_TOWER_SESSION_ID`

安全边界：`memberId` 和 `invocationId` 不能通过提示词、tool args 或手工参数显式传给 MCP 工具。它们必须由 Agent Tower 启动器注入到 Agent/MCP 运行环境中。这样 room 工具才能按当前成员身份过滤私聊内容，并防止 Agent 冒充其他成员。

## Codex CLI

Codex 使用 `~/.codex/config.toml` 中的 `mcp_servers` 配置。普通使用建议把 Agent Tower MCP server 命名为 `agent-tower`：

```toml
[mcp_servers.agent-tower]
command = "agent-tower-mcp"

[mcp_servers.agent-tower.env]
AGENT_TOWER_URL = "http://127.0.0.1:12580"
```

当 Codex 由 TeamRun 启动时，Agent Tower 会在 Codex CLI 参数中注入 TeamRun identity env。用户不需要把 `AGENT_TOWER_MEMBER_ID` 或 `AGENT_TOWER_INVOCATION_ID` 写进全局配置。

## Cursor Agent CLI

Cursor 使用 `mcpServers` JSON 配置，位置可以是全局 `~/.cursor/mcp.json`，也可以是项目内 `.cursor/mcp.json`。

普通配置示例：

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "env": {
        "AGENT_TOWER_URL": "http://127.0.0.1:12580",
        "AGENT_TOWER_TEAM_RUN_ID": "${env:AGENT_TOWER_TEAM_RUN_ID}",
        "AGENT_TOWER_MEMBER_ID": "${env:AGENT_TOWER_MEMBER_ID}",
        "AGENT_TOWER_INVOCATION_ID": "${env:AGENT_TOWER_INVOCATION_ID}",
        "AGENT_TOWER_SESSION_ID": "${env:AGENT_TOWER_SESSION_ID}"
      }
    }
  }
}
```

这里的 `${env:AGENT_TOWER_*}` 是占位符，用于承接 Agent Tower 启动器注入到 Cursor Agent 进程中的身份变量。不要把具体 member id、invocation id 或 session id 写死到 `mcp.json`，这些值每次 TeamRun invocation 都不同。

## Claude Code

Claude Code 可以通过 MCP 配置使用 `agent-tower-mcp`。普通配置示例：

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

TeamRun 启动 Claude Code 成员时会提供当前成员的 TeamRun 身份。用户只需要配置 Agent Tower MCP server，不需要在 MCP 配置里写死具体 member id、invocation id 或 session id。

## 使用流程

1. 在任务详情页创建 TeamRun，选择团队模板或成员预设。
2. 在 Team Room 里发送公开消息或 `@` 提及某个成员。
3. 被提及成员会收到 WorkRequest；Confirm 模式下需要用户或队列管理员批准。
4. Agent session 启动后，通过 MCP room 工具读取房间、回复结果、必要时私聊相关成员。
5. 团队所有运行中和排队中的工作结束后，任务可进入审查阶段。
