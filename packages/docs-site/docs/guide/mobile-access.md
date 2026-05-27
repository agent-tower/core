---
title: 移动端访问
description: 通过 tunnel 和移动端页面查看任务进度。
---

# 移动端访问

Agent Tower 支持从手机查看任务进度。常见方式是用 Cloudflare tunnel 暴露本机服务。

## 使用场景

- 离开电脑后查看 agent 是否完成
- 收到通知后在手机上快速审查状态
- 查看任务详情、日志和变更摘要

## Tunnel

应用内的 tunnel 功能会启动 Cloudflare tunnel，并返回可访问的外部地址。

工作方式：

```text
Mobile browser -> Cloudflare tunnel -> local Agent Tower server
```

## 安全提醒

Agent Tower 是本地优先的开发工具。通过 tunnel 暴露服务时，需要注意：

- 不要把 tunnel 地址公开发到不可信渠道
- 用完后关闭 tunnel
- 避免在公共网络中长期开启
- 不要在无保护环境中暴露包含敏感仓库的本地服务

## 移动端界面

移动端重点展示：

- 任务列表
- 任务详情
- 日志流
- Git changes
- 历史记录

复杂冲突和大规模 diff 审查仍建议回到桌面端处理。
