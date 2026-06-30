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
| `AGENT_TOWER_PORT` | CLI 或 MCP 使用的端口 |
| `AGENT_TOWER_WEB_DIR` | 静态前端目录 |
| `LOG_LEVEL` | Fastify 日志级别 |
| `CORS_ORIGIN` | Socket.IO CORS origin |
| `DEBUG_PARSER` | 调试输出解析器 |
| `DEBUG_DEMO` | 调试 demo 路由 |
| `DEBUG_SNAPSHOT` | 调试 session 快照 |
| `AGENT_TOWER_TEAM_RUN_ID` | Team run 上下文 |
| `AGENT_TOWER_MEMBER_ID` | Team member 上下文 |
| `AGENT_TOWER_INVOCATION_ID` | Invocation 上下文 |

## Web

| 变量 | 说明 |
| --- | --- |
| `VITE_API_URL` | 前端 API 基础地址。未配置时使用同源 `/api`；dev 下本机绝对地址会被前端规整为 `/api`，由 Vite proxy 转发 |
| `VITE_SOCKET_URL` | Socket.IO 基础地址。未配置时使用同源 `/events`；dev 下本机绝对地址会被前端规整为同源连接 |
| `VITE_API_PROXY_TARGET` | Web dev server 的后端代理目标，例如 `http://localhost:33952` |
| `VITE_BACKEND_URL` | Web dev server 后端代理目标的兼容变量，优先级低于 `VITE_API_PROXY_TARGET` |
| `VITE_DEBUG_LOGS` | 调试日志输出 |

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
