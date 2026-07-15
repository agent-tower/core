---
name: agent-tower-dev
description: >-
  Agent Tower 仓库开发指南。处理该项目中的代码、测试、数据库、公开文档或架构变更时使用，包括 Fastify/Prisma/Socket.IO、
  Agent Pipeline、Git workspace、TeamRun、MCP、React/TanStack Query/Zustand、Electron 和 Docusaurus。指导识别跨层契约、
  沿用真实代码模式、按风险验证，并在项目边界变化时同步维护本 skill。
---

# Agent Tower 开发指南

## 工作流程

1. 读取与任务对应的 reference，再检查同领域最近的实现和测试；以代码为准，历史设计可能过时。
2. 标出受影响的共享类型、数据库、Service/Route、Socket/MCP、前端 cache/store、生命周期和测试。
3. 沿用邻近模块的错误响应和依赖模式。新旧模式并存时，不借局部改动统一全仓库。
4. 将业务不变量放 Service，将进程生命周期放 `SessionManager`/`AgentPipeline`，让 HTTP 层只解析和响应。
5. 先运行最窄测试，再构建受影响包；跨层契约变化时扩大验证。

## 按需读取

- Route/Service、Prisma、Socket、workspace、认证、preview、MCP：[backend-patterns.md](references/backend-patterns.md)
- React、Query cache、Zustand、实时同步、i18n：[frontend-patterns.md](references/frontend-patterns.md)
- Session、PTY、Executor、Parser、MsgStore、新增 Agent：[pipeline-patterns.md](references/pipeline-patterns.md)
- TeamRun、成员、消息、WorkRequest、Invocation、成员 workspace：[teamrun-patterns.md](references/teamrun-patterns.md)
- Electron runtime、打包、公开文档站：[desktop-docs-patterns.md](references/desktop-docs-patterns.md)

## 必守边界

- 将跨端实体、状态和 Socket payload 放在 `@agent-tower/shared`；server ESM import 保留 `.js` 后缀。
- Prisma 业务状态通常存为 `String`，由 shared enum/union 约束；JSON string 在 Service 边界转换。
- 实时变更同时检查 `EventMap`、shared Socket contract、`SocketGateway` 和前端重连/缓存失效。
- 不绕过 tunnel/access/Socket auth、CSRF、internal token、local-only、preview token 或 loopback 限制。
- 同时支持 `WORKTREE` 与 `MAIN_DIRECTORY`；不要假设每个项目都是 Git 仓库或每个任务只有一个 workspace。
- 保留 PTY early-event handoff、parser exactly-once finish、原始 stdout 兜底和日志脱敏。
- 列表热路径使用 preview/truncated DTO；完整 task/message 正文按需加载。

## 自动维护本 Skill

完成每个开发任务前，检查本次变更是否改变了可复用的项目边界：包或模块职责、跨包类型/API/Socket/MCP 契约、生命周期或状态机、认证与信任边界、workspace/session/TeamRun/desktop runtime 语义、标准目录或开发命令。

若改变任一边界，必须在同一变更中更新本 `SKILL.md` 或对应 reference，删除已失效说明，并运行 skill validator。局部算法、一次性 bug 修复或容易继续变化的实现细节不写入 skill；只记录会影响后续 Agent 决策的稳定且非显然规则。

## 验证

```bash
pnpm exec vitest run <test-file>
pnpm --filter @agent-tower/shared build
pnpm --filter @agent-tower/server build
pnpm --filter web build
pnpm build
```

公开行为变化同步 `packages/docs-site/docs/`；内部计划和专项排障才写顶层 `docs/`。跨包构建遵循 `shared -> server -> web/desktop`。
