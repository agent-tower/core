---
title: 仓库结构
description: 当前 monorepo 里各包的职责。
---

# 仓库结构

```text
agent-tower/
├── packages/
│   ├── shared/      # 前后端共享类型、Socket 事件、日志适配、端口工具
│   ├── server/      # Fastify + Prisma + Socket.IO + MCP
│   ├── web/         # React 前端
│   └── docs-site/   # Docusaurus 文档站
├── docs/            # 内部文档、设计和历史资料
├── design/          # 设计稿和实验性资料
├── scripts/         # 构建/发布脚本
├── README.md
└── pnpm-workspace.yaml
```

## 各包职责

### shared

共享前后端的类型、Socket 事件和工具函数。

### server

Fastify 服务端，负责 REST API、Socket.IO、Prisma、MCP、Git 工作流和 agent 执行编排。

### web

React 前端，负责任务看板、任务详情、workspace 面板和设置页面。

### docs-site

独立文档站，面向开源用户和新贡献者。

## 目录约定

- `docs/` 里的内容偏内部资料、设计稿、排障记录和项目历史
- `packages/docs-site/docs/` 里的内容偏公开文档
- `README.md` 只保留入口信息，不再承担完整手册
