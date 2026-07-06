---
title: 环境变量
description: 当前代码中实际使用的环境变量。
---

# 环境变量

## Server

| 变量 | 说明 |
| --- | --- |
| `AGENT_TOWER_DATABASE_URL` | Prisma 数据库地址 |
| `AGENT_TOWER_DATA_DIR` | 数据目录 |
| `AGENT_TOWER_HOST` | CLI 服务监听 host，默认 `0.0.0.0`；启动日志会展示 localhost 访问地址 |
| `AGENT_TOWER_PORT` | CLI 或 MCP 使用的端口 |
| `AGENT_TOWER_URL` | MCP 和子进程连接后端时使用的基础地址 |
| `AGENT_TOWER_INTERNAL_TOKEN` | Agent Tower 内部 MCP/API 调用凭证，由服务端启动器注入；不要手写固定值或提交到仓库 |
| `AGENT_TOWER_WEB_DIR` | 静态前端目录 |
| `AGENT_TOWER_NODE_RUNTIME` | 子进程启动 Node 脚本时使用的 Node/Electron runtime |
| `AGENT_TOWER_MCP_ENTRY` | 打包桌面端注入给 agent 的 MCP 入口脚本路径 |
| `AGENT_TOWER_DESKTOP_RUNTIME_MODE` | 桌面端 runtime 模式标记 |
| `LOG_LEVEL` | Fastify 日志级别 |
| `CORS_ORIGIN` | Socket.IO CORS origin |
| `DEBUG_PARSER` | 调试输出解析器 |
| `DEBUG_DEMO` | 调试 demo 路由 |
| `DEBUG_SNAPSHOT` | 调试 session 快照 |
| `AGENT_TOWER_TEAM_RUN_ID` | Team run 上下文 |
| `AGENT_TOWER_MEMBER_ID` | Team member 上下文 |
| `AGENT_TOWER_INVOCATION_ID` | Invocation 上下文 |
| `AGENT_TOWER_SESSION_ID` | Agent session 上下文，MCP context 检测会使用 |

## Desktop

| 变量 | 说明 |
| --- | --- |
| `AGENT_TOWER_DESKTOP_DATA_MODE` | 桌面端数据模式，`isolated` 或 `shared` |
| `AGENT_TOWER_DESKTOP_USER_DATA_DIR` | 覆盖 Electron userData 目录 |
| `AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS` | 后端启动健康检查超时时间 |
| `AGENT_TOWER_DESKTOP_NODE` | 开发模式后端使用的 Node 命令 |
| `AGENT_TOWER_DESKTOP_VERIFY_SOCKET` | 设为 `1` 时开发启动验证 Socket.IO |
| `AGENT_TOWER_DESKTOP_VERIFY_TERMINAL` | 设为 `1` 时开发启动验证独立终端 |
| `AGENT_TOWER_DESKTOP_SMOKE_TIMEOUT_MS` | 桌面打包 smoke 外层超时时间 |

## Web

| 变量 | 说明 |
| --- | --- |
| `VITE_API_URL` | 前端 API 基础地址。未配置时使用同源 `/api`；dev 下本机绝对地址会被前端规整为 `/api`，由 Vite proxy 转发 |
| `VITE_SOCKET_URL` | Socket.IO 基础地址。未配置时使用同源 `/events`；dev 下本机绝对地址会被前端规整为同源连接 |
| `VITE_API_PROXY_TARGET` | Web dev server 的后端代理目标，例如 `http://localhost:33952` |
| `VITE_BACKEND_URL` | Web dev server 后端代理目标的兼容变量，优先级低于 `VITE_API_PROXY_TARGET` |
| `VITE_DEBUG_LOGS` | 调试日志输出 |

## Docker

| 变量 | 说明 |
| --- | --- |
| `NODE_VERSION` | Docker build 使用的 Node 版本 |
| `PNPM_VERSION` | Docker build 使用的 pnpm 版本 |
| `CODEX_CLI_VERSION` | Docker build 内置 Codex CLI 版本 |
| `CLAUDE_CODE_VERSION` | Docker build 内置 Claude Code 版本 |
| `GEMINI_CLI_VERSION` | Docker build 内置 Gemini CLI 版本 |
| `INSTALL_AGENT_CLIS` | Docker build 是否安装默认 Agent CLI |
| `INSTALL_CURSOR_CLI` | Docker build 是否实验性安装 Cursor CLI |
| `AGENT_TOWER_WORKSPACE_DIR` | docker-compose 映射到容器 `/workspace` 的宿主机目录 |

Docker 运行时也可传入 provider 所需的环境变量，例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`CURSOR_API_KEY` 等。不要把真实凭证提交到仓库。

## 常见启动例子

```bash
AGENT_TOWER_PORT=12580 AGENT_TOWER_DATA_DIR=~/.agent-tower agent-tower
```

```bash
pnpm --filter @agent-tower/server dev
VITE_API_PROXY_TARGET=http://localhost:12580 pnpm --filter web dev
```

开发环境推荐让浏览器只访问前端 origin（例如 `http://localhost:5175/api/...`），再由 Vite 代理到实际后端端口。这样 Agent CLI 环境检测/安装相关 local-only 接口仍保持后端同源校验，不需要放宽安全规则。

## 说明

这些变量是根据当前代码实现整理的。新增功能后，文档应同步更新，而不是把这里当作长期不变的规范。
