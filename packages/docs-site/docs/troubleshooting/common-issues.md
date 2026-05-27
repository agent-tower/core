---
title: 常见问题
description: 文档站和主应用的常见排查入口。
---

# 常见问题

## 页面打不开

先确认服务是否启动：

```bash
agent-tower
```

或者检查端口是否被占用。

## Project 创建后无法启动 session

常见原因：

- `repoPath` 不存在
- 目录不是 Git 仓库
- 项目已归档
- provider 未配置或不可用

## provider 不显示

先在 provider 页面执行 reload。若仍然不可见，检查本机 CLI 是否在 PATH 中可用。

## tunnel 地址无法访问

检查：

- tunnel 是否仍然开启
- 链接是否过期
- 本机服务是否仍在运行
- 防火墙或代理是否拦截

## diff 为空

常见原因：

- workspace 中没有实际改动
- 修改已经被提交
- 当前 session 还没结束，日志与文件变更还在收敛

## 文档站构建失败

先检查是否装了依赖：

```bash
pnpm install
```

再单独构建文档站：

```bash
pnpm docs:build
```
