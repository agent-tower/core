# 前端开发模式

下列路径相对 `packages/web/src/`，配置和测试命令从仓库根目录执行。

## 入口、访问与路由

- `App.tsx` 先挂载 Query provider 和 `components/access/AccessGate.tsx`，访问认证通过后才挂载 Socket、全局同步和路由。新入口不要绕过此顺序。
- `lib/api-client.ts` 统一处理 API base URL、same-origin credentials、204 和携带后端 details 的 `ApiError`。`lib/api-base-url.ts` 在开发环境把 loopback API/Socket 配置转回同源代理；`packages/web/vite.config.ts` 代理 `/api`、`/socket.io`、`/view` 并重写 HTTP/WS Origin。开发端口来自 shared `getDevPort(repoRoot)`，不能假设后端恒为 12580。
- 活跃路由表在 `routes/app-routes.tsx`：首页是 `ProjectKanbanPage`，另有 conversations 和演示页。`routes/index.tsx` 只负责 `createBrowserRouter(appRoutes)` 并导出 `AppRouter`；路由表单独成模块，测试才能用 `createMemoryRouter(appRoutes, ...)` 挂载生产层级。Settings 是 `SettingsDialog` 加 `ui-store`，旧 `/settings/:tab` 由 `routes/SettingsRedirect.tsx` 打开 dialog 后跳回首页；新增 tab 同步类型、dialog 与 redirect mapping。不要仅因存在 `HomePage`/`SettingsLayout` 文件就将其视为当前入口。
- 渲染兜底按层级分工，改动时不要破坏依赖方向：路由 `errorElement` 用 `components/errors/RouteErrorPage.tsx`（pathless 分组保留 `RootLayout` 外壳，根路由兜 `RootLayout` 自身）；`AppRootBoundary` 兜路由外渲染错误（回退 UI 用 `useI18n`，必须在 `I18nProvider` 之内）；`AppShellBoundary` 高于全部 provider，回退 UI 只能用 `translate()` 等模块级能力，不能依赖 i18n/query/auth context。`ErrorBoundary` 只覆盖渲染阶段错误，事件处理器、异步回调与 observer 错误不会进入任何兜底。
- 桌面导航沿用 `lib/desktop-titlebar.tsx` 的 provider、`useDesktopNavigate` 和 search 保留逻辑；macOS traffic lights、Windows window controls overlay 与普通浏览器的 header 留白不同。

## 状态与缓存

TanStack Query 管理 REST 可重建状态；Zustand 管理客户端状态和高频日志，如 `session-log-store`、`git-visibility-store`、`agent-store`、`ui-store`。多数 key 在 `hooks/query-keys.ts`，TeamRun、MemberPreset、TeamTemplate key 与 `hooks/use-team-run.ts` 共置；扩展相应领域 key，不借局部修改统一全仓库。

- 看板统一通过 `useTaskBoard` 请求 `/api/task-board`，All Projects 也是一次 board 请求，避免按 project 创建 `useQueries` fan-out。Task 正文用 `useTaskBody` 按需读取；RoomMessage 列表与全文详情分离。
- Task mutation、`task:*` 和 TeamRun invalidation 要覆盖 board 与旧 task list cache。沿用 `hooks/use-tasks.ts` 的 query predicate、remove/rollback helper，处理过滤后的列表、总数和 detail/body cache；board item 只用 `projectId` 关联项目元数据。
- TeamRun 消息提交成功后按稳定 message id upsert messages、run detail、task-run cache。`components/team/RoomTimeline.tsx` 的 pending 消息保留发送失败状态和草稿/附件恢复；不要把乐观消息的临时 id 当作后端身份。

## 实时同步与 Runtime UI

App 管理单例 `lib/socket/manager.ts` 的连接生命周期；hook 可调用 `connect()` 取得同一个连接。`GlobalRealtimeSync` 集中挂载 Task、TeamRun、Workspace Git 同步。沿用 shared 事件常量，按 payload 的实体 id 过滤，cleanup 使用同一 handler；修改房间订阅时核对 server gateway，不能凭旧注释推断广播范围。

- 每条 Socket 状态链都需要重连补偿。TeamRun 依据 invalidation scopes 定向失效；Git changed 是重查提示，不能从通知推演业务状态。
- `useWorkspaceSetupProgress` 从 `/tasks/:taskId/setup-progress` 恢复进度，并按 workspace 和服务端 `updatedAt` 合并实时事件；快照请求期间的新事件不能被旧响应覆盖。`TaskStartProgress` 分别消费启动状态、配置的 setupScript 和执行进度，卡片与日志独立渲染；Setup 的有界 stdout/stderr 只在用户点击“查看 Setup 输出”后展示，不能用 Agent 启动完成替代 Setup 完成。
- Git 查询受 `git-visibility-store` 与 `lib/git-refresh-policy.ts` 控制。可见 workspace 的当前 tab 才立即重查/轮询，其余只标 stale；重连先标记所有 Git cache，再刷新当前上下文，避免每个 workspace 同时重查。
- `useNormalizedLogs` 将 `session:patch` 写入 session log store，绕过 Query cache。恢复链保留 snapshot 加载期间缓冲、seq 去重与缺口检测、connection epoch、旧请求取消、瞬时失败重试和后台恢复；缓存可先展示，但不等同于当前连接已同步。修改时联查 server MsgStore、store 与 reconnect tests。
- Runtime UI 的入口是 `hooks/use-sessions.ts` 中的 `useRuntimeState`/`useSessionActivity`。持久化 Session status 与 runtime turn state 是两层状态；活动判断包含 `PENDING`/`RUNNING` 和 `RUNNING`/`AWAITING_PERMISSION`/`CANCELLING`，不能只凭 Session 是否完成决定停止按钮或输入状态。
- Runtime permissions 使用后端给出的 request/option id；runtime state 事件可更新 cache，permission 事件与重连触发权威重查。停止成功或失败都刷新 session detail/runtime、workspaces、tasks；失败不能让 UI 永久卡在 cancelling。
- 任务中已运行和已完成的 Session 共用 `useSendMessage`；独立对话在 `pages/ConversationPage.tsx` 使用 `hooks/use-conversations.ts` 的 `useSendConversationMessage`。HTTP 返回表示消息接受/入队，不表示 Agent 回合完成。修改任务的发送/停止互斥和失败恢复时，同时检查 `components/task/TaskDetail.tsx` 与 `components/mobile/MobileTaskDetail.tsx`，避免覆盖用户在等待期间新写的草稿；独立对话另核对其持久队列语义。

## Provider 与 Agent 环境

- `hooks/use-providers.ts` 读取 `RedactedProvider` 与 capability matrix；编辑使用 `ProviderDraftInput` 和 `components/provider/provider-draft.ts`。密钥使用 `keep`/`replace`/`clear` 写入意图，不要把脱敏占位符当成真实密钥回写。
- 简化字段与高级 config/settings 共享同一草稿；冲突处理、TOML 保留编辑和草稿测试序列使用现有 helper。测试结果只对当前草稿有效，测试请求不应隐式保存 Provider。
- Agent 环境安装沿用 `hooks/use-agent-cli-environment.ts` 的 manifest/status -> install preview -> preview id 创建 task -> task/logs 查询流程。UI 消费后端返回的安装计划和能力，不在前端拼任意 shell 命令或从界面文字推断是否可安装。

## Workspace、服务与 Preview

- 使用后端 `workingDir`、`workspaceKind` 和项目 Git capability；`MAIN_DIRECTORY` 或非 Git 项目隐藏不成立的 Git 操作。TeamRun 可以同时有 main/shared 与 dedicated member workspace，不能假设 task 只有一个 workspace。
- `hooks/use-workspace-services.ts` 与 `components/workspace/WorkspaceBackgroundServices.tsx` 查询后台服务和日志；日志游标由 `runtimeInstanceId`、`afterSeq`/`nextSeq` 组成，runtime 换代或 `reset` 时替换缓存，按 seq 去重并保留 bounded buffer/truncated 提示。不能把同名服务不同运行世代的日志拼接。
- `usePreviewStatus` 查询 target readiness；`usePreviewSession` 为挂载面板申请独立 gateway URL、续租、卸载释放，并处理开启后才卸载的竞态和租约失效。HTTP 页面使用 Agent Tower 主机上的 gateway，HTTPS/tunnel 页面使用后端创建的独立 Quick Tunnel，不能回退到客户端 loopback。
- Preview iframe 跨 origin，工具栏通过受控 `postMessage` bridge 同步地址和历史；页面本身不能依赖 bridge。显示真实 target URL，同 endpoint 导航只换 gateway path，跨端口/协议时保存新 target 并等待新 session；新窗口使用带最新 bootstrap token 的 session URL。
- `lib/message-intent.ts`、`lib/message-resource.ts`、`lib/preview-navigation.ts` 统一消息资源语义。日志和 RoomTimeline 中的 loopback 链接导航到对应 workspace Preview；移动端切到 Workspace/Preview，普通外链保留原行为。
- 来源身份由 Session Log 的当前 Session，或 RoomMessage 的 `senderInvocationId -> invocation.workspaceId/sessionId` 决定；不要从显示文本猜权限、派活或资源路径。loopback 导航缺失来源时才回退当前 workspace。
- `codex-inline-vis` 打开 `/api/sessions/:id/visualizations/:file`，与 web target 复用 `PreviewPanel`，但不创建 loopback gateway，并禁用地址编辑/历史导航。`agent-download` 生成 `/api/sessions/:id/artifacts/download?path=...`，不能直接打开 workspace 文件路径。

## 组件与验证

沿用 `@/` alias、邻近无分号格式、`components/ui`、lucide-react 和领域组件。用户文案使用 `useI18n().t()`/`translate` 并维护 `lib/i18n/messages.ts`。桌面和移动端 detail 目前分别实现；共享交互优先复用现有组件（如 `EditableTaskTitle`），并检查两端调用。终端、Monaco、日志视图复用 virtualize/auto-fit/scroll helper，保持稳定容器尺寸。

会话日志（`components/agent/LogStream.tsx`）使用**单层扁平虚拟化**：turn、`已处理` 摘要、明细行被摊平成一维 row 列表，只挂载视口 + overscan 行，折叠的历史明细**根本不挂载**（不是隐藏）。因此：

- 调用方（`AgentSessionPanel`、`TaskDetail`、`MobileTaskDetail`）必须把 `useStickToBottom().scrollRef` 作为 `scrollElementRef` 传入；缺失时回退为向上查找可滚动祖先。
- `clientHeight === 0`（隐藏面板、happy-dom）会退化为非虚拟化全量渲染，避免空白，但真实浏览器的可见面板始终走虚拟化路径。
- 行高由 `measureElement` 动态测量，展开/折叠与流式 markdown 增长都会触发重测；滚动锚点行为只能在真实 Chrome 里验证，happy-dom 测不到。

DOM 测试按邻近文件使用 happy-dom；测试配置和构建顺序见 [SKILL.md](../SKILL.md)。按改动选择最窄测试：

```bash
pnpm exec vitest run packages/web/src/hooks/__tests__/use-tasks-cache.test.ts
pnpm exec vitest run packages/web/src/hooks/__tests__/use-runtime-state.test.tsx
pnpm exec vitest run packages/web/src/components/agent/__tests__/LogStream.test.tsx
pnpm exec vitest run packages/web/src/lib/socket/__tests__/useNormalizedLogs.reconnect.test.tsx
pnpm exec vitest run packages/web/src/hooks/__tests__/use-workspace-services.test.tsx
pnpm --filter web build
```

Provider 设置的入口是 `pnpm test:provider-settings`，它组合 happy-dom 行为测试和独立 Chromium 布局 fixture（390/1440 宽）；需要可执行 Chrome，可用 `CHROME_PATH` 指定。这不等于真实后端 E2E，其他交互也不能以 happy-dom 通过替代桌面/移动浏览器验证。
