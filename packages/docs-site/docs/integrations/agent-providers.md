---
title: Agent Provider
description: 为不同任务选择不同 agent 配置。
---

# Agent Provider

Provider 是 agent 的具体配置实例。它决定某个任务到底由哪个 CLI、哪个 profile、哪些环境变量来执行。

## 支持的 agent

当前支持：

- Claude Code
- Gemini CLI
- Cursor Agent
- Codex

## 为什么要按任务选择 Provider

不同任务适合不同成本和能力组合。

例如：

- 简单的文本调整可以用更便宜的配置
- 复杂重构可以用更强的模型
- 需要特定 CLI 行为时可以切到对应 provider

## Provider 包含什么

一个 provider 通常包含：

- 名称
- agentType
- 环境变量
- CLI 配置
- settings
- 是否默认

## 常见操作

Provider 页面支持：

- 列出所有 provider
- 创建 provider
- 更新 provider
- 删除 provider
- 导出备份
- 从备份导入
- 重新加载配置

## 备份和导入

备份接口导出的主要是用户层配置，不是仓库代码。

你可以先预览导入结果，再真正导入，避免覆盖不符合预期的配置。

## 使用建议

- 为每类 agent 维护一个稳定默认配置
- 不要把太多临时实验配置直接当主配置
- 当 provider 失效时，先 reload，再检查本机 CLI 是否可用
