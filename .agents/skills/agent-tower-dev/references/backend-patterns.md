# 后端开发模式

本页覆盖 HTTP、持久化、读模型、事件和 MCP。Git workspace、后台进程及安全边界见 [workspace-security-patterns.md](workspace-security-patterns.md)；执行生命周期见 [pipeline-patterns.md](pipeline-patterns.md)。路径相对仓库根目录，以下 server 路径省略 `packages/server/src/`。

## 启动与资源所有权

- `cli.ts` 是发布 CLI；`index.ts` 是源码开发/直接服务入口。二者先设置 data dir、数据库 URL、端口等环境，再加载应用。`utils/index.ts` 在模块加载时创建 Prisma 单例，不能把环境初始化移到它之后。
- `app.ts:buildApp()` 是组合根：先配置 SQLite 并执行启动数据迁移，再注册插件、认证 hook、routes；`onReady` 启动 Socket、后台服务恢复、休眠/心跳/任务清理和独立对话队列。
- 为新 timer、watcher、worker 或 listener 添加成对的启动和关闭路径，包括延迟首次执行的 timer。`app.ts` 的 `preClose` 停止调度、启动进程清理并关闭升级的 WebSocket/Socket.IO 连接；否则 Fastify 可能在进入 `onClose` 前等待连接而挂住。`onClose` 等待进程清理结果，`socket/index.ts:closeSocket()` 只负责网络与 gateway。
- `core/container.ts:destroyApplicationProcesses()` 关闭启动入口并尝试所有进程 owner，失败由 `server-entry-shutdown.ts` 重试；网络 close 只发起一次，并行清理进程，避免 HTTP/onReady 等待子进程导致死锁。route 局部 preview 与通用 child 通过 `application-process-cleanup.ts` 注册，成功后才注销。CLI/index 在启动早期保存 SIGINT/SIGTERM、私有 IPC shutdown 和 parent disconnect 请求；启动失败确认清理后显式退出，不能仅设 exitCode 而被 IPC listener 留住。
- `core/container.ts` 持有共享生命周期服务；普通 CRUD Service 通常由 Route 实例化。`getTerminalManager()` 延迟加载原生 node-pty，并发请求共享初始化 promise；关闭需处理尚未完成的初始化，关闭后不得创建新 manager。

## Route 与 Service

常规 CRUD 看 `routes/tasks.ts` / `services/task.service.ts`；编排看 `routes/team-runs.ts`；进程控制看 `routes/sessions.ts`；特殊协议边界看 `routes/files.ts` / `previews.ts`。

1. 用 Zod 校验不可信输入，multipart、proxy 等 Route 沿用邻近模式。
2. Service 负责状态约束、事务和副作用补偿；Route 决定 status 和 error payload。`errors.ts:ServiceError` 可表达业务失败，但已有错误响应尚未全局统一，不能只改调用方假定统一 envelope。
3. 在 `routes/index.ts` 核对注册 prefix；许多 Route 自带 `/workspaces`、`/sessions` 等路径，仅注册在 `/api` 下。`previewRoutes` 同时注册 `/api/previews` 和兼容 `/view`，不能机械套 prefix。
4. 修改可被 Agent 调用的接口时，同时查 `mcp/http-client.ts`、对应工具和权限来源；修改可见数据时查 web query key 和实时失效入口。

## 数据库与迁移

- schema 位于 `packages/server/prisma/schema.prisma`。UUID string 主键、String 业务状态和 JSON string 字段沿用现有模型；共享状态类型在 `packages/shared/src/types.ts`。JSON 在 Service mapper 中序列化并兼容旧值，DTO 不直接扩散 Prisma row。
- `utils/index.ts:initializeDatabaseRuntime()` 在接收请求前先设置 busy timeout 再启用 WAL；并发 CLI 的 WAL 切换只对 SQLite 锁错误做有界重试，永久错误原样失败。队列扫描、软删除及关系查询需要相应 index；跨实体状态变更放事务，事务后的进程/文件动作保留失败、重试或补偿路径。
- 修改 schema 后生成 Prisma Client，并提供仓库约定的 migration SQL。但发布 CLI 和开发 `index.ts` 实际使用 `prisma db push --skip-generate` 同步结构，不会执行 migration SQL 中的数据转换。
- 两入口在导入应用前共用 `utils/database-schema.ts:synchronizeDatabaseSchema()`：显式 dbPath 的短生命周期 Prisma client 在短事务中检查并补 P3 创建幂等列与 RoomMessage.deliveryId 的 nullable TEXT/BINARY UNIQUE 列/索引，断开后运行原 bundled Prisma + `preparePrismaCliEnv`，最后核对 P3 结构、关联及全库 FK/integrity。缺表交 db push，异构索引/列、重复非空值及孤儿均阻止维护和 worker 恢复；只对 BUSY/已知同步竞争做最多三次重读重试，不接受数据丢失。完整 integrity 扫描在短事务外，不能把整份 P3 SQL 放入事务（其中 foreign_keys=OFF 无效，DROP Source 可级联删除 Attempt）。Team 用户投递基础增加 nullable Session / Task / Team / snapshot 引用；prepare 接受旧 sessionId NOT NULL，push 重建后 verify 要求 nullable，预检新列/索引与跨实体事实，旧引用不回填。房间 receipt 为数据库发布事实，启动核对完整 RoomMessage/全部 WR/snapshot/SENT 后才允许恢复。异常不盲补造；这不是通用历史 schema 修复框架。
- 需要回填历史数据时，另更新 `services/database-maintenance.service.ts:runStartupDataMigrations()`：通过 `AppSettings.dataMigrationVersion` 幂等执行，在同一事务最后推进版本。不能仅靠 migration SQL，也不要在启动迁移中强行重写所有历史记录。
- 旧运行时的 ownership / launch evidence 不完整时采取保守恢复；缺少 `ExecutionProcess` 行不能证明进程从未启动或已经退出。相关清理语义见 runtime reference。

## 翻译、展示与用户投递

- `services/message-delivery.service.ts` 持有 owner 输入的 clientSubmissionId/fingerprint、通道 sequence、revision/actionId CAS 和唯一 DeliveryReceipt；普通 browser（含密码关闭）提交返回 202，必须复用 owner/同源校验。`routes/user-input-origin.ts` 依据真实身份区分 browser、Agent 和 internal；普通 Agent MCP 不二次翻译，internal 的显式用户输入须带 `x-agent-tower-input-origin: user`。
- 任务待启动 Session 与 Workspace 各有持久 creationSubmissionId/fingerprint；创建重试先查重，不能先分配新目的身份。Workspace 初始化在事务外，相同提交共享短期 Promise，重启遇到未初始化记录返回需核对，不冒充已就绪。实际 `/start` 才创建初始 delivery；Task 字段不回写译文，旧任务的精确附件 Markdown 仅按本地附件记录拆分。
- MessageDelivery 未决受理容量在目的实体创建的同一事务内检查，只有 SENT/CANCELLED 释放；已有 UUID 先幂等核对，拒绝返回429 accepted:false，不遗留 Conversation/Session。
- `conflict-resolution-context.ts` 只处理服务端观察到的冲突资料；Git 409/只读现态签发后由 Route 绑定现有 owner/browser/internal 身份。Session 的 systemAction 仅 owner 可用，先当前授权及已有 UUID 恢复，再对新提交验签、核验活跃实体/路径归属及源或目标 workspace 的接收 Session，冻结完整指令；任意客户端正文/附件不作为指令。数据需 JSON 转义、命令参数需 shell 引用；不得因验签失败转为普通用户输入。未受理且已 abort 的资料在进程密钥失效后需用户明确重做原 Git 操作，刷新/重签本身仅读取现存冲突；不承诺跨重启恢复未受理的历史 abort 资料。
- `MessageDeliveryService` 的冲突 PREPARE 失败出口再次按当前目的/意图校验读取原 UUID；冻结记录优先于已失效的现场、key、期限或内部取消。同 UUID 重叠 callback 在首次 await 前登记，成员加入、成功返回事务及退组推进组代际；恢复读取返回 null 期间代际变化时，按当前目的/意图最多再读一次，仍变化则保持未知，不能用兄弟退组后的 active.size 配合旧 null 宣称未受理。写入前失败时仍存在其他在途 callback 或该组先前写入结果未知，同样返回 `CONFLICT_ADMISSION_UNCERTAIN`（不含 `accepted:false`），提示沿原 UUID 核对；稳定无记录且无兄弟/历史写入可能时保留明确拒绝。组保留到最后真实 callback/事务结算，无持久副本或新写入捷径。新建仍经过完整 FINAL，HTTP 断开不取消。
- 未中止的现存冲突使用独立 v2 恢复证明，固定 actor/operationId/context、keyId、issuedAt/绝对截止及现场。现场绑定实体/真实目录身份、Git index 与操作锚点的 inode/高精度 ctime 等代际、HEAD/stages、元数据及冲突工作文件内容/类型；两轮完整只读快照须一致，首次 messageDelivery.create 紧邻前以同一 capability 再验。legacy 缺 token 现态观察也须固定一次 capability，不能在终检独立观察另一个操作。仅支持能验证 POSIX 身份及高精度时间的稳定本地现场，Windows/粗时间/锁文件/异常类型拒绝；外部 Git 与 SQLite 没有跨系统原子锁。owner 的 `POST /workspaces/:sourceId/conflict-context` 只读换签；普通受理 token 最长24小时，原证明绝对7日截止，重复换签不延长，新受理不越界。旧 v1 恢复证明/无证明且签名失效仍拒绝；已受理 UUID 先恢复冻结记录且不初始化密钥。
- 冲突新受理由 MessageDeliveryService 的内部 ConflictAdmission 管理单调截止与取消：UUID只读预查优先，PREPARE在mutationTail外，准备owner并发2/等待8、最终票据1，超时闭包仍持票至实际消费。FINAL全量复验与同步create前门保留，专项事务局部maxWait≤1s/timeout≤4s且不自动重试；普通事务不继承。shutdown取消并等待受理callback，HTTP断开不触发取消。Git接收剩余timeout/AbortSignal，所有并行采样及命令整树清理结算后才释放容量；cleanup未确认则继续持有容量，沿既有进程owner等待确认。此接入仅本机POSIX路径，Windows observer/helper和35秒完整链预算仍待实现/验证。生产路径回归入口为 `node scripts/acceptance/conflict-platform/production-run.mjs --out=output/conflict-admission/basic`，跨进程现场恢复使用同一入口的 `--suite=route`；运行前提与边界见 `scripts/acceptance/conflict-platform/README.md`。
- 恢复密钥仅在 data dir 的 `conflict-recovery-key`（32字节、POSIX 0600、当前 UID），通过同目录0600临时文件完整写入/fsync后以无覆盖 hard link 原子发布，竞争者读取胜者；临时文件中断不成为正式密钥。检查目录/文件类型、权限、所有者、NOFOLLOW及读取前后身份，错误以 `CONFLICT_RECOVERY_KEY_UNAVAILABLE` 脱敏拒绝，不静默签发无证明 token。keyId同时绑定材料和发布 inode/birthtime，替换（含相同字节）撤销旧证明；data-dir迁移/恢复备份也可能撤销，已受理UUID不受影响。崩溃遗留0600临时文件须运维确认后清理，不保存历史Git上下文、不改Prisma。
- MessageDelivery 先翻译用户正文，再本地附加附件与 runtime 指令；失败/未知占住同一通道，只有 SENT/CANCELLED 放行。ACCEPTED 只表示已进入 ConversationTurn。关闭与 dispatch claim 通过事务竞争，旧 PAUSED 项重开不自动释放；翻译重试读当前配置，投递重试复用有效 acceptedText。SQLite 短 CAS 串行、扫描 keyset 轮转；HTTP/Driver 等待不持数据库或执行锁。
- `/message-deliveries` 提供 owner 范围分页（每页100，SESSION/CONVERSATION/TEAM_TASK；pending 过滤排除历史，sent 倒序），详情及 `/actions` 用 actionId + expectedRevision。未知仅允许明确核对未发后重试，或结束未知操作；普通取消/重试不允许。Socket 独立 ID/revision invalidation，不含正文。

- 共享契约在 `packages/shared/src/translation.ts`；Prisma 的 `TranslationSettings`、`TranslationSource`、`TranslationAttempt` 分别持有独立配置、来源版本和尝试结果。默认关闭；Session 展示、任务/独立对话投递、PUBLIC Agent 房间展示及现有团队 TEAM_USER 均已接入。TEAM_INITIAL 已接通持久受理与原子创建：无等待返回201真实 TeamRun，等待返回202目的 TEAM_ROOM_PENDING（无destinationId）；managed Agent不能冒充用户创建。Team USER_DELIVERY/TASK_INPUT 登记、恢复、关闭和容量都经过显式适配器，不能用 origin 注入任意来源。当前维护契约与验证入口见 `docs/conversation-language-translation.md`。
- `TeamTaskInputService` 负责 team/精确 Task hash 的共享输入与消费者屏障；只有实际投递/调度消费者登记，Task 编辑不触发翻译。owner 列表有界分页、全文按需、动作 CAS；Agent `get_team_task_input`/GET task-input 只取当前 credential 绑定 Invocation 的 ACCEPTED 快照，旧 NULL 返回409。普通 get_task/get_context 仍为元数据接口。TEAM_USER 202 受理固定路由与附件；SENT 是原子 RoomMessage/全部 WR/snapshot/receipt 发布，不等于成员运行。owner 消息原文投影不得进入 Agent 读模型。团队 Socket 分支按当前 Cookie、房间可读性和同一订阅意图复验，REST 为恢复权威。
- `services/translation-settings.service.ts` 不复用 Agent Provider。公开 mapper 只返回 `keyConfigured`，写入使用 `keep/replace/clear` 和 `expectedRevision` CAS；执行快照与脱敏 DTO 分离。每个正在执行的 attempt 固定配置；重新尝试读取当前配置，不能恢复旧 Key 快照。
- `routes/translations.ts` 在插件作用域复用 Fastify 默认安全 JSON parser，保留 body limit 和 poisoning 策略，但用全新安全错误替换解析失败，避免正文片段进入父级 `onError` 日志。仅在 handler 或局部 error handler 中脱敏来不及保护解析错误；不能把原错误作为 cause/stack 保留。
- `services/translation.service.ts` 负责持久来源身份、资格、活跃容量、attempt/lease、重试及结果 CAS。来源 scope/lane 从真实 Session/RoomMessage 关系派生；Session 仅允许 CHAT 的 `assistant_message` 正文，房间仅允许 PUBLIC Agent 正文，不能让任意字符串、thinking 或工具内容取得翻译资格。Session 原文检查点通过共享 getTranslationTextBlocks 投影段落来源；父块仍 OPEN 时已封口段落可独立翻译，尾段等待封口。段落 ID 从父块和位置序号派生，修订由 sourceRevision 与原文字节校验；父块仍在时消失的旧段落取消但不 tombstone，避免后续修订不能复用身份。列表一次索引原文块，避免逐条扫描全量日志。来源创建只对内部适配器开放；owner GET /sessions/:id/translations 提供 ≤100 条的游标页及 blockIds 过滤，POST /sessions/:id/translations/:sourceId/retry 只重试已有失败/取消来源。读取与重试核验 Session 归属、CHAT purpose、未删除/未归档；Agent credential 无权访问。独立 translation:invalidated 只送已订阅该 Session 且认证当前有效的 owner 浏览器，含 ID/revision、不含正文。REST 为恢复权威。
- 已登记 PUBLIC Agent 房间来源的 owner 读接口为 `GET /team-runs/:id/translations?messageIds=`（去重后≤100，只投影有界 preview）、`GET /team-runs/:id/messages/:messageId/translation`（单条全文）；`POST /team-runs/:id/translations/:sourceId/retry` 用 sourceRevision 的 expectedRevision CAS 重试已有合格失败/取消来源。每次核验房间/消息/来源绑定、PUBLIC Agent、Task/Project 有效性；GET 不登记或补翻历史，历史成功不因当前关闭或换语言消失。生产 `createRoomMessage` 在原消息＋WorkRequest 事务内读取数据库 settings，将启用 epoch（0有效）写入 nullable `RoomMessage.translationEligibilityEpoch`；缺设置/禁用及非 PUBLIC Agent 保持 NULL，不回填历史。提交后只投递有界 ID，唯一 TranslationService 首登/恢复从持久资格和全文取值；已有源（包括 tombstone/失败/QUEUE_FULL）不重置，旧 epoch 暂停，人工 retry 可采用当前 epoch。补偿先以固定上界、原候选游标取得至多64条资格候选，再批查缺源；失败继续、回卷、热队列与补偿公平有界。启动 schema 验证拒绝异构列/索引后才启动 worker。窄测入口：`packages/server/src/routes/__tests__/team-run-translations.test.ts`。
- `services/translation-queue.ts` 只管理请求句柄：全局额度、跨方向 lane 额度、SEND/DISPLAY 加权调度与类内 lane 轮转。逻辑来源容量和持久重试由 Service 管理；片段完成后重新参与队列，不能持有整块额度绕过公平性。取消立即通知调用方，但请求执行未退出前仍持有槽位；降低并发只限制新 admission。
- `services/translation-protection.ts` 在本地隔离代码、资源、路由/交付指令等片段并分段；返回后只拼接译文、还原已识别的占位符，未知占位符保留，不对返回正文、占位符数量/顺序或还原结构做规则校验。占位符保留由系统提示词约束，模板解析后只插值一次。`translation-client.ts` 只收到已保护的片段与翻译指令，负责 OpenAI 兼容 HTTP、截止时间、响应格式/空响应/截断及大小限制，不持有来源重试状态。未到响应 EOF 的所有退出路径必须取消并等待 body 清理，再释放句柄和额度；仅 release reader lock 不代表网络资源已清理。
- `app.ts:onReady` 在接流量前依次等待 TranslationService 和 MessageDeliveryService 恢复，再启动唯一 ConversationTurn pump；`core/container.ts:destroyApplicationProcesses()` 调用可等待的 `shutdown()`，停止 admission、请求、续租/补偿 timer 和配置 listener。重启中断尝试必须使用新版本及当前配置，旧 source/attempt/generation/enableEpoch 结果不可提交。

## Task 与 Project 读写模型

- 交接笔记只存 `Task.handoff`，shared DTO 在 `task-handoff.ts`。`TaskHandoffService` 通过 `GET/PATCH /tasks/:id/handoff` 和 MCP `get_task_handoff/update_task_handoff` 提供按需读取及 `oldString/newString` 精确替换；空 oldString 仅初始化空笔记，歧义/未命中拒绝，数据库按读到的原正文条件更新以检测并发写入。没有修订表或日志副本。普通 task mapper 不返回 handoff，变更复用 `task:updated` 失效通知。浏览器复用 owner/CSRF 检查（包括密码关闭），托管 Agent 必须绑定当前 Task，团队调用另外验证 invocation 与未移除成员。专项验证：`routes/__tests__/task-handoff.test.ts`。

- 看板走 `GET /api/task-board` 和 `TaskService.findBoard()` 的紧凑 DTO，批量读取 task、首选 workspace 与最新 session。完整 description 和历史通过详情/body 接口按需读取；列表 mapper 不加载完整关系或按 task/project 启动额外查询。
- `TaskService` 有不同的创建和更新归一化路径。创建时，超长单一 title 按完整 Unicode code point 边界派生展示 title 和剩余正文，正文保留原始空白并放在独立 description 前面；更新长标题则沿既有 `normalizeUpdateTaskInput()` 合并输入和原 description。不要把二者统一成新算法或顺带回写历史 RoomMessage。
- 原创建入口的 TeamRun 首条消息和 WorkRequest instruction 使用 `title + description`，保留正文实际内容，不按文本相似度猜测来源。新 scheduler 的 Task prompt 段来自 Invocation 固定共享输入，精确 hash 不 trim；普通 Task/会话创建沿已有正文组合规则。
- Task 的 `parentTaskId` 只建立同项目、一级子任务关系，不联动运行或状态；Service 创建事务重验父任务未删除，防止与整组删除竞争。REST `parentTaskId` / MCP `parent_task_id` 省略 `baseBranch` 时取父任务根工作区分支，不能误取 TeamRun 成员工作区。`findBoard()` 返回子任务数量和分页外 `parents` 上下文，分页统计只计算 `data`；`/tasks/:id/subtasks` 为按需分页的紧凑读模型。
- Task 普通读取和变更要考虑 `deletedAt` 与 Project `archivedAt`，复用 `services/deleted-task-guard.ts` / `project-guards.ts`。删除父任务会包含全部子任务：同一事务写入整组 `deletedAt`、`TaskCleanupJob` 快照和 TeamRun 取消状态，再由 `task-cleanup.service.ts` 停止 Session、回收 worktree/branch 并最终硬删除。快照 `taskIds` 为子任务在前、父任务在后，兼容旧快照只含 `taskId`；Session 补读覆盖整组。UI 删除携带 `expectedSubtaskCount`，数量变化返回 409；`GET /tasks/:id/cleanup` 与 `POST /tasks/:id/cleanup/retry` 提供可恢复的清理结果。仅数据库 cascade 不能完成资源回收。
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

Workspace Setup 的进度由容器共享的 `WorkspaceSetupProgressStore` 在事件发出前记录；`WorkspaceService.getSetupProgress()` 校验任务可见性并只返回仍为 ACTIVE 的 workspace 快照。快照是当前进程的执行状态，终态有保留期限，Setup stdout/stderr 以有界 `output` 字段随事件和快照返回，不写入 Prisma，也不宣称能跨服务重启恢复脚本。

`team-run:invalidated`、`workspace:git_changed` 是重新查询信号。断线后要重新读 authoritative REST state；日志还需处理 snapshot/patch seq，见前端 reference。Gateway 的认证状态会在消息和转发时复验，新增路径应沿用检查并释放 listener。

具体 Session 的公开 SUBSCRIBE/UNSUBSCRIBE 管理 `session:<id>` 房间及既有确认事件；订阅核验当前 owner 浏览器身份和 CHAT 来源可读性，拒绝 Agent/internal credential 及 `session:all`。异步鉴权后复验身份与订阅意图，防止退订或凭据轮换后迟到加入。独立翻译通知再次核验当前来源和身份；原 session 原文广播仍走既有 namespace 路径。

房间译文使用 `topic: 'team-run', id` 订阅具体 `team-run:<id>`，拒绝缺 ID、all、Agent/internal。独立 `translation:invalidated` 的房间分支只含 teamRunId/messageId/sourceId/sourceRevision/overlayRevision；Session 分支保持兼容。房间订阅及每次转发均重验 cookie 有效期和 secret generation、当前来源 scope，异步等待后复核订阅/身份，退订后不迟到加入或转发。不复用 team-run 消息业务事件或 session:patch；EventMap/container 复用同一共享 union 与桥接，REST 负责重连恢复。

房间鉴权通过 `AccessAuthService.prepareSessionTokenValidation()` 异步加载设置并取得同步校验函数；最后一次等待后、紧邻 emit/成功 ack 调用该函数，按当时墙钟重验签名 Cookie 自然到期及 generation，同时复核 owner/连接和当前订阅意图。不能把等待前的 boolean 当作最终权限，也不能只在最后复核 generation。转发固定订阅 Symbol，退订后再订阅不能接收旧等待中的通知；新有效订阅不被旧请求的失败清理撤销。真实 Socket 专项入口为 `scripts/acceptance/room-socket-expiry/`，按其 README 在固定隔离导出运行。

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
| P3 启动升级兼容 | `packages/server/src/utils/database-schema.test.ts`；`node scripts/verify-p3-startup.mjs <server-root> [cli\|index\|index-ts] [node] [web-dir]` 使用冻结旧 schema、隔离 HOME/DB、真实 health/退出/重启；CLI 另覆盖两个启动者与失败时未运行维护。npm smoke 自动追加同一验证；desktop 可指向复制到临时目录的 packaged runtime/server 和 bundled Node |
| 翻译配置 / 状态 / 调度 / 外发 | `packages/server/src/services/__tests__/translation-settings.service.test.ts`、`translation.service.test.ts`、`translation-queue.test.ts`、`translation-protection.test.ts`、`translation-client.test.ts`，以及 `packages/server/src/routes/__tests__/translations.test.ts` |
| Socket 转发与订阅 | `packages/server/src/socket/__tests__/socket-gateway.test.ts` |
| MCP 契约 | `packages/server/src/mcp/http-client.test.ts`、`packages/server/src/mcp/tools/__tests__/` 中的对应文件 |

数据库测试在 import Prisma 前设置独立临时库，再做 schema 同步，并在 teardown 断开连接和释放资源；可参考 `services/__tests__/project.service.test.ts`。跨端 DTO/API 变化还要构建 shared、server 和受影响的 web/desktop。
