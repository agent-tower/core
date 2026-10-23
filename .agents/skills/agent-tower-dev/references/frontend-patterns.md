# 前端开发模式

下列路径相对 `packages/web/src/`，配置和测试命令从仓库根目录执行。

## 入口、访问与路由

- `App.tsx` 先挂载 Query provider 和 `components/access/AccessGate.tsx`，访问认证通过后才挂载 Socket、全局同步和路由。新入口不要绕过此顺序。
- `lib/api-client.ts` 统一处理 API base URL、same-origin credentials、204 和携带后端 details 的 `ApiError`。`lib/api-base-url.ts` 在开发环境把 loopback API/Socket 配置转回同源代理；`packages/web/vite.config.ts` 代理 `/api`、`/socket.io`、`/view` 并重写 HTTP/WS Origin。开发端口来自 shared `getDevPort(repoRoot)`，不能假设后端恒为 12580。
- 浏览器生成提交及乐观消息 UUID 使用 `lib/uuid.ts:createUuid()`，兼容 HTTP 远程访问下缺少 `crypto.randomUUID` 的环境；回退仍使用 `crypto.getRandomValues`。请求重试复用已保存的 UUID 和正文，不重新分配提交身份。
- 活跃路由表在 `routes/app-routes.tsx`：首页是 `ProjectKanbanPage`，另有 conversations 和演示页。`routes/index.tsx` 只负责 `createBrowserRouter(appRoutes)` 并导出 `AppRouter`；路由表单独成模块，测试才能用 `createMemoryRouter(appRoutes, ...)` 挂载生产层级。Settings 是 `SettingsDialog` 加 `ui-store`，旧 `/settings/:tab` 由 `routes/SettingsRedirect.tsx` 打开 dialog 后跳回首页；新增 tab 同步类型、dialog 与 redirect mapping。不要仅因存在 `HomePage`/`SettingsLayout` 文件就将其视为当前入口。
- `ProjectKanbanPage` 在选中任务后才动态导入当前布局的 `TaskDetail` 或 `MobileTaskDetail`；详情区自己的 Suspense 保留桌面任务列表。首页的 `TaskList`、`CreateTaskInput` 所用 `AgentLogo` 从具体文件导入，避免聚合出口把 Markdown、终端和 workspace 依赖带回首屏。验证时同时检查生产构建的实际加载资源；仅不挂载组件不能证明其模块未加载。
- 渲染兜底按层级分工，改动时不要破坏依赖方向：路由 `errorElement` 用 `components/errors/RouteErrorPage.tsx`（pathless 分组保留 `RootLayout` 外壳，根路由兜 `RootLayout` 自身）；`AppRootBoundary` 兜路由外渲染错误（回退 UI 用 `useI18n`，必须在 `I18nProvider` 之内）；`AppShellBoundary` 高于全部 provider，回退 UI 只能用 `translate()` 等模块级能力，不能依赖 i18n/query/auth context。`ErrorBoundary` 只覆盖渲染阶段错误，事件处理器、异步回调与 observer 错误不会进入任何兜底。
- 桌面导航沿用 `lib/desktop-titlebar.tsx` 的 provider、`useDesktopNavigate` 和 search 保留逻辑；macOS traffic lights、Windows window controls overlay 与普通浏览器的 header 留白不同。

## 状态与缓存

TanStack Query 管理 REST 可重建状态；Zustand 管理客户端状态和高频日志，如 `session-log-store`、`git-visibility-store`、`agent-store`、`ui-store`。多数 key 在 `hooks/query-keys.ts`，TeamRun、MemberPreset、TeamTemplate key 与 `hooks/use-team-run.ts` 共置；扩展相应领域 key，不借局部修改统一全仓库。

- 看板统一通过 `useTaskBoard` 请求 `/api/task-board`，All Projects 也是一次 board 请求，避免按 project 创建 `useQueries` fan-out。Task 正文用 `useTaskBody` 按需读取；RoomMessage 列表与全文详情分离。
- Task mutation、`task:*` 和 TeamRun invalidation 要覆盖 board 与旧 task list cache。沿用 `hooks/use-tasks.ts` 的 query predicate、remove/rollback helper，处理过滤后的列表、总数和 detail/body cache；board item 只用 `projectId` 关联项目元数据。
- TeamRun 用户提交202先缓存稳定operation，不能当RoomMessage upsert；实际发布后按稳定message id合并messages、run detail和task-run cache。`RoomTimeline` 乐观项与后续输入框草稿/附件隔离；未知受理在sessionStorage保存精确body/UUID，重试复用，损坏记录发送前拒绝，不能把旧附件恢复进新草稿或用新UUID盲发。
- `TeamRoomDeliveryStatus` 用TEAM_TASK范围有界分页恢复待发操作，共享输入另按50条分页、按需全文，动作使用actionId/expectedRevision。202受理、输入ACCEPTED、房间SENT和成员运行是不同状态；owner主消息显示原文，actualSentText对照来自冻结发布事实。ID/revision通知只失效缓存，刷新/重连走REST。

## 实时同步与 Runtime UI

App 管理单例 `lib/socket/manager.ts` 的连接生命周期；hook 可调用 `connect()` 取得同一个连接。`GlobalRealtimeSync` 集中挂载 Task、TeamRun、Workspace Git 同步。沿用 shared 事件常量，按 payload 的实体 id 过滤，cleanup 使用同一 handler；修改房间订阅时核对 server gateway，不能凭旧注释推断广播范围。

- 每条 Socket 状态链都需要重连补偿。TeamRun 依据 invalidation scopes 定向失效；Git changed 是重查提示，不能从通知推演业务状态。
- `useWorkspaceSetupProgress` 从 `/tasks/:taskId/setup-progress` 恢复进度，并按 workspace 和服务端 `updatedAt` 合并实时事件；快照请求期间的新事件不能被旧响应覆盖。`TaskStartProgress` 分别消费启动状态、配置的 setupScript 和执行进度，卡片与日志独立渲染；Setup 的有界 stdout/stderr 只在用户点击“查看 Setup 输出”后展示，不能用 Agent 启动完成替代 Setup 完成。
- Git 查询受 `git-visibility-store` 与 `lib/git-refresh-policy.ts` 控制。可见 workspace 的当前 tab 才立即重查/轮询，其余只标 stale；重连先标记所有 Git cache，再刷新当前上下文，避免每个 workspace 同时重查。
- `useNormalizedLogs` 将 `session:patch` 写入 session log store，绕过 Query cache。恢复链保留 snapshot 加载期间缓冲、seq 去重与缺口检测、connection epoch、旧请求取消、瞬时失败重试和后台恢复；缓存可先展示，但不等同于当前连接已同步。修改时联查 server MsgStore、store 与 reconnect tests。
- Runtime UI 的入口是 `hooks/use-sessions.ts` 中的 `useRuntimeState`/`useSessionActivity`。持久化 Session status 与 runtime turn state 是两层状态；活动判断包含 `PENDING`/`RUNNING` 和 `RUNNING`/`AWAITING_PERMISSION`/`CANCELLING`，不能只凭 Session 是否完成决定停止按钮或输入状态。
- Runtime permissions 使用后端给出的 request/option id；runtime state 事件可更新 cache，permission 事件与重连触发权威重查。停止成功或失败都刷新 session detail/runtime、workspaces、tasks；失败不能让 UI 永久卡在 cancelling。
- 任务中已运行和已完成的 Session 共用 `useSendMessage`；独立对话在 `pages/ConversationPage.tsx` 使用 `hooks/use-conversations.ts` 的 `useSendConversationMessage`。HTTP 返回表示消息接受/入队，不表示 Agent 回合完成。修改任务的发送/停止互斥和失败恢复时，同时检查 `components/task/TaskDetail.tsx` 与 `components/mobile/MobileTaskDetail.tsx`，避免覆盖用户在等待期间新写的草稿；独立对话另核对其持久队列语义。
- 独立对话停止按钮由 AgentSessionPanel 的 runtime activity 决定可见性；父页面不再以可能落后的 Conversation status 阻止调用幂等 stop 入口。stop 成功/失败均重查 Conversation、Session detail/runtime，保证无 Socket 通知时也可恢复审批卡片状态。

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

沿用 `@/` alias、邻近无分号格式、lucide-react 和领域组件。新增业务控件优先从 `@/design-system` 统一出口组合，遵循 `design-system/README.md` 的令牌与浮层规则；现有 `components/ui` 仍有调用，不能将原生控件或旧封装误认为设计系统组件。用户文案使用 `useI18n().t()`/`translate` 并维护 `lib/i18n/messages.ts`。桌面和移动端 detail 目前分别实现；共享交互优先复用现有组件（如 `EditableTaskTitle`），并检查两端调用。终端、Monaco、日志视图复用 virtualize/auto-fit/scroll helper，保持稳定容器尺寸。

任务行渐变由 `components/task/TaskGradientText.tsx` 保留 DOM 文字并绘制可见 Canvas；`task-text-visibility.ts` 共用 IntersectionObserver，离屏或页面隐藏时卸载画布并清理动画。不要重新加入整列表的 `background-clip:text` 渐变；绘制失败时保留普通文字，减少动态效果、选中和阅读状态停止扫光。`TaskList` 的移动 ghost 通过 HTML 快照复制，必须清除画布就绪标记并回退到 DOM 文字，不能依赖 HTML 复制 Canvas 像素。浏览器验证 fixture 为 `components/task/__tests__/task-gradient.fixture.html`。

会话日志（`components/agent/LogStream.tsx`）使用**单层扁平虚拟化**：turn、`已处理` 摘要、明细行被摊平成一维 row 列表，只挂载视口 + overscan 行，折叠的历史明细**根本不挂载**（不是隐藏）。因此：

- 调用方（`AgentSessionPanel`、`TaskDetail`、`MobileTaskDetail`）必须把 `useStickToBottom().scrollRef` 作为 `scrollElementRef` 传入；缺失时回退为向上查找可滚动祖先。
- `clientHeight === 0`（隐藏面板、happy-dom）会退化为非虚拟化全量渲染，避免空白，但真实浏览器的可见面板始终走虚拟化路径。
- 行高由 `measureElement` 动态测量，展开/折叠与流式 markdown 增长都会触发重测；滚动锚点行为只能在真实 Chrome 里验证，happy-dom 测不到。

DOM 测试按邻近文件使用 happy-dom；测试配置和构建顺序见 [SKILL.md](../SKILL.md)。按改动选择最窄测试：

团队房间的 `RoomTimeline` 将历史消息和翻译查询放在 memo 化的 `RoomMessageList` 内；输入、提及和附件草稿更新不得跨过此边界。`VirtualRoomMessageList` 独立处理滚动及测量，只挂载视口和 overscan 行，首屏不能先全量挂载；不可测量的隐藏面板只保留有界尾部，恢复可见后重新测量。消息及审批使用稳定实体 key，原文展开状态保留在房间层；虚拟行用 `top` 定位，避免 `transform` 限制 Mermaid 全屏浮层。跳到底部和尺寸修正使用即时滚动，新消息跟随仍尊重阅读位置。浏览器 fixture 为 `components/team/__tests__/room-timeline.fixture.html`（`count` / `compact` 参数），它使用真实房间与 Markdown、隔离 transport；DOM 测试不能代替真实浏览器的动态高度、滚动锚点和输入延迟验证。

```bash
pnpm exec vitest run packages/web/src/hooks/__tests__/use-tasks-cache.test.ts
pnpm exec vitest run packages/web/src/pages/__tests__/ProjectKanbanPage.lazy-detail.test.tsx
pnpm exec vitest run packages/web/src/components/task/__tests__/task-text-visibility.test.ts packages/web/src/components/task/__tests__/task-text-fit.test.ts
pnpm exec vitest run packages/web/src/hooks/__tests__/use-runtime-state.test.tsx
pnpm exec vitest run packages/web/src/components/agent/__tests__/LogStream.test.tsx
pnpm exec vitest run packages/web/src/components/team/__tests__ packages/web/src/hooks/__tests__/use-team-run-translations.test.tsx
pnpm exec vitest run packages/web/src/lib/socket/__tests__/useNormalizedLogs.reconnect.test.tsx
pnpm exec vitest run packages/web/src/hooks/__tests__/use-workspace-services.test.tsx
pnpm --filter web build
```

Provider 设置的入口是 `pnpm test:provider-settings`，它组合 happy-dom 行为测试和独立 Chromium 布局 fixture（390/1440 宽）；需要可执行 Chrome，可用 `CHROME_PATH` 指定。这不等于真实后端 E2E，其他交互也不能以 happy-dom 通过替代桌面/移动浏览器验证。

## Provider 执行权限

CLI/ACP 共用 ExecutionPermissionSelector，固定三项并消费服务端 options，禁用原因有独立可聚焦说明；失效已选值保留且禁止保存/启动，不自动改档。编辑页使用 POST `/providers/capabilities` 提交当前 config 草稿（空对象明确替换已存 config），普通读取保留 GET；响应只含能力矩阵，不返回 Provider 的凭据或内部配置。Provider capability cache 区分 Agent、模型、Provider、Runtime 和草稿 config，router/cmd/args 改变隔离查询；账号/策略接入后也须失效该缓存。保存与启动仍由服务端复核。启动选择器消费 Provider 权限诊断与 options。RuntimePermissionPrompt 仅展示待处理的运行时审批请求，无请求时不占布局空间；权限修改只在新进程/transport 生效。

## 用户输入翻译的最小 UI

`hooks/user-submission.ts` 按提交快照保留 UUID，失败/响应丢失复用，成功后才释放；`task-start-submission.ts` 额外保留 workspace/session 创建身份和 workspaceKind。输入正文和 attachmentIds 分开，失败使用附件快照合并恢复，不能覆盖 await 期间的新草稿。创建首条 Conversation 失败必须向 CreateTaskInput 抛错。

浏览器 start/send/create Conversation 返回 MessageDeliverySubmission（202），不是发送成功或 Conversation DTO。hooks 立即缓存 operation，Conversation 通过 destinationId 恢复真实实体；`delivery-cache.ts` 按 ID/revision 合并 action 与 REST，旧响应不能回退状态。`use-message-deliveries.ts` 依靠分页 REST、轮询和独立 Socket/reconnect invalidation 恢复。pending 默认独立过滤，不能被100条历史 SENT 遮住。

`LogStream` 在消息列表合并 MessageDelivery 与正式日志，以 deliveryId 去重；没有日志的首发也必须挂载列表。`MessageDeliveryFeedback` 的状态/重试/实际发送对照属于对应用户气泡下方的外部区域；气泡仅承载正文和附件，身份/时间保留原有消息标题排版，不能挂在 composer。`outgoing-submissions.ts` 在 HTTP 前使用 userSubmission 的同一 UUID 显示不可变本地快照，受理后交权服务端记录；REST 认可 UUID 后清理本地未知记录与旧提交身份。失败不把旧正文/附件回填新草稿。

翻译设置入口是 `TranslationSettingsPage`（SettingsDialog 桌面/移动共用 navigation，`/settings/translation` redirect）。`use-translation-settings.ts` 仅缓存公开字段；携带 apiKey 写入意图的保存和草稿测试使用普通可取消请求，禁止使用会缓存 variables 的 useMutation，也不写浏览器存储或日志。keep/replace/clear 与显式 replace 空字符串的免凭据选择不同；keyConfigured=false 无法区分未配置与免凭据。409 保留本地草稿；测试序列随草稿、样例和方向修改失效，卸载取消。

`LogStream` 接收真实 `sessionId` 才启用独立 `use-session-translations` 读模型；任务两端传 displayedSessionId，独立对话由 AgentSessionPanel 传 sessionId。overlay 按 Session/turn/block、sourceRevision 和原文字节匹配，仅为 SEALED assistant 正文或已封口段落展示，不写原始日志或 Agent 状态。`getTranslationTextBlocks` 从原文及 textBlock.paragraphs 投影段落来源，已译段落与原文尾段合并为同一 Markdown；取消尾段不撤已封口段落。译文 Query 以 Session 为唯一缓存键，不放正文或日志子集；重挂立即展示匹配缓存，后台 REST 校验，瞬时失败保留缓存、401/403/404 或订阅拒绝撤缓存。REST 按 Session 读取完整有界游标页（每页≤100），可选 blockIds 过滤仍每批≤100，空 items 仍跟随 nextCursor，完整快照缺项撤旧；Socket 通知只失效，引用计数共享 session room，重连补订阅并 REST 补读。成功历史不按当前启用状态或目标语言过滤；单块重试传 sourceRevision。`TranslationComparison` 提供右下图标触发的可交互长文浮层；正文显示译文时浮层只保留原文及其复制动作，不重复正文译文；不能以 pointer-events-none Tooltip 替代。`translation-reveals.ts` 在 session/room 视图内识别初始 transcript、新增/流式来源和已观察的未完成译文，独立于 Query key 与虚拟行保存并消费一次完成事件；历史异步恢复、缺项后恢复、回退原文和重挂不重播。`TranslationReveal` 仅对取得事件资格的展示版本做短动画，尊重 prefers-reduced-motion；RoomTimeline 仅保留外层动画容器。新建 Conversation 每次显式“新对话”推进视图代际，旧请求仅可导航原视图；输入实例按代际隔离。语言 Popover 使用 useScrollLock 纳入 SettingsDialog 浮层计数，并消费本层 Escape、恢复触发器焦点。语言目录由 IANA primary language subtags 与 CLDR 地区变体生成，搜索控件保留旧自定义值；更新入口为 scripts/update-translation-languages.mjs。

`RoomTimeline` 桌面/移动共用 `use-team-run-translations`，仅查询已确认的 PUBLIC Agent ID，每批≤100，安装完整权威快照，独立 query keys/失效事件、共享引用计数订阅、重连补读。原消息240字 preview不能与overlay2000字 preview比较；两种全文按各自截断标记加载，展开不得落回原文 loader。全文共享请求独立于首个消费者，返回后各调用方再验 scope/身份代际/版本；候选失效或身份变化立即隐藏，最后合法消费者清理对应全文请求和缓存。单项detail/retry404同步推进共享单消息代际、撤所有消费者的该项及动作、取消清理该项全文，再取消旧summary并REST补读；summary快照/异步动作保留接受代际，旧操作在同版本重新授权后仍失效，其它项保持可读。房间401/403/summary404撤整个scope。原文与译文复制使用完整原始字符串（包含尾换行和资源指令），资源继续沿 producing invocation→workspace/session；重试传sourceRevision、仅显式单次POST。通知可以多余/乱序，只合并失效，REST为权威。

系统冲突操作的提交 UUID 按 actor/operationId/原context及接收Session保持稳定，签名/期限不参与身份。`user-submission.ts` 用单个 sessionStorage JSON 保存 UUID、原body和目的地，结果未知先原请求核对，明确 accepted:false 后才同UUID换凭据；恢复中锁定原接收Session。普通git-status横幅同样从原token的白名单context补齐源/目标资料，并优先恢复同actor、同源workspace的未知原请求；即使展示资料已清理，也从原子pending body找回，不能凭新观察的operationId生成新UUID。提交层再次拒绝绕过同源未知请求的新operation或Session。token解析只用于本地索引/展示，不构成授权。保留旧 token 参与 key 的 pending 迁移，损坏/不可读的未知提交不能生成替代UUID。

`api-client.ts` 在 MERGE_CONFLICT 409 抛给桌面/移动组件前，同步将原证明、操作资料和稳定意图保存到 `conflict-recovery-storage.ts`；独立于首次发送。`useConflictRecovery` 在桌面/移动父组件统一管理身份核验和弹窗资料，`ConflictRecoveryNotice` 仅展示该状态。owner-only/no-store `GET /conflict-recovery-identity` 必须本次查询成功且未在刷新时才可展示资料；旧data上的refetch错误、登录/退出中或actor变化均清空并卸载弹窗，异步换签在卸载后不得回填。登录/退出取消旧identity请求并reset缓存，queryFn消费AbortSignal，迟到的旧响应不能覆盖新身份。在 source git-status=idle 时仍有重开入口，恢复时选回源workspace。关闭/IDE只关闭弹窗；受理成功仅清理匹配operation的资料，或用户明确清理。过期资料保留供人工检查，不自动丢弃未知提交；同标签页刷新可恢复，关闭标签页/清理浏览器数据会删除，存储禁用/损坏需显式提示。登录/退出清除当前身份缓存，资料不跨browser凭据继承。

ResolveConflictsDialog 有原 token 时通过 source workspace 的 `POST /conflict-context` 只读核验，原目标和接收范围由服务端证明决定；恢复、刷新及重开均不写Git、不自动发送。现场变化（包括部分stage）会保守拒绝，界面须展示实际目标目录并说明保留成果、手工继续，或明确abort/重做；项目目标无workspace映射时不把源IDE冒充实际目标。历史无证明且失效签名不能补回跨目录授权；不要承诺全部冲突均可AI恢复。

TEAM_INITIAL 创建响应为201 TeamRun或202 MessageDeliverySubmission；202只缓存操作，plannedTeamRunId不能成为team query或导航ID。`team-initial-submission.ts`按task在sessionStorage保留精确body/UUID，未知响应重试不得重建意图、覆盖新草稿或附件。桌面/手机未建队详情以TEAM_TASK有界REST恢复pending；task room只供owner ID/revision失效，`lib/socket/task-subscription.ts`让TaskDetail与状态组件共用引用计数订阅，重连重订阅。SENT后REST失效真实task-team query。
