---
title: Workspace
description: git worktree 隔离模型。
---

# Workspace

Workspace 是 Agent Tower 保证并行安全的核心。默认情况下，每个 workspace 对应一个任务分支和一个独立 git worktree。

## 为什么使用 git worktree

多个 agent 直接在同一个工作目录里执行，会出现几个问题：

- 文件互相覆盖
- 测试产物混在一起
- 很难判断每个任务具体改了什么
- 合并时缺少清晰边界

git worktree 让每个任务有自己的工作目录和分支。agent 可以像在普通仓库里一样执行命令，但它的改动被隔离在任务 workspace 中。

## 创建过程

创建 workspace 时，系统会：

1. 确认任务所属 Project
2. 从主仓库创建任务分支
3. 创建 git worktree 目录
4. 复制 Project 配置的 `copyFiles`
5. 执行 `setupScript`
6. 记录 workspace 状态和路径

## Workspace 状态

| 状态 | 说明 |
| --- | --- |
| `ACTIVE` | 可继续执行 session、查看 diff、rebase 或 merge |
| `MERGED` | 已合并回主分支 |
| `ABANDONED` | 已归档或不再使用 |
| `HIBERNATED` | 已休眠，可唤醒后继续操作 |

## Workspace Kind

当前支持两种存储模式：

| 模式 | 说明 |
| --- | --- |
| `WORKTREE` | 默认模式，为任务创建独立 git worktree 和任务分支 |
| `MAIN_DIRECTORY` | 直接使用项目主目录，适合明确不需要隔离的本地 Solo 场景 |

TeamRun 使用 worktree 模式。团队成员可以共享主 workspace，也可以按成员策略创建 dedicated child workspace。

## Git 操作

Workspace 支持：

- 查看 diff
- 查看 Git status
- rebase 到主分支
- abort 当前 Git 操作
- squash merge
- 处理 merge/rebase 冲突
- 在 IDE 中打开 workspace

## 预览代理

Workspace 面板提供 Preview 标签页。你可以配置本机预览服务地址，例如：

```text
127.0.0.1:5173
```

Preview 提供地址栏、后退、前进、刷新和新窗口等浏览器操作。地址栏可以输入路径、完整的 localhost URL 或另一个本地端口；同端口切换页面不会改写 workspace 配置，切换端口时会更新预览目标并继续打开指定路径。

Session Log 或 Team Room 消息中的 localhost 链接也会打开对应 workspace 的 Preview。桌面端自动展开右侧 Preview，移动端自动切换到 Workspace/Preview；普通外部链接仍按原方式打开。

后端会为打开的 Preview 创建一个独立根路径网关，并转发普通 HTTP、WebSocket、Cookie、表单和浏览器存储所需的能力。页面跳转 `/login` 或读取 `/assets` 时仍然停留在预览根目录，不会落到 Agent Tower 自身路由。目标应用自己的登录 Cookie 会与外层 Agent Tower 隔离，因此本地和远程 Preview 都可以完成登录并保持会话。

本机和局域网客户端通过 Agent Tower 主机的网关端口访问；从 HTTPS 或 Cloudflare tunnel 打开时，后端按需创建一条独立的预览 Quick Tunnel。同一 workspace 的多个页面复用同一入口，全部关闭或失联并空闲 10 分钟后自动回收。用户不需要让手机直接连接电脑的 loopback 地址。

预览目标只允许 `localhost`、`127.0.0.1`、`::1` 等 loopback 地址，不能指向任意外部主机。Preview 面向已登录用户主动打开的可信本地开发服务；为保证应用可以完整运行，预览页拥有脚本和同源能力，不要打开不可信的本地页面。

## 休眠与恢复

空闲 workspace 可以休眠，以减少本地工作区堆积。需要继续任务时，可以 reactivate，把 workspace 恢复为可操作状态。

## 使用建议

- 每个 task 尽量对应一个清晰的工作目标
- 不要让一个 workspace 长期承担多个不相关需求
- 合并前先审查 diff，而不是只相信 agent 的完成提示
- 冲突较多时，优先 rebase 后让 agent 处理局部冲突，再人工复核
