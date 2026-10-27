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
2. 从任务创建时保存的基础分支创建任务分支；未记录基础分支的历史任务使用项目默认值；TeamRun 成员工作区从父工作区分支创建
3. 创建 git worktree 目录
4. 复制 Project 配置的 `copyFiles`
5. 执行 `setupScript`
6. 记录 workspace 状态和路径

## 修改基础分支

在 **设置 → 项目配置 → 选择项目 → 默认基础分支** 中，选择本地分支并保存，配置以后创建任务时的默认值。创建任务时可以单独选择其他本地分支；任务保存该选择，普通工作区和 TeamRun 主工作区稍后创建时也沿用它。已有工作区（包括休眠后恢复的工作区）保留各自的基础分支，主仓库当前检出的分支不决定新工作区的默认起点。

修改单个工作区时，在该任务的 **合并 / 提交变更确认框** 中选择“当前工作区的基础分支”，点击“保存基础分支并审查变更”。此设置决定该 workspace 的差异比较、rebase 更新基准，以及根 workspace 的合并目标。

仅活跃的工作树根 workspace 支持修改；主目录模式、已休眠或已合并的 workspace 不提供此入口。TeamRun 成员子 workspace 的目标由父 workspace 管理。所选分支必须已在本地存在、与 workspace 分支不同且具有共同提交历史；运行中的 Agent 或未结束的 Git 操作会阻止保存。

保存只更新当前 workspace 的基础分支，不移动已有提交、不执行 rebase，也不修改项目默认分支或其他 workspace。保存成功后关闭确认框，返回任务审查变更；如果落后于新的基础分支，先执行更新，再确认合并。

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

## 后台服务

需要跨 Agent turn 持续运行的开发服务器、watcher 或 worker 由 Workspace 作为后台服务托管。Agent Session、CLI/ACP 或页面 Socket 结束不会停止它们；Workspace 休眠、归档、删除或显式服务停止仍会清理对应进程树。

Agent Tower 关闭时会停止托管服务，重启后不会自动启动各任务原有的后台服务。启动时会清除遗留的运行状态和恢复意图，包括旧版本保存的期望运行记录；命令定义保留，需要时可由 Agent 再次调用后台服务工具启动。

Workspace 的 Terminal 标签页分为“交互终端”和“后台服务”。后台服务列表显示服务名、运行状态、结构化命令、相对工作目录和启动时间；选择服务后可以查看有界日志。已经完全停止且不再期望运行的服务定义不会显示，也不占用每个 workspace 最多 20 个服务的配额；同名同配置启动时仍可复用保存的定义。当前 Web UI 是只读视图，不提供输入、停止、重启或关闭服务按钮，普通交互终端的关闭行为保持不变。

日志通过 runtime generation 与 seq 游标增量加载。页面会在服务重启或 Agent Tower 重启导致 generation 变化时丢弃旧缓存，并从新 generation 重新显示；只有 generation/reset、较早内容被有界 buffer 截断或浏览器本地裁剪时才提示较早日志不可用，正常分页追平不会显示该提示。

## 休眠与恢复

空闲 workspace 可以休眠，以减少本地工作区堆积。需要继续任务时，可以 reactivate，把 workspace 恢复为可操作状态。

休眠、归档和删除会先清理关联 Session 的运行进程，包括已完成回复但仍保留的 ACP 连接，并停止托管后台服务。清理未确认成功时会保留 workspace 和进程记录，供重试；清理期间暂停接受新的 Session 或后续消息。任务删除和自动清理也遵循这一规则。

关闭独立交互终端会等待其命令及子进程退出。多个页面同时打开同一 workspace 的预览会共享入口；切换预览目标或关闭服务时，正在创建的预览隧道也会被回收。

## 任务完成与历史保留

任务完成后，系统会清理已合并或已归档 workspace 的工作目录、相关运行进程和可安全删除的分支。自动清理、手动系统清理以及单独删除 workspace 都保留任务下的会话记录和已持久化的对话日志；普通任务与 TeamRun 成员会话遵循同一规则。

清理后的任务仍可查看历史消息和工具调用记录，刷新页面、重启 Agent Tower 后也可读取。历史工作区只用于查看；继续执行任务时创建或重建可用工作区，已有会话历史继续保留。主目录模式只释放 workspace 的运行资源及目录绑定，不删除项目文件。仍被子任务引用的分支会保留，直到引用释放后再清理。

显式删除任务时，才随任务删除对应的会话及历史日志。任务完成与删除任务是两个不同的操作。

## 使用建议

- 每个 task 尽量对应一个清晰的工作目标
- 不要让一个 workspace 长期承担多个不相关需求
- 合并前先审查 diff，而不是只相信 agent 的完成提示
- 冲突较多时，优先 rebase 后让 agent 处理局部冲突，再人工复核
