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
- Preview 状态与运行会话分离：`usePreviewStatus` 读取 target readiness，`usePreviewSession` 在面板挂载时申请独立 gateway URL、每 30 秒续租并在卸载时释放。本地 HTTP 页面连接 Agent Tower 主机上的 gateway 端口；HTTPS/tunnel 页面使用后端创建的独立 Quick Tunnel，不能回退为客户端自己的 loopback。
- Preview iframe 与 gateway 跨 origin，工具栏通过注入的受控 `postMessage` bridge 同步位置和执行前进/后退/刷新；页面功能不能依赖 bridge。地址栏显示真实 target URL；同 endpoint 导航只更换 gateway path，切换端口或协议时持久化新 target 并等待新 session。新窗口必须使用带最新 bootstrap token 的 session URL。
- Session Log 与 RoomTimeline 中的 loopback 链接是 workspace Preview 导航命令，不是客户端直接打开的普通外链。桌面展开对应 workspace 的 Preview，移动端切到 Workspace/Preview；RoomMessage 优先使用 `senderInvocationId -> invocation.workspaceId`，缺失来源时才回退当前 workspace。普通外部链接保持原行为。

测试重点覆盖 cache rollback/upsert、Socket listener cleanup/reconnect、mention/visibility 和 workspace 模式分支。用户可见交互再验证桌面与移动 viewport。
