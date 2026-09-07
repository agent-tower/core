# TeamRun 开发模式

## 领域与入口

```text
Task -> TeamRun -> TeamMember
                -> RoomMessage -> WorkRequest -> AgentInvocation -> Workspace + Session
                -> WorkspaceVerdict (绑定 reviewedSha)
```

以 `packages/shared/src/types.ts` 的 union/DTO、`packages/server/prisma/schema.prisma` 的持久字段和下列 Service 为准；类型中声明的状态、能力或策略不代表每条执行路径已经实现。

| 入口 | 所有权 |
| --- | --- |
| `services/team-run.service.ts` | Preset/Template/成员快照、消息与请求创建、可见性、成员派生状态及 DTO |
| `services/team-scheduler.service.ts` | 队列 claim、资源 admission、workspace/session 启动、启动重试和停止 |
| `services/team-reconciler.service.ts` | Session 结束、公开汇报、心跳补催、终态副作用与 review 推进 |
| `services/team-member-admission-barrier.ts` | 跨 Service 实例共享的 per-member 进程内 admission barrier |
| `services/team-lock.service.ts` | invocation 持有的 shared workspace write/command 锁 |
| `services/member-heartbeat-scheduler.ts` | 周期 cleanup、orphan/半终态恢复、补催与 queue pump |
| `services/workspace.service.ts` | TeamRun 主/成员 worktree、target sync、verdict、合并 readiness 与 Git 操作 |
| `routes/team-runs.ts`、`mcp/server.ts`、`mcp/tools/workspaces.ts` | HTTP 解析、传输身份绑定、MCP 能力与工作区工具 |

上表路径均相对 `packages/server/src/`。变更 Session/native runtime 时另读 [pipeline-patterns.md](pipeline-patterns.md)。

## 配置与成员

- 当前 TeamRun 要求支持 worktree 的 Git 项目，每个 Task 只有一个 TeamRun；不能套用普通 Task 对非 Git 项目的支持。
- MemberPreset/TeamTemplate 是配置。创建运行时将配置与 heartbeat timeout 快照到 TeamRun/TeamMember；preset 后续编辑不改现有成员。同一 preset 可以重复实例化，名字仅供展示与初始 mention 解析，业务关联用 `memberId`。
- 对用户创建入口复用 `createTeamRunWithInitialRoomMessage`，它将团队、成员、首条任务消息与初始 WorkRequest 放在同一事务，失败可完整重试。
- 成员可直接编辑快照或软移除。移除由 route 先按 `stopActive` 执行停止，停止失败不能继续移除；`membershipStatus = REMOVED` 保留历史并阻止新派活。
- 展示状态由活跃 invocation、runtime permission wait 与待处理请求派生；无活跃工作时回到 `IDLE`。`PENDING_APPROVAL` 既可能表示 CONFIRM 请求待批，也可能表示正在运行的 ACP turn 等待权限，不能仅凭这个展示状态决定队列操作。

## 消息与 WorkRequest

- 普通消息从结构化 `mentions[].memberId` 派活；私聊从去重后的 `recipientMemberIds` 派活。消息、参与者、WorkRequest 与消息的 `workRequestIds` 回写在同一事务。
- 普通消息有显式 mentions 时仅投递给被提及成员；没有 mentions 时，`USER_MESSAGES` 成员会接收 user 或其他 agent 的消息，排除发送者自身，system 消息不触发。不要因策略名称推断它仅接受 user。
- 普通消息不会解析显示文本中的 `@name`。例外是创建 TeamRun 的首条任务消息：从完整 title/description 精确匹配名称或别名；有 mention token 但匹配不唯一/不存在时，不回退为 `USER_MESSAGES` 广播。
- `CONFIRM` 创建 `PENDING_APPROVAL`，批准后变为 `QUEUED`；`AUTO` 直接入 `QUEUED`。HTTP 在消息持久化后后台调用 `startNextSessions`，不要让普通发消息响应等待 Agent 整轮执行。
- RoomMessage 保存全文，列表返回 preview；详情通过相同可见性规则获取全文。WorkRequest 的 `instruction` 可能只是摘要，构造 Session prompt 时复用 `buildSessionPrompt` 从 Task、触发消息全文及 attachmentIds 恢复上下文。
- 只有与 invocation 绑定的 PUBLIC agent 消息是完成汇报。RUNNING 时发公开消息刷新真实进展，不立即终止；WAITING_ROOM_REPLY 时收到公开汇报会 reconcile 完成。私聊、user/system 消息不替代公开汇报。

## 调度与恢复

WorkRequest 的主链是 `PENDING_APPROVAL -> QUEUED -> STARTED -> COMPLETED/FAILED/CANCELLED`；待批可 REJECTED，待批/排队可取消。AgentInvocation 的活跃集合包含 `QUEUED`、`RUNNING`、`SESSION_ENDED`、`WAITING_ROOM_REPLY`，不能把 Session 退出直接等同于 invocation 完成。

- `startNextSessions` 是正常执行入口；`planNext` 只做计划，`startNext` 创建不启动 Session 的 QUEUED invocation，三者不可互换。
- 每个成员串行。取得共享 admission barrier 后重新检查数据库，再用条件更新 claim `QUEUED -> STARTED`；资源锁和进程内 barrier 不能代替数据库 CAS。成员之间可并行，shared 写/命令能力另受资源锁限制；scheduler 用稳定的 `task:${taskId}` 代理标识申请这些锁，不能在创建真实 workspace 后改换锁 key。
- `ifBusy = cancel_current_and_start` 目前由 `planNext` 标记 `requiresStopCurrent`，执行入口仍跳过 busy 成员；它不是已完成的自动抢占链路。实际停止复用 `stopMemberWork`。WorkRequest 的 `cancelQueued` 在成功 claim 时只取消同成员其余 `QUEUED` 请求；成员 stop 的同名选项同时覆盖 `PENDING_APPROVAL`，两者都不表示全团队取消。
- 启动失败区分确定性错误和临时错误：配置/Provider/不支持的 target 等确定性错误终止请求；可重试错误记录 `startAttemptCount`、`lastStartError`、`nextStartRetryAt` 后重新排队。失败 invocation 保留诊断；一个 WorkRequest 重试时可能有多个历史 invocation。
- `resume_last` 每次仍创建新的 Tower Session 与 invocation，只选择同成员、同 execution workspace、同 target SHA 的历史原生上下文。ACP 优先 context-only `session/resume`，回退 `session/load` 的历史回放不能进入新 invocation 日志或算作新进展。
- watchdog 复用 reconciler；各阶段错误隔离，先恢复持久 cleanup，再处理 orphan、半终态、静默成员、到期 room reply 与队列。queue pump 同时恢复 AUTO 和已批准的 CONFIRM 请求，不启动 `PENDING_APPROVAL`。
- 心跳只认真实 Agent 进展；本地 user_message patch、历史回放和发出的 nudge 本身不能续命。权限等待由用户控制，不触发静默补催。room reply 与静默唤醒共用计数/退避/绝对预算，避免额外建立一套计时状态机。
- 自动 review 由 `maybeAdvanceTeamRunToReview` 负责：未删除且 `IN_PROGRESS` 的 Task，在无活跃 invocation、无待批/排队请求时进入 `IN_REVIEW`，写 `TEAM_QUIESCENT`。这是团队静止状态，不代表所有请求成功或 workspace 已满足合并要求。

## 停止与 Runtime 所有权

- 成员 stop、通用 TeamRun Session stop、调度及 direct follow-up 共用 per-member admission barrier。stop 先在事务写 `dispatchRevokedAt` 并按请求处理队列，再等待 OS cleanup；不要在持有 barrier 时递归启动下一项。
- `dispatchRevokedAt` 在 cleanup 等待/失败/恢复期间保持。terminal/revoked sender 的消息仍可落库，但不能派生 WorkRequest、触发 reconcile 或补催；数据库条件更新负责拦截 stop 之后的迟到消息。
- REST `sessions/:id/message`、MCP `sessions.send_message` 与 `SessionManager.sendMessage` 的 TeamRun follow-up 需要当前未撤销 invocation，并在 barrier 内复查 Session 与 ACTIVE member。普通 conversation Session 的终态 follow-up 语义不同。
- 初次启动和 `resume_last` 都需经 Session `PENDING -> RUNNING` CAS 与新鲜的 invocation admission 检查。Session 已创建而 invocation 尚未创建的窗口仍可能发生直接 stop，之后不能 spawn。
- invocation 可以先记录逻辑终态；这不证明进程已退出。`session-runtime-cleanup-gate.ts` 检查全部 launch claim、ExecutionProcess generation cleanup 和当前 owner；确认后，`WorkRequest STARTED -> terminal` 的唯一 durable winner 才能释放锁、推进队列及正常 after-terminal review。cleanup 未确认时继续阻塞该成员。
- 每次可能 spawn 前先持久化 launch claim。空 ExecutionProcess 集合仅在证明未启动或安全的 pre-child failure 时可视为已清理；未闭合 claim、缺少进程记录或不完整 ownership 必须持久 quarantine 并保留恢复诊断，不能按 Session.status、内存无 pipeline 或裸 PID 推断安全。
- 人工 stop、session exit、heartbeat/startup recovery 和重复 reconcile 复用同一 cleanup gate。旧 runtime generation 的退出/清理不能撤销新 owner，终态副作用必须可重复调用而不重复执行。

## 身份、权限与可见性

SessionManager 注入 `AGENT_TOWER_TEAM_RUN_ID`、`AGENT_TOWER_MEMBER_ID`、`AGENT_TOWER_INVOCATION_ID`、`AGENT_TOWER_SESSION_ID` 及绑定 Session/invocation 的 API credential。MCP 从 env/context 解析身份，HTTP access auth 绑定 identity header，Route/Service 再验证 TeamRun/member/invocation 关系；不能信任 body 自报的 sender/requester。

- 能力校验分布在 MCP、Route 与 Service，修改入口需顺链检查，不能假设 JSON 中的 capabilities 自动限制 Agent 原生文件/命令权限。
- `queueManagementPolicy = own_only` 只能操作自己的待批/排队请求；`team_pending` 可管理团队队列。`stopMemberWork` 能力不是队列批准/拒绝/取消权限，STARTED 请求走停止链路。
- 成员视角仅能读取 PUBLIC 或自己作为 participant 的 PRIVATE 消息；消息详情、TeamRun 聚合、相关 WorkRequest/Invocation 和队列摘要均需保持同一过滤。未绑定成员的用户视角可看到全部私聊，不能误描述为用户也只可见 sender/recipient。
- 公开发言、私聊、队列控制、review/test verdict 和 merge 的实际 capability 要求以入口实现为准。新增工具需要同时覆盖身份缺失、跨 TeamRun 伪造、REMOVED 成员和 detail 越权读取。

## Workspace 与合并

`mainWorkspaceId` 显式绑定 TeamRun root worktree，不用数组第一项推断。`shared` 和 `none` 成员都在这个主工作区运行；只有 shared 按能力取得 write/command 资源锁。`none` 不是无工作目录或只读沙箱。`dedicated` 是成员拥有的 child worktree，父级是 TeamRun 主工作区。

- 主/成员 workspace 创建通过共享 claim 去重；使用 WorkspaceService 的激活流程处理已合并成员工作区，从当前主工作区恢复，不能直接复用旧分支状态。
- REVIEW/TEST 的 `WORKSPACE_COMMIT` target 快照 source workspace、branch、完整 SHA 和可选 plan item。只有 dedicated 成员可执行；execution workspace 必须属于该成员/TeamRun、不是 source 且干净，先同步目标提交并验证 HEAD 再启动。target TEST 的运行端口由 invocation 分配并注入，避免并行测试抢占默认端口。
- verdict 追加保存，按 sequence 判断最新结果；REVIEW 要求 `readDiff`，TEST 要求 `runCommands`。`reviewedSha` 必须等于 source 当前 HEAD，targeted verdict 还要匹配 invocation 的 target SHA。
- 当前 child 合并硬门槛是最新 `APPROVED` review、SHA 匹配 HEAD、reviewer 非 owner，并检查 owner 活跃 invocation、父工作区活动、后台服务和 Git 状态。TEST verdict 供展示，当前不是必需的合并门槛；不要把「存在审查/测试记录」当作已经 mergeReady。
- child 合并和批量 `merge-members` 要求有效 invocation 与 `mergeWorkspace` 能力；preview/dryRun 不能替代执行时的校验。批量返回逐 workspace 结果与部分成功，`stopOnConflict` 只控制冲突后的后续处理。
- `mergeWorkspace` 能力不预占 invocation 级合并锁。实际 Git 操作由 WorkspaceService 按目标加锁：child 锁父 workspace，root 锁项目主工作树。TeamRun 最终只允许绑定的主 workspace 合入项目，所有 child 必须先 MERGED 或 ABANDONED。

## 实时契约与验证入口

状态变更使用 `team-run-events.ts` 发 `team-run:invalidated`，payload 的 scopes/reason 在 `packages/shared/src/socket/events.ts` 定义，经过 EventBus/SocketGateway 到 `packages/web/src/lib/socket/hooks/useTeamRunRealtimeSync.ts`。前端 `hooks/use-team-run.ts` 的查询、重连和轮询负责失效/补偿，最终状态以 REST 为准；新 scope 同步检查前端 cache key。

按行为选最窄测试；不必为仅修改本 reference 跑业务测试。以下路径相对 `packages/server/src/`：

| 变更面 | 优先检查 |
| --- | --- |
| 快照、触发、首条消息、preview/可见性 | `services/__tests__/team-run.service.test.ts`、`routes/__tests__/team-runs-private-messages.test.ts` |
| 队列、CAS、busy、target、resume、启动失败 | `services/__tests__/team-scheduler.service.test.ts`、`services/__tests__/team-queue-recovery.integration.test.ts` |
| 完成、停止、cleanup、恢复、权限等待 | `services/__tests__/team-reconciler.service.test.ts`、`services/__tests__/session-manager.team-run.test.ts`、`services/__tests__/member-heartbeat.test.ts`、`services/__tests__/member-heartbeat-scheduler.test.ts` |
| 资源锁、worktree、verdict、部分合并 | `services/__tests__/team-lock.service.test.ts`、`services/__tests__/workspace.service.test.ts`、`routes/__tests__/team-runs-merge.test.ts`、`mcp/tools/__tests__/workspaces.test.ts` |
| 凭证与 transport identity | `middleware/__tests__/access-auth.test.ts`、`mcp/http-client.test.ts` |
