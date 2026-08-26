# TeamRun 开发模式

## 领域链路

```text
Task -> TeamRun -> TeamMember
                -> RoomMessage -> WorkRequest -> AgentInvocation -> Workspace + Session
                -> WorkspaceVerdict (绑定 reviewedSha)
```

MemberPreset/TeamTemplate 是配置；创建 TeamRun 时将成员配置快照到 TeamMember，之后修改 preset 不改变运行中团队。JSON string 字段统一经 TeamRunService mapper 转换。

`sessionPolicy = resume_last` 仍为每个 WorkRequest 创建独立的 Tower Session 与 AgentInvocation，只复用同一成员在匹配 workspace/target 上的 Agent 原生上下文。ACP 应使用 context-only `session/resume`；Agent 不支持时可回退 `session/load`，但历史回放属于旧 Session，不能写入新 invocation 的日志或计作新进展。

TeamRun invocation 进入 `COMPLETED`、`FAILED` 或 `CANCELLED` 后，必须等待对应 Tower Session 的全部 runtime generation cleanup 确认且不存在 current owner，再 admission 下一项；`WAITING_ROOM_REPLY` 及其合法 reminder/follow-up 期间保持 runtime。`WorkRequest STARTED -> terminal` 条件更新是 after-terminal 的唯一 durable winner，只有 winner 可以 unlock、启动下一项和推进 review；人工 stop、session exit、heartbeat/startup recovery 和重复 reconcile 全部复用同一 cleanup gate。cleanup 未确认时 invocation/WorkRequest、锁、队列和 review 都保持 pending，重复恢复必须幂等。

runtime launch evidence 独立于 `Session.status`：initial 与 `resume_last` 的新 Tower Session、普通 follow-up 在任何可能 spawn 前都先写 durable claim。只有明确从未跨过 launch gate，或已知在创建 child 前失败并安全补偿，空 `ExecutionProcess` 集合才允许终态；claimed 但无 row、row identity 不完整或历史 ownership 不明必须持久 quarantine、周期告警并继续阻塞成员，不能猜测为 never-launched 或按裸 PID 清理。

Initial TeamRun Session creation and Invocation creation are a short-lived admission boundary: process ownership requires a PENDING -> RUNNING Session CAS plus a fresh dispatch/session check. Direct stop may cancel a Session before its Invocation exists; no later scheduler or follow-up path may spawn after that cancellation.

成员 stop 与通用 TeamRun Session stop 共用同一 per-member scheduling barrier。stop 开始时在同一事务写入 invocation `dispatchRevokedAt` admission gate，并按请求清理已有队列；该 gate 在 OS cleanup 等待、失败和恢复期间保持。带 sender invocation 的公开/私聊消息仍可落库供审计和参与者读取，但 terminal/revoked sender 不得创建 WorkRequest 或触发 reconcile；开始 stop 后的迟到消息不能在 barrier 释放后重新启动成员。

TeamRun Session 的 direct follow-up（REST `sessions/:id/message`、MCP `sessions.send_message` 和内部 `SessionManager.sendMessage`）必须携带当前未撤销 invocation 身份，并在同一 member barrier 内复核 invocation、Session 和 ACTIVE member；终态或 revoked invocation 一律拒绝。普通 conversation Session 保持终态 follow-up 兼容行为。

公开或私聊消息使用结构化 mention/recipient 创建 WorkRequest。不要从显示文本解析 `@name`；使用稳定 `memberId`、busy policy 和可选 commit target。

- `CONFIRM` 请求先进入 `PENDING_APPROVAL`。
- `AUTO` 请求进入 `QUEUED` 并尝试启动。
- 成员状态是 request/invocation/session 的派生结果，不可单独修改。

## Service 边界

- `team-run.service.ts`：配置、成员、消息、请求、权限和 DTO。
- `team-scheduler.service.ts`：队列、invocation/session/workspace 启动、重试和 target sync。
- `team-reconciler.service.ts`：恢复派生状态，处理 session end、room reply 和 review。
- `team-lock.service.ts`：按 invocation 持有 shared workspace write/command 资源锁；`mergeWorkspace` 仅表示授权，不在 invocation 生命周期预占合并锁。
- `team-run-events.ts`：发射 scope-based invalidation。
- `member-heartbeat-scheduler.ts`：无进展唤醒、room reply 补催和 orphan 回收。

使用 transaction 和带旧状态条件的 update 维护数据库并发；资源锁不替代数据库控制。PTY 启动失败时释放资源锁，并留下可重试状态、错误与下次重试时间。

## 身份与可见性

TeamRun 身份由 SessionManager 注入 `AGENT_TOWER_TEAM_RUN_ID`、`AGENT_TOWER_MEMBER_ID`、`AGENT_TOWER_INVOCATION_ID`、`AGENT_TOWER_SESSION_ID`。MCP 不接受 agent 自报身份。

- 校验 invocation 与 TeamRun/member/session 绑定，并按 capabilities 授权。
- 普通成员只看自己的 request queue，`team_pending` 可管理团队 pending queue。
- PRIVATE message 只对 sender/recipient 可见；获取全文时重复相同 visibility check。
- list 可返回 preview，不能因读取 detail 绕过权限。

## Workspace 与合并

`workspacePolicy` 为 `none`、`shared` 或 `dedicated`。Dedicated workspace 是 main workspace 的 member-owned child worktree；review/test target 绑定 source workspace、branch 和 HEAD SHA。

合并前复用 merge readiness，检查 workspace/git/activity 与绑定当前 HEAD 的 review/test verdict。代码变化后旧 verdict 失效；批量合并返回逐 workspace 结果，部分失败不能伪装成原子成功。

合并锁由 `WorkspaceService` 在实际 Git 操作期间按目标持有：dedicated child 合并锁定其父 workspace，任务根 workspace 最终合并锁定项目主工作树。不同任务/TeamRun 的父 workspace 合并互不阻塞；项目主工作树的 checkout/merge/commit 仍需短时串行。

所有状态变化通过 `team-run:invalidated` 的 scopes/reason 通知前端。前端 Socket 与轮询只是失效/补偿机制，最终状态以 REST 为准。

测试重点覆盖并发调度、AUTO/CONFIRM、busy/cancel、spawn 重试、重启恢复、身份伪造、私聊可见性、target sync、verdict SHA 和部分合并失败。
