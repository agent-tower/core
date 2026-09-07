---
title: 快速开始
description: 安装并启动 Agent Tower，并准备好一个可用的 agent CLI。
---

# 快速开始

最简单的使用方式是全局安装 CLI。

## 前置条件

- Node.js `>= 22.19.0`
- 本机已安装 Git
- 至少准备一个可用的 Agent Provider；Claude Code ACP、Codex ACP 和 Pi Coding Agent 已随 Agent Tower 内置

Agent Tower 本身不负责执行代码，它会通过 CLI Driver 或 ACP Driver 调用 Agent。多数 Runtime 仍需要本机可用的 Agent CLI；建议先准备好下面任意一个：

| 执行器 | 可用 Runtime | 安装说明 |
| --- | --- | --- |
| Claude Code | CLI、ACP | ACP 已内置；CLI Runtime 见 [Claude Code Setup](https://code.claude.com/docs/en/setup) |
| Codex CLI | CLI、ACP | ACP 优先使用系统 Codex，未安装时用内置版本兜底；CLI Runtime 见 [Codex CLI](https://developers.openai.com/codex/cli) |
| Cursor CLI | CLI、ACP | [Cursor CLI](https://cursor.com/cli) |
| Gemini CLI | CLI、ACP | [Gemini CLI Get started](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md) |
| Qwen Code | ACP | [Qwen Code](https://github.com/QwenLM/qwen-code) |
| Kiro CLI | ACP | [Kiro CLI](https://kiro.dev/docs/cli/) |
| OpenCode | ACP | [OpenCode](https://opencode.ai/docs/) |
| Pi Coding Agent | ACP | Agent Tower 内置，无需单独安装 |
| Grok Build | ACP | 安装提供 `grok` 命令并支持 `grok agent stdio` 的版本 |

Claude Code ACP、Codex ACP 和 Pi Coding Agent 不要求全局安装对应 CLI；它们可以直接使用 Provider 中配置的凭证、API 地址和模型。Codex ACP 会自动优先使用 Agent Tower 服务所在环境检测到的系统 `codex`，未检测到时才使用内置版本，无需手动指定路径。Claude Code 与 Codex 的 CLI Runtime 仍要求本机 CLI。Claude Code 和 Pi 的内置 ACP Runtime 仍可分别通过 `CLAUDE_PATH`/`CLAUDE_CODE_EXECUTABLE` 或 `PI_CODING_AGENT_PATH`/`PI_PATH` 覆盖。

## 安装

```bash
npm install -g agent-tower
```

启动服务：

```bash
agent-tower
```

默认访问地址：

```text
http://localhost:12580
```

CLI 默认把数据放在：

```text
~/.agent-tower
```

## 第一个任务

1. 打开 `http://localhost:12580`
2. 创建 Project，选择一个本地 Git 仓库路径
3. 创建 Task，写清楚要 agent 完成的目标
4. 选择 provider
5. 启动 session
6. 等待任务进入 `IN_REVIEW`
7. 在 Git changes 中审查 diff
8. 确认后执行 merge

## 常见启动问题

如果页面打不开，先确认服务是否在运行：

```bash
agent-tower --port 12580
```

如果 MCP 找不到后端，请显式设置：

```bash
AGENT_TOWER_URL=http://127.0.0.1:12580 agent-tower-mcp
```

访问密码开启后，MCP 还需要 `AGENT_TOWER_INTERNAL_TOKEN`。推荐从设置页复制生成的 MCP 配置，或用 MCP 客户端支持的 env/secret 机制注入该变量。

如果 agent CLI 无法启动，通常是 provider 配置或本机 PATH 问题。见 [Agent Provider](../integrations/agent-providers.md)。
