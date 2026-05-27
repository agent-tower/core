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
| `GET` | `/api/projects/:projectId/tasks` | 获取项目任务列表 |
| `POST` | `/api/projects/:projectId/tasks` | 创建任务 |
| `GET` | `/api/projects/:projectId/tasks/stats` | 获取任务统计 |
| `GET` | `/api/tasks/:id` | 获取任务详情 |
| `PUT` | `/api/tasks/:id` | 更新任务 |
| `PATCH` | `/api/tasks/:id/status` | 更新任务状态 |
| `PATCH` | `/api/tasks/:id/position` | 更新任务位置 |
| `POST` | `/api/tasks/:id/retry` | 重试任务 |
| `DELETE` | `/api/tasks/:id` | 删除任务 |

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

## Sessions

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/workspaces/:workspaceId/sessions` | 创建 session |
| `GET` | `/api/sessions/:id` | 获取 session 详情 |
| `POST` | `/api/sessions/:id/start` | 启动 session |
| `POST` | `/api/sessions/:id/stop` | 停止 session |
| `POST` | `/api/sessions/:id/message` | 给 session 发送消息 |
| `GET` | `/api/sessions/:id/logs` | 获取日志快照 |

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
| `POST` | `/api/tunnel/bootstrap` | bootstrap |
| `POST` | `/api/tunnel/start` | 启动 tunnel |
| `POST` | `/api/tunnel/stop` | 停止 tunnel |

## Files and Git

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/filesystem/browse` | 浏览目录 |
| `GET` | `/api/filesystem/validate` | 校验路径是否为 Git 仓库 |
| `GET` | `/api/files/tree` | 列目录树 |
| `GET` | `/api/files/read` | 读文件 |
| `POST` | `/api/files/write` | 写文件 |
| `GET` | `/api/git/changes` | 查看变更 |
| `GET` | `/api/git/diff` | 查看单文件 diff |
| `GET` | `/api/git/log` | 查看提交历史 |
| `GET` | `/api/git/commit-files` | 查看某次提交变更文件 |
| `GET` | `/api/git/commit-diff` | 查看某次提交的单文件 diff |

## Attachments and App Settings

| Method | Path | 说明 |
| --- | --- | --- |
| `POST` | `/api/attachments/upload` | 上传附件 |
| `GET` | `/api/attachments/:id/file` | 读取附件文件 |
| `GET` | `/api/attachments/by-path` | 按路径查询附件 |
| `GET` | `/api/app-settings` | 读取应用设置 |
| `PUT` | `/api/app-settings` | 更新应用设置 |
| `GET` | `/api/app-settings/commit-message-defaults` | 获取 commit message 默认值 |
