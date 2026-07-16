---
title: REST API
description: 当前代码库中公开的主要 REST 端点。
---

# REST API

下面是当前代码库公开的主要 REST 端点。接口会随着实现变化，文档站只记录当前已存在的行为。

## System

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/agents` | 列出可用 AI agent |
| `GET` | `/api/system/cursor-agent-models` | 查询 Cursor Agent 可用模型 |
| `GET` | `/api/system/slash-command-catalog` | 获取 slash command 目录 |
| `GET` | `/api/system/skill-catalog` | 获取 skill 目录 |
| `GET` | `/api/system/mcp-config` | 获取当前运行环境的 MCP 客户端配置 |
| `GET` | `/api/system/workspace-context` | 根据 cwd 解析 workspace 上下文 |

## Projects

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/projects` | 列出项目 |
| `POST` | `/api/projects` | 创建项目 |
| `GET` | `/api/projects/:id` | 获取项目详情 |
| `PUT` | `/api/projects/:id` | 更新项目 |
| `POST` | `/api/projects/:id/archive` | 归档项目 |
| `POST` | `/api/projects/:id/restore` | 恢复项目 |
| `DELETE` | `/api/projects/:id` | 删除项目，实际执行归档 |

## Tasks

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/task-board` | 获取跨项目紧凑任务看板；支持 `projectId`、`status`、`page`、`limit` |
| `GET` | `/api/projects/:projectId/tasks` | 获取项目任务列表 |
| `POST` | `/api/projects/:projectId/tasks` | 创建任务 |
| `GET` | `/api/projects/:projectId/tasks/stats` | 获取任务统计 |
| `GET` | `/api/tasks/:id` | 获取任务详情 |
| `GET` | `/api/tasks/:id/body` | 获取完整任务正文和 prompt |
| `PUT` | `/api/tasks/:id` | 更新任务 |
| `PATCH` | `/api/tasks/:id/status` | 更新任务状态 |
| `PATCH` | `/api/tasks/:id/position` | 更新任务位置 |
| `POST` | `/api/tasks/:id/retry` | 重试任务 |
| `DELETE` | `/api/tasks/:id` | 删除任务 |

`/api/task-board` 只返回看板渲染需要的 task、首选 workspace、最新 agent 类型和运行标志，不包含任务正文、完整 workspace 或 session 历史。需要正文时使用 `/api/tasks/:id/body`，需要执行详情时再读取对应 workspace/session 接口。

## Workspaces

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/tasks/:taskId/workspaces` | 创建 workspace |
| `GET` | `/api/tasks/:taskId/workspaces` | 获取任务下所有 workspace |
| `GET` | `/api/workspaces/:id` | 获取 workspace 详情 |
| `GET` | `/api/workspaces/:id/diff` | 获取 workspace diff |
| `POST` | `/api/workspaces/:id/merge` | squash merge |
| `POST` | `/api/workspaces/:id/archive` | 归档 workspace |
| `DELETE` | `/api/workspaces/:id` | 删除 workspace |
| `POST` | `/api/workspaces/:id/open-editor` | 在 IDE 中打开 workspace |
| `POST` | `/api/workspaces/:id/rebase` | rebase workspace |
| `GET` | `/api/workspaces/:id/git-status` | 获取 Git 状态 |
| `POST` | `/api/workspaces/:id/abort-operation` | 中止当前 Git 操作 |
| `POST` | `/api/workspaces/:id/reactivate` | 唤醒休眠 workspace |
| `POST` | `/api/system/cleanup` | 清理可清理的 workspace |
| `POST` | `/api/system/hibernate-idle` | 手动触发空闲 workspace 休眠 |

## Sessions

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/workspaces/:workspaceId/sessions` | 创建 session |
| `GET` | `/api/sessions/:id` | 获取 session 详情 |
| `POST` | `/api/sessions/:id/start` | 启动 session |
| `POST` | `/api/sessions/:id/stop` | 停止 session |
| `POST` | `/api/sessions/:id/message` | 给 session 发送消息 |
| `GET` | `/api/sessions/:id/logs` | 获取日志快照 |

## Conversations

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/conversations` | 列出独立对话 |
| `POST` | `/api/conversations` | 创建独立对话并启动 session |
| `GET` | `/api/conversations/:id` | 获取独立对话详情 |
| `POST` | `/api/conversations/:id/message` | 向独立对话发送后续消息 |
| `POST` | `/api/conversations/:id/stop` | 停止独立对话 session |
| `DELETE` | `/api/conversations/:id` | 删除独立对话 |

## Providers

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/providers` | 列出 providers |
| `GET` | `/api/providers/backup` | 导出 provider 备份 |
| `POST` | `/api/providers/import/preview` | 预览导入 |
| `POST` | `/api/providers/import` | 导入备份 |
| `GET` | `/api/providers/:id` | 获取 provider 详情 |
| `POST` | `/api/providers` | 创建 provider |
| `PUT` | `/api/providers/:id` | 更新 provider |
| `DELETE` | `/api/providers/:id` | 删除 provider |
| `POST` | `/api/providers/reload` | 重新加载 provider 配置 |

## Profiles

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/profiles` | 获取合并后的 profile 配置 |
| `GET` | `/api/profiles/defaults` | 获取默认 profile 配置 |
| `POST` | `/api/profiles/reload` | 重新加载 profile 配置 |
| `GET` | `/api/profiles/:agentType` | 获取某 agent 下的所有 variant |
| `GET` | `/api/profiles/:agentType/:variant` | 获取某个 variant 配置 |
| `PUT` | `/api/profiles/:agentType/:variant` | 创建或更新 variant 配置 |
| `DELETE` | `/api/profiles/:agentType/:variant` | 删除用户自定义 variant |

## Notifications

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/notifications/settings` | 获取通知配置 |
| `PUT` | `/api/notifications/settings` | 更新通知配置 |
| `POST` | `/api/notifications/test` | 测试通知 |

## Tunnel

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/tunnel/status` | 获取 tunnel 状态 |
| `GET` | `/api/tunnel/health` | tunnel 健康检查 |
| `POST` | `/api/tunnel/bootstrap` | bootstrap |
| `POST` | `/api/tunnel/start` | 启动 tunnel |
| `POST` | `/api/tunnel/regenerate` | 重新生成 tunnel 访问 token 并启动 |
| `POST` | `/api/tunnel/stop` | 停止 tunnel |

## Files and Git

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/filesystem/browse` | 浏览目录 |
| `GET` | `/api/filesystem/complete` | 文件路径自动补全 |
| `GET` | `/api/filesystem/validate` | 校验路径是否为 Git 仓库 |
| `GET` | `/api/files/tree` | 列目录树 |
| `GET` | `/api/files/read` | 读文件 |
| `POST` | `/api/files/write` | 写文件 |
| `GET` | `/api/files/image` | 读取 workspace 中的图片文件 |
| `GET` | `/api/git/changes` | 查看变更 |
| `GET` | `/api/git/diff` | 查看单文件 diff |
| `GET` | `/api/git/log` | 查看提交历史 |
| `GET` | `/api/git/commit-files` | 查看某次提交变更文件 |
| `GET` | `/api/git/commit-diff` | 查看某次提交的单文件 diff |

## Attachments and App Settings

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/attachments/upload` | 上传附件 |
| `GET` | `/api/attachments/metadata` | 批量获取附件元数据 |
| `GET` | `/api/attachments/:id/file` | 读取附件文件 |
| `GET` | `/api/attachments/by-path` | 按路径查询附件 |
| `GET` | `/api/app-settings` | 读取应用设置 |
| `PUT` | `/api/app-settings` | 更新应用设置 |
| `GET` | `/api/app-settings/commit-message-defaults` | 获取 commit message 默认值 |

## Terminals

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/terminals` | 创建独立终端 |
| `DELETE` | `/api/terminals/:terminalId` | 销毁独立终端 |

## TeamRun

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/member-presets` | 列出成员预设 |
| `GET` | `/api/member-presets/:id` | 获取成员预设 |
| `POST` | `/api/member-presets` | 创建成员预设 |
| `PATCH` | `/api/member-presets/:id` | 更新成员预设 |
| `DELETE` | `/api/member-presets/:id` | 删除成员预设 |
| `GET` | `/api/team-templates` | 列出团队模板 |
| `GET` | `/api/team-templates/:id` | 获取团队模板 |
| `POST` | `/api/team-templates` | 创建团队模板 |
| `PATCH` | `/api/team-templates/:id` | 更新团队模板 |
| `DELETE` | `/api/team-templates/:id` | 删除团队模板 |
| `POST` | `/api/tasks/:taskId/team-runs` | 为任务创建 TeamRun |
| `GET` | `/api/tasks/:taskId/team-run` | 获取任务关联的 TeamRun |
| `GET` | `/api/team-runs/:id` | 获取 TeamRun 详情 |
| `POST` | `/api/team-runs/:id/messages` | 发送 Team Room 公开消息 |
| `POST` | `/api/team-runs/:id/private-messages` | 发送 Team Room 私聊消息 |
| `GET` | `/api/team-runs/:id/messages` | 列出 Team Room 消息 |
| `GET` | `/api/team-runs/:id/messages/:messageId` | 获取单条 Team Room 消息 |
| `GET` | `/api/team-runs/:id/members` | 列出 TeamRun 成员 |
| `POST` | `/api/team-runs/:id/members` | 添加 TeamRun 成员 |
| `PATCH` | `/api/team-runs/:id/members/:memberId` | 更新 TeamRun 成员 |
| `POST` | `/api/team-runs/:id/members/:memberId/remove` | 移除 TeamRun 成员 |
| `GET` | `/api/team-runs/:id/work-requests` | 列出 TeamRun WorkRequest |
| `GET` | `/api/team-runs/:id/members/:memberId/work-requests` | 列出成员 WorkRequest 队列 |
| `POST` | `/api/team-runs/work-requests/:id/approve` | 批准 WorkRequest |
| `POST` | `/api/team-runs/work-requests/:id/reject` | 拒绝 WorkRequest |
| `POST` | `/api/team-runs/work-requests/:id/cancel` | 取消 WorkRequest |
| `POST` | `/api/team-runs/:id/members/:memberId/stop` | 停止成员当前工作 |
| `GET` | `/api/team-runs/:id/invocations` | 列出 TeamRun agent invocation |

## Agent CLI Environment

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/agent-cli/manifest` | 获取可检测/安装的 Agent CLI manifest |
| `GET` | `/api/agent-cli/status` | 获取本机 Agent CLI 状态 |
| `POST` | `/api/agent-cli/status/refresh` | 刷新本机 Agent CLI 状态 |
| `POST` | `/api/agent-cli/install-previews` | 创建安装预览 |
| `GET` | `/api/agent-cli/install-previews/:id` | 获取安装预览 |
| `POST` | `/api/agent-cli/install-tasks` | 创建安装任务 |
| `GET` | `/api/agent-cli/install-tasks/:id` | 获取安装任务 |
| `GET` | `/api/agent-cli/install-tasks/:id/logs` | 获取安装任务日志 |
| `POST` | `/api/agent-cli/install-tasks/:id/cancel` | 取消安装任务 |

安装执行类接口带本机访问限制，用于避免远程 tunnel 触发本机安装。

## Preview

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/previews/:workspaceId/status` | 获取 workspace 预览代理状态 |
| `PUT` | `/api/previews/:workspaceId/config` | 配置 workspace 预览目标 |
| `ANY` | `/view/:workspaceId` | 预览同源反向代理入口 |
| `ANY` | `/view/:workspaceId/*` | 预览同源反向代理子路径 |

预览目标只允许 loopback HTTP/HTTPS 地址。
