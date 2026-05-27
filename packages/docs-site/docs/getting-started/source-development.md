---
title: 源码开发
description: 从源码运行 Agent Tower。
---

# 源码开发

Agent Tower 是 pnpm monorepo，主要包含 `shared`、`server`、`web` 和 `docs-site`。

## 准备

```bash
git clone https://github.com/agent-tower/core.git
cd agent-tower
pnpm setup
```

`pnpm setup` 会安装依赖，并先构建共享包。

## 启动开发服务

```bash
pnpm dev
```

这个命令会并行启动各包的开发脚本。开发时常用的是：

```bash
pnpm --filter @agent-tower/server dev
pnpm --filter web dev
pnpm --filter @agent-tower/docs-site dev
```

## 构建

构建主应用：

```bash
pnpm build
```

只构建文档站：

```bash
pnpm docs:build
```

本地预览文档站构建产物：

```bash
pnpm docs:serve
```

## 数据库

服务端使用 Prisma + SQLite。开发时可运行：

```bash
pnpm db:generate
pnpm db:push
```

全局 CLI 场景会在启动时把数据库放进 `AGENT_TOWER_DATA_DIR`，源码开发场景通常使用 server 包自己的开发配置。

## 发布构建

发布构建脚本位于 `scripts/build-publish.mjs`。它会构建 `shared`、`server` 和 `web`，然后把可发布 npm 包组装到 `packages/server/publish/`。

文档站是独立静态站点，不参与 CLI npm 包产物。
