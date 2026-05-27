---
title: node-pty 问题
description: 与终端和 agent 进程相关的排障。
---

# node-pty 问题

Agent Tower 使用 `node-pty` 托管 agent CLI 和独立终端。出问题时，通常先查这几类。

## 常见症状

- session 启动后没有 stdout
- 终端窗口能打开但没有交互
- agent 进程启动后立刻退出
- 某些平台上出现编译或二进制加载错误

## 可能原因

- 本机 shell 或 PATH 不可用
- provider 指向的 CLI 不存在
- worktree 目录权限不足
- 平台预编译二进制与当前系统不匹配
- Windows / macOS / Linux shell 行为不同

## 排查步骤

1. 在终端里手动运行对应 CLI
2. 确认 workspace 路径可访问
3. 检查 `AGENT_TOWER_DATA_DIR` 和 `AGENT_TOWER_DATABASE_URL`
4. 查看服务端日志
5. 尝试切换 provider

## 额外提示

如果问题出在开发环境本身，不要先怀疑业务代码。先把底层 CLI 和 shell 行为排清楚，往往更快。
