# TeamRun 开发模式

## 领域链路

```text
Task -> TeamRun -> TeamMember
                -> RoomMessage -> WorkRequest -> AgentInvocation -> Workspace + Session
                -> WorkspaceVerdict (绑定 reviewedSha)
```

MemberPreset/TeamTemplate 是配置；创建 TeamRun 时将成员配置快照到 TeamMember，之后修改 preset 不改变运行中团队。JSON string 字段统一经 TeamRunService mapper 转换。

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
