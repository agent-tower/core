---
title: 快速开始
description: 安装并启动 Agent Tower，并准备好一个可用的 agent CLI。
---

# 快速开始

最简单的使用方式是全局安装 CLI。

## 前置条件

- Node.js `>= 18`
- 本机已安装 Git
- 至少安装一个你要使用的 agent 执行器

Agent Tower 本身不负责执行代码，它会调用你本机已经安装好的 agent CLI。建议先准备好下面任意一个：

| 执行器 | 官方安装文档 |
| --- | --- |
| Claude Code | [Claude Code Setup](https://code.claude.com/docs/en/setup) |
| Codex CLI | [Codex CLI](https://developers.openai.com/codex/cli) |
| Cursor CLI | [Cursor CLI](https://cursor.com/cli) |
| Gemini CLI | [Gemini CLI Get started](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md) |

如果你已经能在终端里直接运行其中任意一个，就可以继续下一步。

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

如果 agent CLI 无法启动，通常是 provider 配置或本机 PATH 问题。见 [Agent Provider](../integrations/agent-providers.md)。
