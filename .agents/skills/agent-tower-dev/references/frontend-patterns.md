# 前端开发模式

## 状态职责

`apiClient` 处理 `/api`、same-origin credentials 和 `ApiError`。TanStack Query 管理可由 REST 重建的状态；Zustand 管理高频流式或客户端状态，尤其是 `session-log-store`、agent 和 UI 状态。

大多数 key 位于 `hooks/query-keys.ts`，TeamRun key 当前与 `use-team-run.ts` 共置。Mutation 根据领域选择失效、乐观更新与失败回滚；跨实体动作要覆盖 task、workspace、TeamRun 等全部受影响 key。

列表使用 preview/truncated DTO。Task 看板统一由 `useTaskBoard` 请求 `/api/task-board`；All Projects 也只发一个 board 请求，不按 project 创建 `useQueries` fan-out。Task 正文通过 `useTaskBody` 按需读取，RoomMessage 列表与全文详情分离。

Task mutation 和 `task:*`/TeamRun 实时事件必须同时维护或失效 task board cache 与旧 task list cache；board item 通过 `projectId` 关联 projects cache 获取项目元数据，不把完整 Project 复制进每个 task DTO。

## 实时同步

App 只建立一个 `socketManager` 连接。全局 task、TeamRun、workspace Git 同步由 `GlobalRealtimeSync` 挂载；session/terminal 使用专门订阅 hook。

监听 shared 事件常量和 payload，在 effect cleanup 中解除相同 handler。所有依赖 Socket 的状态都要有重连补偿；invalidation 与 Git changed payload 只触发重查，不在前端推演完整业务状态。

高频 `session:patch` 写入 session log store，不写入 Query cache。出现 patch seq 缺口时重新加载 snapshot；修改该链路时同时检查 server MsgStore、`useNormalizedLogs` 和 reconnect tests。

## 组件与 i18n

沿用 `@/` alias、无分号格式、现有 `components/ui` 和领域组件。路由集中在 `routes/index.tsx`；Settings 由 dialog/store 驱动，新增 tab 时同步 tab 类型、dialog 和 redirect mapping。

用户文案使用 `useI18n().t()` 或 `translate`，并更新 `lib/i18n/messages.ts`。同时提供 loading、disabled、error、mobile 状态；终端、Monaco 和日志视图保持稳定容器尺寸并复用现有 virtualize/auto-fit/scroll helper。

## Workspace、TeamRun 与 Preview

- 使用后端返回的 `workingDir`/`workspaceKind`；`MAIN_DIRECTORY` 或非 Git 项目隐藏不成立的 Git 操作。
- TeamRun 可能有 main/shared 与多个 dedicated member workspace，不假设 task 只有一个 workspace。
- RoomTimeline 使用结构化 mention、participant 和 stable id；不从显示文本解析权限或派活关系。
- Preview iframe 使用 `lib/preview-url.ts` 生成同源 `/view/:workspaceId` URL，不直接暴露 loopback target。

测试重点覆盖 cache rollback/upsert、Socket listener cleanup/reconnect、mention/visibility 和 workspace 模式分支。用户可见交互再验证桌面与移动 viewport。
