---
name: agent-tower-dev
description: >-
  Agent Tower 仓库开发与代码分析指南。修改或审阅该项目的后端、CLI/ACP runtime、TeamRun、Git workspace、MCP、
  React 前端、Electron 桌面端、数据库及公开文档时使用。定位跨层契约、生命周期和验证入口，
  并在稳定架构边界变化时同步维护开发指导。
---

# Agent Tower 开发指南

## 工作流程

1. 先看工作区状态和相关包的 `package.json`，按任务读取下列 reference；以真实实现和邻近测试为准，历史设计及 `CLAUDE.md` 可能落后于代码。
2. 沿调用链检查 shared 类型、Prisma、Service/Route、Socket/MCP 和前端缓存。涉及执行时，另外区分 Task、Session、runtime turn、OS 进程和 TeamRun Invocation 的状态与所有者。
3. 业务不变量放 Service；`SessionManager` 负责业务会话及持久化，`RuntimeCoordinator` 协调 CLI/ACP Driver。`AgentPipeline` 只是 CLI 的 PTY/解析子链路，不代表全部 Agent 执行。
4. 沿用邻近错误响应、依赖注入和缓存模式；普通 Route 做输入及响应转换，已有特殊文件/代理 Route 不借局部需求统一重构。
5. 先验证直接受影响的行为，再按跨包契约扩大检查。公开行为变化同步 `packages/docs-site/docs/`；专项设计和内部排障放顶层 `docs/`。

## 仓库入口

| 范围 | 实际入口 |
| --- | --- |
| 共享契约 | `packages/shared/src/types.ts`、`socket/events.ts`、`agent-runtime-support.ts`、`provider-capabilities.ts` |
| 服务及 CLI | `packages/server/src/cli.ts` / `index.ts` 设置环境并同步 schema，`app.ts` 组合 HTTP、Socket、worker |
| Agent 执行 | `packages/server/src/services/session-manager.ts`、`runtime/`、`pipeline/`、`executors/`、`output/` |
| 浏览器应用 | `packages/web/src/routes/index.tsx`、`hooks/`、`lib/socket/`、`stores/` |
| 桌面及文档 | `packages/desktop/src/main.ts`、`scripts/build-publish.mjs`、`packages/docs-site/` |

表中短路径沿用该行已标出的 `src` 目录，完整路径相对仓库根目录。shared 包对外导出指向 `dist`；Vitest 则将主要 shared import alias 到源码，因此测试通过不代表跨包构建已通过。

## 按需读取

- Route/Service、Prisma、任务读模型、Socket、MCP：[backend-patterns.md](references/backend-patterns.md)
- Git workspace、后台服务、认证、preview、文件交付：[workspace-security-patterns.md](references/workspace-security-patterns.md)
- React、Query cache、Zustand、实时同步、i18n：[frontend-patterns.md](references/frontend-patterns.md)
- CLI/ACP runtime、Session、Provider、独立对话、Parser、新增 Agent：[pipeline-patterns.md](references/pipeline-patterns.md)
- TeamRun、成员、消息、WorkRequest、Invocation、成员 workspace：[teamrun-patterns.md](references/teamrun-patterns.md)
- Electron runtime、打包、公开文档站：[desktop-docs-patterns.md](references/desktop-docs-patterns.md)

## 必守边界

- 将跨端实体、状态和 Socket payload 放在 `@agent-tower/shared`；server ESM import 保留 `.js` 后缀。
- Prisma 业务状态通常存为 `String`，由 shared enum/union 约束；JSON string 在 Service 边界转换。schema 同步不等于历史数据迁移。
- 实时变更同时检查 `EventMap`、shared Socket contract、`SocketGateway` 和前端重连/缓存失效；Socket 通知不能代替 REST 恢复。
- 保留 browser、internal、Agent credential 的身份区分，以及 tunnel/access/Socket auth、CSRF、local-only 和 preview loopback 边界。
- 同时支持 `WORKTREE` 与 `MAIN_DIRECTORY`；不要假设每个项目都是 Git 仓库或每个任务只有一个 workspace。
- 使用根 `package.json` 固定的 pnpm 版本；新增带安装脚本的依赖时先审核脚本，再在 `pnpm-workspace.yaml` 的 `allowBuilds` 中明确设为 `true` 或 `false`。
- runtime 逻辑完成、连接关闭和整棵进程树清理是不同事实；未确认清理前不释放可重用资源或宣称停止成功。
- 列表热路径使用 preview/truncated DTO；完整 task/message 正文按需加载。

## 自动维护本 Skill

完成开发任务前，检查是否改变了可复用的项目边界：包或模块职责、跨包类型/API/Socket/MCP 契约、生命周期或状态机、认证、workspace/session/TeamRun/desktop 语义、标准目录或开发命令。

若改变任一边界，必须在同一变更中更新本 `SKILL.md` 或对应 reference，删除已失效说明，并运行可用的 `skill-creator/scripts/quick_validate.py`。同时核对引用文件和验证命令。局部算法、一次性排障结论和易变常量不写成普遍规则；区分代码现状与拟议改进。

## 验证

以下命令从仓库根目录执行，按改动选用：

| 改动 | 验证 |
| --- | --- |
| 具体行为 | `pnpm exec vitest run <test-file>`；领域 reference 列出定位入口 |
| shared 契约 | `pnpm --filter @agent-tower/shared build`，再构建受影响消费包 |
| server | `pnpm --filter @agent-tower/server build`，包含 Prisma generate |
| web | `pnpm --filter web build`；需要 lint 时用 `pnpm --filter web lint` |
| desktop / 公开文档 | `pnpm --filter @agent-tower/desktop build` / `pnpm docs:build` |
| 安装和发布产物 | 按 publish skill 构建并只打包一次；完整验证用 `pnpm publish:smoke --tarball <path>`；桌面验收见对应 reference |

根 `vitest.config.ts` 收集 `packages/**/*.test.{ts,tsx}`；根目录没有 `pnpm test` 脚本。`pnpm lint` 当前只覆盖声明 lint 的包，不能代替 server/desktop 类型检查。`pnpm build` 包含文档站，按需使用，跨包构建遵循 `shared -> server -> web/desktop`。

需要真实数据库或进程的验证使用临时 data dir、独立 SQLite 和仓库；在导入共享 Prisma 单例前设置 `AGENT_TOWER_DATABASE_URL`。测试结束销毁 manager、listener、timer、process 并断开 Prisma。开发入口有自动 schema 同步，不将验证指向正在使用的数据目录。仅更新 skill 时验证文档与路径即可，无需启动应用或跑全量业务测试。
