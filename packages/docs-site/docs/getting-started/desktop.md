---
title: 桌面端
description: Electron 桌面壳和本地后端运行方式。
---

# 桌面端

`packages/desktop` 是 Agent Tower 的 Electron 桌面壳。它不会重新实现一套应用，而是启动本地 Fastify 后端子进程，并在桌面窗口中加载现有 Web UI。

## 开发运行

从仓库根目录运行：

```bash
pnpm desktop:spike
```

这个命令会构建 `shared`、`server`、`web` 和 `desktop`，然后启动 Electron。

如需验证 Socket.IO 和独立终端路径：

```bash
AGENT_TOWER_DESKTOP_VERIFY_SOCKET=1 AGENT_TOWER_DESKTOP_VERIFY_TERMINAL=1 pnpm --filter @agent-tower/desktop spike
```

## 打包

构建当前平台的 unpacked app：

```bash
pnpm desktop:package:dir
```

构建安装包：

```bash
pnpm --filter @agent-tower/desktop package:mac
pnpm --filter @agent-tower/desktop package:win
pnpm --filter @agent-tower/desktop package:linux
```

当前配置的产物包括：

- macOS arm64: DMG
- Windows x64: NSIS 安装包和 portable 可执行文件
- Linux x64: AppImage 和 deb

## 打包验证

```bash
pnpm desktop:package:smoke
pnpm desktop:package:acceptance
```

`package:smoke` 会启动 unpacked app，检查 `/api/health`、Socket.IO `/events`、独立终端创建/删除和 Web UI 加载。

`package:acceptance` 使用临时 `HOME`、临时 Electron `userData` 和隔离数据目录启动，用于手工验收打包产物。

## 数据目录策略

桌面端通过 `AGENT_TOWER_DESKTOP_DATA_MODE` 控制数据模式：

| 模式 | 说明 |
| --- | --- |
| `isolated` | 开发运行默认值，后端数据放在 Electron `userData` 下，避免污染正式 CLI 数据 |
| `shared` | 打包桌面端默认值，复用标准 Agent Tower 数据目录，通常是 `~/.agent-tower` |

生产桌面包默认不会依赖全局 `agent-tower` 命令。打包产物会从 app resources 中启动后端 runtime。

## MCP 配置

桌面端设置页提供 `MCP Config` 入口，用于复制当前桌面后端对应的 MCP JSON。

打包桌面模式下，这份配置指向 bundled runtime，不要求用户额外安装全局 `agent-tower-mcp`。当前 UI 只负责展示和复制配置，不会自动写入 Claude、Codex、Cursor 等第三方客户端配置文件。

如果启用了访问密码，复制出的 MCP 配置会包含 `AGENT_TOWER_INTERNAL_TOKEN` env。它是 MCP 调后端所需的内部凭证，不要把真实值提交到共享配置中。
