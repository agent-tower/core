# 后端开发模式

本页覆盖 HTTP、持久化、读模型、事件和 MCP。Git workspace、后台进程及安全边界见 [workspace-security-patterns.md](workspace-security-patterns.md)；执行生命周期见 [pipeline-patterns.md](pipeline-patterns.md)。路径相对仓库根目录，以下 server 路径省略 `packages/server/src/`。

## 启动与资源所有权

- `cli.ts` 是发布 CLI；`index.ts` 是源码开发/直接服务入口。二者先设置 data dir、数据库 URL、端口等环境，再加载应用。`utils/index.ts` 在模块加载时创建 Prisma 单例，不能把环境初始化移到它之后。
- `app.ts:buildApp()` 是组合根：先配置 SQLite 并执行启动数据迁移，再注册插件、认证 hook、routes；`onReady` 启动 Socket、后台服务恢复、休眠/心跳/任务清理和独立对话队列。
- 为新 timer、watcher、worker 或 listener 添加成对的启动和关闭路径。`onClose`、`socket/index.ts:closeSocket()` 与 `runtime/server-entry-shutdown.ts` / `shutdown-coordinator.ts` 共同参与关闭，不能假设关闭 HTTP listener 就已清理所有进程。
- `core/container.ts` 持有共享生命周期服务；普通 CRUD Service 通常由 Route 实例化。`getTerminalManager()` 延迟加载原生 node-pty，保留 async，避免原生依赖故障拖垮不相关 API。

## Route 与 Service

常规 CRUD 看 `routes/tasks.ts` / `services/task.service.ts`；编排看 `routes/team-runs.ts`；进程控制看 `routes/sessions.ts`；特殊协议边界看 `routes/files.ts` / `previews.ts`。

1. 用 Zod 校验不可信输入，multipart、proxy 等 Route 沿用邻近模式。
2. Service 负责状态约束、事务和副作用补偿；Route 决定 status 和 error payload。`errors.ts:ServiceError` 可表达业务失败，但已有错误响应尚未全局统一，不能只改调用方假定统一 envelope。
3. 在 `routes/index.ts` 核对注册 prefix；许多 Route 自带 `/workspaces`、`/sessions` 等路径，仅注册在 `/api` 下。`previewRoutes` 同时注册 `/api/previews` 和兼容 `/view`，不能机械套 prefix。
4. 修改可被 Agent 调用的接口时，同时查 `mcp/http-client.ts`、对应工具和权限来源；修改可见数据时查 web query key 和实时失效入口。

## 数据库与迁移

- schema 位于 `packages/server/prisma/schema.prisma`。UUID string 主键、String 业务状态和 JSON string 字段沿用现有模型；共享状态类型在 `packages/shared/src/types.ts`。JSON 在 Service mapper 中序列化并兼容旧值，DTO 不直接扩散 Prisma row。
- `utils/index.ts:initializeDatabaseRuntime()` 在接收请求前启用 WAL 和 busy timeout。队列扫描、软删除及关系查询需要相应 index；跨实体状态变更放事务，事务后的进程/文件动作保留失败、重试或补偿路径。
- 修改 schema 后生成 Prisma Client，并提供仓库约定的 migration SQL。但发布 CLI 和开发 `index.ts` 实际使用 `prisma db push --skip-generate` 同步结构，不会执行 migration SQL 中的数据转换。
- 需要回填历史数据时，另更新 `services/database-maintenance.service.ts:runStartupDataMigrations()`：通过 `AppSettings.dataMigrationVersion` 幂等执行，在同一事务最后推进版本。不能仅靠 migration SQL，也不要在启动迁移中强行重写所有历史记录。
- 旧运行时的 ownership / launch evidence 不完整时采取保守恢复；缺少 `ExecutionProcess` 行不能证明进程从未启动或已经退出。相关清理语义见 runtime reference。

## Task 与 Project 读写模型

- 看板走 `GET /api/task-board` 和 `TaskService.findBoard()` 的紧凑 DTO，批量读取 task、首选 workspace 与最新 session。完整 description 和历史通过详情/body 接口按需读取；列表 mapper 不加载完整关系或按 task/project 启动额外查询。
- `TaskService` 有不同的创建和更新归一化路径。创建时，超长单一 title 按完整 Unicode code point 边界派生展示 title 和剩余正文，正文保留原始空白并放在独立 description 前面；更新长标题则沿既有 `normalizeUpdateTaskInput()` 合并输入和原 description。不要把二者统一成新算法或顺带回写历史 RoomMessage。
- Agent prompt、TeamRun 首条消息和 WorkRequest instruction 使用 `title + description`；trim 只用于判断 description 是否为空，保留正文实际内容，不按文本相似度猜测来源。
- Task 普通读取和变更要考虑 `deletedAt` 与 Project `archivedAt`，复用 `services/deleted-task-guard.ts` / `project-guards.ts`。删除先标记 Task、保存 `TaskCleanupJob` 快照并取消待执行 TeamRun 工作，再由 `task-cleanup.service.ts` 停止 Session、回收 worktree/branch 并最终硬删除。仅 cascade 或同步删数据库行不能完成资源回收。
- Project 的 Git capability 是持久化读模型。列表只读保存值，旧 null 值可做廉价 `.git` fallback；创建、恢复、显式 refresh 和危险 Git 操作前才实时探测。不要在列表请求运行 `git rev-parse`。
- `Project.lastActivityAt` 由最近未删除 Task 的 `createdAt` 聚合，没有 Task 时用 Project `createdAt`；更新 Task 不推进该值。前端按服务端字段排序，不能从分页/过滤后的 board 反推。

## EventBus 与 Socket.IO

```text
Service / Manager
  -> core/event-bus.ts:EventMap
  -> socket/socket-gateway.ts
  -> packages/shared/src/socket/events.ts
  -> packages/web/src/lib/socket/ 与 hooks/
```

新增事件时同步事件声明、payload、forwarder 和前端订阅/释放。namespace 固定为 `/events`，`socket/events.ts` 转导出 shared 契约。Session stdout/patch/status、Task 和部分 Workspace 事件广播到通过认证的整个 namespace；独立 Terminal 保留 room 分发。不要把 room 订阅当作所有业务消息的隔离保证。

`team-run:invalidated`、`workspace:git_changed` 是重新查询信号。断线后要重新读 authoritative REST state；日志还需处理 snapshot/patch seq，见前端 reference。Gateway 的认证状态会在消息和转发时复验，新增路径应沿用检查并释放 listener。

## MCP 与配置

- MCP 是 REST 客户端，不直接访问 Prisma。入口为 `mcp/index.ts`，`mcp/http-client.ts` 处理 HTTP 和结构化 `AgentTowerApiError`，普通工具在 `mcp/tools/`，TeamRun room/queue 工具目前仍集中在 `mcp/server.ts`。
- 区分全局、workspace-context 和 TeamRun invocation 工具。`mcp/context.ts` 用 cwd 和注入的 Session 解析 workspace；同一主目录可能对应多个 workspace，不要只靠路径猜测身份。
- 托管 MCP 配置由 `services/mcp-config.service.ts` 生成并使用 session/invocation credential；独立 MCP 可用 internal token。工具参数不能替代经过后端验证的调用身份，TeamRun 还检查 membership、capability 和消息可见性。
- Provider 由 `services/provider-config.service.ts` 持久化，连接解析和 CLI/ACP 投影见 pipeline reference；不要新增第二套配置存储。`routes/profiles.ts` 为兼容入口，新功能先查 Provider 模型。

## 按改动验证

从仓库根目录执行 `pnpm exec vitest run <路径>`，选择相关文件；同一单元格中省略目录的文件沿用前一个目录：

| 行为 | 测试入口 |
| --- | --- |
| Task / Project / 列表与删除 | `packages/server/src/services/__tests__/task.service.test.ts`、`project.service.test.ts`、`packages/server/src/routes/__tests__/tasks.test.ts` |
| 启动与数据迁移 | `packages/server/src/app.test.ts`、`packages/server/src/utils/database-runtime.test.ts`、`packages/server/src/services/__tests__/database-maintenance.service.test.ts` |
| Socket 转发与订阅 | `packages/server/src/socket/__tests__/socket-gateway.test.ts` |
| MCP 契约 | `packages/server/src/mcp/http-client.test.ts`、`packages/server/src/mcp/tools/__tests__/` 中的对应文件 |

数据库测试在 import Prisma 前设置独立临时库，再做 schema 同步，并在 teardown 断开连接和释放资源；可参考 `services/__tests__/project.service.test.ts`。跨端 DTO/API 变化还要构建 shared、server 和受影响的 web/desktop。
