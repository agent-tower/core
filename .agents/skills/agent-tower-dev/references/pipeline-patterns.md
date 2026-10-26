# Session、Runtime 与输出链路

## 定位代码

下列路径相对仓库根目录，同一单元格内省略目录的文件沿用前一个目录。先按问题定位层级，再读该层实现和邻近测试。

| 领域 | 入口 |
| --- | --- |
| 会话业务、终态、快照与独立对话队列 | `packages/server/src/services/session-manager.ts`、`conversation.service.ts` |
| Runtime 接口、轮次协调与状态 | `packages/server/src/runtime/contracts.ts`、`runtime-coordinator.ts`、`runtime-state-view.ts` |
| CLI 执行 | `packages/server/src/runtime/cli-driver.ts`、`cli-parser.ts`；`packages/server/src/executors/`；`packages/server/src/pipeline/agent-pipeline.ts` |
| ACP 协议、投影、历史合并 | `packages/server/src/runtime/acp/acp-driver.ts`、`projector.ts`、`history-reconciler.ts` |
| ACP Agent 扩展 | `packages/server/src/runtime/acp/agents/types.ts`、`registry.ts`、`native-agent.ts` 与各 Agent Definition |
| 进程所有权与恢复 | `packages/server/src/runtime/acp/process-manager.ts`、`launch-cleanup-registry.ts`；`packages/server/src/services/session-runtime-cleanup-gate.ts` |
| Provider 解析与编辑 | `packages/server/src/executors/providers.ts`；`packages/server/src/services/provider-config.service.ts`、`provider-effective-connection.service.ts` |
| 共享能力与前端消费 | `packages/shared/src/agent-runtime-support.ts`、`provider-capabilities.ts`、`log-adapter.ts`；`packages/web/src/hooks/use-sessions.ts`、`lib/socket/hooks/useNormalizedLogs.ts` |

## 分层与身份

```text
SessionManager -> RuntimeCoordinator -> CLI Driver -> Executor / PTY / AgentPipeline / Parser
                                     -> ACP Driver -> Agent Definition / ACP SDK / ProcessManager / Projector
Parser / Projector -> MsgStore -> Runtime events -> SessionManager / EventBus -> Socket
```

- `SessionManager` 负责数据库状态、执行环境、快照、auto-commit 和 Task/TeamRun 结束处理；PTY、Pipeline 和 ACP 连接由 Driver 持有。Route 不直接 spawn，Parser/Projector 不更新 Prisma 或任务状态。
- `RuntimeCoordinator` 按 Tower Session 管理 DriverSession，保证单 active turn，并统一 turn ID、事件顺序、权限请求与可等待的销毁。Driver 通过 `contracts.ts` 的 sink 报告输出和进程事件。
- `AgentType` 是 Agent 身份，`RuntimeType` 是 CLI/ACP 协议。创建 Session 时按 shared 支持矩阵校验并固化 Runtime；follow-up 可切换同 Agent、同 Runtime 的 Provider，不能跨身份或协议。纯 ACP Agent 没有 Provider 时不能默认为 CLI。
- Codex reasoning effort 的基础档位由 shared capability 提供；server 根据 `codex debug models` 的模型目录过滤高档位，同时为 `gpt-6-sol` 开放 `max`/`ultra`、为 `gpt-6-luna` 开放 `max` 且拒绝 `ultra`。保存和测试不得静默降级，CLI/ACP 启动时保留原始值交给 Codex runtime 处理。
- 区分 Tower Session ID、每轮 `turnId`、Agent 原生 `externalSessionId` 与每次 OS 启动的 `runtimeInstanceId`。一次逻辑 turn 完成不代表 DriverSession 关闭，也不代表整个 OS 进程树退出。
- `Session.status` 是持久化业务状态，`RuntimeStateDto` 是当前运行状态。`hasActiveTurn()` 用于存活判断；`AWAITING_PERMISSION` 是活跃的用户等待，不能按无输出超时处理。旧 `hasActivePipeline()` 仅作兼容。

## 消息与恢复

### 独立对话与任务 follow-up

`ConversationService` 创建独立对话时将首条 prompt 入队，后续 `/conversations/:id/message` 在消息持久化后返回 `202`。`SessionManager.enqueueConversationMessage()` 写入 `ConversationTurn` 并立即显示用户消息；每个 Session 的 worker 串行执行，等待上一轮完成后才派发下一条。不要把 ACP initialize 或模型回复重新放入 HTTP 请求等待链路。

队列的 `userEntryId` 与 turn 一同持久化，重放时复用该 ID，避免重复用户日志。`app.ts` 启动时恢复中断的 `RUNNING` turn 为 `QUEUED`，关闭时停止调度。新增队列状态或取消语义时同时检查持久行、worker、停止和重启恢复，不能只改内存队列。

`ConversationTurn.RUNNING` / `startedAt` 在 worker claim 时写入，此时仍可能等待上一轮完成，不能直接解读为模型已开始生成。队列执行状态、runtime 的 `turnId` / turn state 和消息展示状态需要分别核对；前端入口为 `packages/web/src/hooks/use-conversations.ts` 与 `packages/web/src/pages/ConversationPage.tsx`。

普通任务的 `sendMessage()` 允许替换 active turn：先取消旧轮，等待必要的快照与 auto-commit 边界，再启动新轮。它与独立对话排队语义不同。TeamRun 的 direct follow-up 还受当前 invocation 身份和成员 admission barrier 约束，见 [teamrun-patterns.md](teamrun-patterns.md)。

### ACP 上下文与本地日志

- DriverSession 可跨轮复用 ACP 连接和原生 session ID，但 `MsgStore` 由每次 `runTurn()` 注入；空闲连接不能持有上一轮已释放的 store。
- 活跃轮的健康 `session/cancel` 可供 follow-up 复用连接；取消失败或超时会进入销毁。显式 Session stop 关闭 DriverSession。协议错误、连接关闭或 adapter 退出也使当前 transport 失效，后续重连使用持久化的原生 ID。
- `resume` 只续接 Agent 原生上下文，`load` 才恢复本地缺失历史。已终态且持有完整持久快照的 ACP follow-up，以及跨 Tower Session 的上下文续接，使用 `resume`；Agent 不支持时可退到 `load`，但仍忽略历史回放。未完成 Session 用 `load` 补齐可能尚未落盘的内容。
- 历史回放先投影到临时 store，经 `history-reconciler.ts` 按稳定 ID 和有序内容合并，再用一个 `/entries` replacement patch 提交。保留本地用户消息，以本轮 user entry 为插入边界；不能把 replay 直接逐条追加到实时日志。

## 启停与清理

### 运行轮次

`start()`、`startFollowUp()`、`sendMessage()` 和 `stop()` 共用 SessionManager/Coordinator 的协调入口。`withStartAdmission()` 覆盖状态推进、凭据签发、持久 launch claim 与 Driver 启动交接，不持有到长轮次完成。停止意图须能取消尚在准备或启动中的操作；旧 runtime 清理未完成时不允许另开 replacement runtime。

ACP transport 的 generation 与 connection identity 隔离异步回调。修改启动、重连或取消时保留取消信号和身份复核，使旧连接的通知、权限请求、close/exit 与迟到结果不能覆盖新连接。

CLI spawn 与 Pipeline attach 之间保留 `collectEarlyPtyEvents()` / `takeEarlyEvents()` 一次性交接，短命进程的 data/exit 不能丢失。Codex CLI `turn.completed` / `turn.failed` 和 Claude Code CLI 的顶层最终 `result` 是独立的逻辑终态：先处理最终消息与 usage、标记 store finished，再报告结果；后来到达的 PTY exit 不能把失败改为成功。Claude 的 `message_stop`、`tool_result` 与带 `parent_tool_use_id` 的子 Agent 结果不是整轮终态。Parser finish 与终态通知均只执行一次。

终态 DB、快照、auto-commit、commit message 和任务推进由 SessionManager/Team services 处理。auto-commit 绑定 Session generation，follow-up 在其完成或放弃后再启动，避免旧轮 Git 操作与新轮重叠。

`COMMIT_MSG` 是一次性后台 Session。`SessionManager.handleSessionExit()` 在终态持久化与结果提取之后通过 `finally` 关闭对应 runtime，失败轮次、快照持久化或结果提取异常也执行清理；按 Session generation 与 runtimeInstanceId 隔离旧收尾。使用 Coordinator 的可等待 dispose 保留业务终态、历史与清理失败重试，不依赖 ACP 自行退出、普通聊天连接复用或 workspace 休眠。

### 进程与资源

- 每次可能 spawn 前先写 durable launch claim，再用持久 `ExecutionProcess`、已验证的 transport 复用或明确的创建 child 前失败来解析 claim。`Session.status` 和空进程列表本身都不能证明未启动或已清理；不完整/未解析证据交给 `session-runtime-cleanup-gate.ts`，不能猜测成功。
- 进程记录关联 `runtimeInstanceId`、launch claim、PID/进程组、birth marker 和 ownership token。清理前核验身份，覆盖根进程退出后仍存活的后代；根 exit 只记录退出结果，整树确认另走 `tree_cleanup_completed`。身份缺失或探测失败保留 quarantine/诊断，不能按裸 PID 发信号。
- Unix 身份 adapter 保留从已验证活进程的 PPID/进程组发现的后代及 birth identity，后代未继承 token 也不能丢弃。原生命令可用 `captureChildProcess()`，但必须持有真实 child/PTY handle，并在异步采样前后确认 launch 存活及直接父子关系；不能凭旧 PID 重新认领。通用 child 与独立终端在运行期间持续采样并合并并发探测，停止采样、等待在途探测且确认整树退出后才调用 `releaseOwnership()`。
- Linux 环境扫描跳过明确属于其他 UID 的进程；同 UID 权限拒绝仅在能够证明进程早于本次 launch 且与已验证树无关时忽略。无法排除归属的候选继续报告探测失败，不能以空列表当作退出证据。Z/X 视为已退出，但保留已验证拓扑以发现其他存活后代。
- workspace 删除、归档、休眠、周期清理和 conversation 删除通过 `session-resource-cleanup.ts` 停止所有状态的 Session 并核验 cleanup gate。资源清理期间阻止创建/续发，失败保留目录与持久进程证据。已经 spawn 的 `started` 事件必须继续写入所有权，不能被新启动的 admission guard 拦掉。
- `close()`/dispose 必须可等待、并发复用且失败后可重试。CLI 保留 active 与 pending cleanup 的真实退出 owner；ACP 保留各 transport 的 ProcessManager 和临时配置 cleanup owner。超时、DB 写失败或禁用新轮都不等于清理成功。
- CLI wrapper 的整树完成证据由父进程持有的能力确认；子进程继承的 ownership marker 仅用于归属发现。wrapper 必须使用本次 launch 的唯一 marker：`buildPtyWrapperEnv()` 会清除父进程 marker 并生成缺省 token，脚本被直接调用且缺少显式 seed 时也会先生成并覆盖继承 marker，避免测试或嵌套 Agent 将祖先进程误认成自己的进程树。沿用 `utils/process-launch.ts`、`tree-cleanup-channel.ts` 和平台进程身份工具，不通过直接杀 wrapper 绕过整树回收。
- CLI Driver 和 Executor 启动失败清理共用 wrapper 的退出等待预算，须覆盖 wrapper 的强制终止宽限与最终清理确认。Unix wrapper 的进程探测同时读取状态与 birth identity；Z/X 行保留为后代发现的拓扑证据，但不作为存活成员发信号或阻塞退出。探测失败保留清理 owner，并输出去重的诊断，不打印带环境变量的进程表正文。
- CLI 初次身份采集持有新建 PTY handle 时，通过 `captureChildProcess` 复核直接父子关系及采样前后的存活状态，不要求 spawn helper 已暴露 wrapper 环境标记；只有 PID 的恢复路径仍须核验 marker。身份采集失败但父进程后来确认整树退出时，Driver 投递带 launch claim 的 `launch_cleanup_completed`，Service 仅对无进程记录的当前未闭合 claim CAS 为 `CLEANED_START_FAILURE`。普通 exit、旧 claim 或已有进程记录不能走这个入口；落库失败保留事件与 owner，周期恢复还会重试无 ExecutionProcess 行的 DISPOSED runtime。
- 恢复可处理没有当前内存 owner 的旧进程，不能清理仍由当前 runtime 持有的进程。TeamRun 下一项 admission、锁释放与 review 使用统一 cleanup gate，具体业务规则见 TeamRun reference。
- 应用关闭经 `runtime/shutdown-coordinator.ts`、`server-entry-shutdown.ts` 与桌面 shutdown 入口等待并重试清理。未确认 owner 必须保留可重试状态并报告失败，不能静默丢弃或提前 `process.exit`。
- Git、CLI 检测与安装器使用 `utils/owned-child-process.ts` 持有整树 owner；timeout、abort、输出超限和自然根退出都先等清理再返回。通用 child 与 route 局部 manager 注册到 `runtime/application-process-cleanup.ts`，应用关闭后禁止新 spawn；Windows wrapper 在确认后代清理前保持存活，根已退出时按重新核验的后代身份继续清理。

托管 Agent 的 opaque API credential 绑定 Session 身份并随 DriverSession/MCP transport 生命周期复用。普通 CHAT 的自然 turn 完成不撤销；显式 stop、dispose（含 COMMIT_MSG 终态回收）、启动失败和应用销毁会撤销。后续重开连接签发新凭据，避免旧 Agent 仍可调用 workspace 服务。入口是 `utils/agent-api-credential.ts` 与 SessionManager 的环境注入。

## Provider 与 Agent 扩展

### 配置入口

Provider 是主要配置入口，profiles 保留兼容。`providers.ts` 合并内置默认与用户配置；`provider-config.service.ts` 负责 draft 归一化、简单/高级映射、冲突诊断和 secret 遮蔽；`provider-effective-connection.service.ts` 统一连接来源及认证解析。编辑、测试和运行配置应复用这些入口，避免各自解释 env/settings 优先级。其返回的 `secret` 只用于服务端，不能直接序列化或打印。

Provider 顶层 `enabled?: boolean` 表示是否在选择入口展示，缺省为启用；禁用配置仍保留于管理读取、持久化、备份、导入与 reload，默认解析跳过禁用项。禁用不等于删除或即时撤销运行授权，不改变已有 Session 的身份、配置展示或活动执行快照。

CLI Executor factory 为每次启动生成配置，ACP Definition 将 Provider 投影为 profile/launch spec。显式连接配置应覆盖或移除继承环境中会抢优先级的旧认证变量；已运行 child 保持启动快照，切换配置需要新的启动边界。动态 credential `env_key` 不能占用 `ExecutionEnv` 保护的 Agent Tower、TeamRun 或 MCP 环境变量。

Agent 专属配置使用结构化解析：Codex TOML、Claude JSON 及现有标准工具。保留用户未覆盖的字段；协议 header、认证方式、model/effort/fast-mode 和原生权限配置放在对应 Executor/Definition。比如 Codex 官方 API key 与兼容网关的 ACP authentication hook 不应变成通用 Driver 的 AgentType 分支。

### CLI 与 ACP

- CLI 扩展实现 `BaseExecutor` 的身份、命令与可用性入口，通过 `CommandBuilder`、`ExecutionEnv` 和现有 PTY wrapper 启动；follow-up、slash commands、MCP 路径按 Agent 能力扩展。保留 Windows ConPTY、stdin 临时文件权限与清理、日志脱敏。
- CLI 的可选 `SpawnedChild.duplex` 通过 `cli-duplex-channel.ts` 与 wrapper 的 `pipe-duplex` mode 保持真实 stdin、独立 stdout/stderr、串行写入/ACK 和 EOF；私有 IPC 配置不传给 Agent。PTY 继续负责 wrapper 的 launch identity、started 屏障和整树 cleanup。Duplex 不能通过 `writeInput` 注入控制帧；普通 CLI 的 PTY/pipe-file 路径保留。
- Duplex 根退出即启动整树清理，输出完成独立等待两条原生流结束及服务端 reader 的消费 ACK（早期缓存也要实际重放后才 ACK）。正常 PTY exit 不能先 finish/unsubscribe Parser；传输超时是失败，不合成成功 EOF。逻辑 result 后的 cleanup grace 也必须保留 duplex reader；显式停止、`cancelTurn()` 及 `abandonTurn()` 替换都须走 Driver 的同一 stop owner，在卸载 reader 前关闭通道解除消费等待。取消结果先于通道关闭确定，避免同步 disconnect 改写取消原因；新轮仍等待原 owner 的真实整树清理及持久事件确认。
- Claude CLI ASK 使用 `claude-cli-control.ts` 专属 codec。Claude Parser 是唯一 NDJSON 分帧入口，控制帧不进入原始 stdout 日志或 Socket。先 initialize，再确认 `set_permission_mode(default)`，发布本轮生效快照后才发送任务；每轮新进程 + resume 也走同一确认。请求绑定 Session/turn/runtime/native request/tool ID，Driver 保存原始 input；公共等待/重连视图沿用 Coordinator。Reader 不等待用户，native cancel/EOF/停止使 resolver 失效；result 先保留日志/usage，再逻辑结束、stdin EOF 和有界整树清理，不将逻辑完成当成 cleanup。
- Claude CLI ASK 的构建门槛只验证原生控制通道，当前不按模型白名单判断；初始化/default ACK 在发送模型任务前执行。真实工具批准/拒绝及 resume smoke 仅 `deepseek-v4-pro`，其他模型/官方 Anthropic 模型没有 smoke 证据，不得把协议判断等同于这些组合的工具行为验收。
- Codex CLI ASK/AUTO_SANDBOX 使用 `codex-cli-control.ts` 的唯一 JSONL/RPC 入口与 `codex-cli-projector.ts`，不把 app-server 帧交给 exec Parser。初始化后新建/恢复 thread，按已授权模式正向确认 `on-request + user/auto_review reviewer + workspaceWrite` 后才发 `turn/start`；每轮仍是新进程。AUTO 的自动审阅由 Codex 原生执行，剩余命令/文件请求仍进入公共人工审批，不由 Tower 全部代答。turn/start 响应与 turn/started 通知可以先后交换，但必须确认同一个原生 turn；审批绑定 Tower Session/turn/runtime 与原生 thread/turn/request/item。数字与字符串 RPC ID 分开。只支持命令/文件工具审批，发送一次 accept/decline，不保存规则；其余原生问答、资源 grant、MCP elicitation、持久目录授权明确失败，不按标题猜语义。控制帧不写 raw stdout；投影保留并发工具、增量消息/输出、计划、usage 和原生 thread ID。FULL_ACCESS 保持 exec；ACP 不使用这条 codec。
- `ExecutionPermissionService.prepare()` 有界刷新 Claude/Codex 的实际 executable/build/version 缓存，options/diagnostics 只读取已准备结果；Provider 保存/测试/读取与 admission 共用。未知 wrapper 不运行版本探针；验收构建目录位于 `claude-cli-capabilities.service.ts` / `codex-cli-capabilities.service.ts`，新增组合须留下真实原生模式、请求及 resume 证据。Executor 固定到已检测的原生路径，启动仍独立确认模式。易变版本范围以目录和验收记录为准。Codex CLI ASK/AUTO 的真实工具 smoke 目前仅 `gpt-6-sol` 兼容网关，但能力不按模型名筛选；模型留空或另选模型时，原生 thread 配置确认和 turn 启动错误仍须明确失败，账号/连接须在实际运行中验证。`scripts/smoke-codex-cli-ask.mts` 检验人工批准/拒绝；`scripts/smoke-codex-cli-auto-sandbox.mts` 检验沙箱内动作、原生自动审阅、跨档 resume 与取消后 cleanup→started 顺序。两者都使用临时 Codex home/工作区，源码运行需先 build shared，并用 server 的 tsx。
- 审批答复在 Service 使用本轮生效模式复核部署授权，传递到 Coordinator/Driver 的 `authorizeDelivery` 在实际 stdin 写入前再次检查。Coordinator 和 codec 均保证一次消费；取消/迟到/重复返回冲突，部署拒绝保持 403。`RuntimeQuestionRequest/Answer` 是独立扩展契约：questionId 按本轮请求稳定编号，答案不使用权限 optionId、不按题目文字索引。当前没有开放 question API/adapter，FULL_ACCESS 不代答，也不将计划批准变成权限提升。
- ACP 扩展实现 `AcpAgentDefinition` 并注册到 `agents/registry.ts`；原生 ACP Agent 优先参考 `native-agent.ts`。Definition 负责 launch、Provider 投影、可用性、认证与会话配置，通用 Driver 负责 ACP 生命周期。专属 session option 依据 bootstrap 广告的 capability/configOptions 设置。经 `native-agent.ts` 工厂新增 Definition 选项时，除加入 `NativeAgentOptions` 外**必须同时展开到工厂返回的 Definition**——漏掉展开会被静默丢弃且类型检查通过（`maxStdoutFrameBytes` 与 `transformStdoutFrame` 都踩过），因此新选项要配一条断言 Definition 实际取到值的测试。
- Provider 顶层 `executionPermission` 统一为 `ASK / AUTO_SANDBOX / FULL_ACCESS`；shared `execution-permission.ts` 集中读取旧字段、检测冲突并去除迁移字段。危险布尔 true、旧 UNRESTRICTED/AUTO_APPROVE 只能迁移到 FULL_ACCESS；仅有旧字段/缺省的 Codex CLI 和 ACP ASK 均须显式重选，旧 ACP 并未设置人工 mode。`executionPermissionReviewRequired` 必须跨持久化/备份保留，不能因规范字段已出现而丢失诊断。新的规范 ASK 是明确选择；其他 Agent 继续沿用各自兼容语义。
- `ExecutionPermissionService` 在 Provider 保存/测试和 SessionManager 启动 admission 检查支持/允许档位，策略通过 `ExecutionPermissionPolicy` 注入，默认本地 owner。Codex 原生 auto-review 可以批准沙箱外动作；受限策略必须显式声明可执行的外层边界，否则 AUTO 不可选且下一轮/审批答复返回 403。权限模式不是资源隔离或完整多用户授权；适配器不判断角色。
- Service 创建 Provider 快照与授权模式，CLI 每轮新进程使用当前快照，ACP 活动连接保留启动快照；runtime state 暴露实际启动模式。Service 在新启动授权前核对快照 Agent/runtime 与 Session，一致性也由 CLI/ACP Driver 在新进程/transport 边界保护；同 ID 导入改变接入方式后须创建新 Session。ACP `hasActiveTransport=false` 时不能沿用旧授权，重连投影当前快照；准备期间连接失效且模式冲突则拒绝并要求重试。Provider ID 相同不能证明新配置生效。
- ACP 原生投影放 Definition。Codex 明确协商 read-only/agent/agent-full-access（历史 ID 不代表真实沙箱）；新建/resume/load 均应用，缺广告模式报错。无可靠恢复配置链路的 Definition 设置 `supportsPermissionRestore=false`，不静默复用旧权限。通用 Driver 不按档位自动允许任何剩余请求；权限请求是独立协议事件，结束/取消后使旧请求失效。
- Codex CLI `AUTO_SANDBOX` 每轮用 app-server 的 `-c` 固定 `sandbox_workspace_write.writable_roots=[]` 与 `network_access=false`，新建/resume 都从原生 thread 响应确认基础边界后才发任务；Provider 高级 TOML 中的同名沙箱表应在能力和授权边界拒绝。原生自动审阅仍可能批准越界动作，不能把这两个基础值或部署的 `allowsNativeAutoReviewEscalation` 声明当作宿主/MCP 隔离。
- adapter、可执行文件覆盖及打包解析参考相邻 Definition 和 `agents/executable-resolution.ts`。随包发行的 adapter 由 server production dependencies 管理；不要 patch 第三方 adapter 或写用户全局配置来实现单次会话隔离。
- Gemini CLI runtime 优先使用 PATH 中已安装的 `gemini`，未安装时才回退 `npx -y @google/gemini-cli@latest`；initial/follow-up 共用选择规则，并尊重 Provider 的 `baseCommandOverride`。Docker build args 可以固定全局 CLI 版本，执行器应使用该安装结果。
- Codex ACP 启动与可用性检测共用系统优先的解析规则：自动查找系统 `codex`，仅在未找到时使用内置 Runtime；查找时排除项目 `node_modules/.bin` 与相对 PATH 目录，不改变 Agent 工具执行时的原始 PATH。`CODEX_PATH` 是 Tower 根据检测结果写入或清除的 adapter 参数，不再作为用户选择 Runtime 的入口；系统 Codex 启动失败不自动重试内置版本。
- Codex ACP 会在兼容网关上把出网身份伪装成原生 `codex exec`：Provider 投影写入 `originator`，`resolveLaunch` 再补 `user-agent`（`codex-cli-identity.ts` 按 Codex CLI 的格式复刻，含 OS 与终端回退）。两者分处两个阶段是因为版本要等 Runtime 解析完成；改动任一处都要保持 UA 与 `originator` 一致，并保留「Provider 自带 header 优先、无显式 `model_providers` 条目的内置 Provider 不改写」的规则。`x-codex-turn-metadata` 由 Codex 自行生成，无法用 header 覆盖；ACP 缺少 `turn_trigger` 是已知残余差异。
- 托管 MCP 命令由 `services/mcp-config.service.ts` 统一解析开发源码、编译 CLI 和桌面入口，并注入当前服务 URL。存在 session credential 时传递该凭据，否则才使用 internal token；缺入口或实例信息时显式失败，不猜默认端口。
- Definition 创建的敏感临时配置使用 `managed-directory.ts` 的隔离目录和受限权限，并将幂等 cleanup 交给 Driver；启动失败、transport reset 和 close 都须回收。Pi 的隔离配置/adapter 与历史 Minion bridge 属于对应 Definition。
- 与上述临时目录相对，Agent 自身的持久数据目录属于长期状态，不能注册 cleanup：DeepSeek Harness 把 `DSH_HOME` 指向 `resolveDataDir()/deepseek-harness/<providerId>`，由 Definition 预置 profile 骨架并保留会话与 storage。区分二者时以「停止后是否还需要这份数据」为准。
- Provider 权限能力由服务端固定返回三项 options，分别表达 supported、authorized、selectable 与原因；`executionPermission.path` 只用于危险旧字段迁移，不再决定 UI 控件。结构化审批 capability 不代表原生沙箱支持。`reasoningEffort.options` 按 Agent 自己的档位枚举。
- ACP 权限的 `ASK`/`FULL_ACCESS` 不一定对应 Agent 的 ACP mode：DeepSeek Harness 没有 mode 选择器，Definition 把它映射为启动变量 `DSH_PERMISSION_MODE`（`workspace-write` / `danger-full-access`），由 `dsh-base` 同时决定沙箱范围与审批策略。映射前先确认上游的语义：这里的 `ASK` 是「限制在工作区、越权时按需申请提权」，不是「每条命令都询问」。

新增 Agent 时按受影响功能检查 shared `AgentType`/支持矩阵/Provider capabilities/default providers、CLI factory/parser 或 ACP registry、前端 `lib/agent-meta.ts`/Provider 选择器/图标，以及 slash command/skill/MCP 接入。只有提供本机安装能力时才扩展 `packages/server/src/services/agent-cli/manifest.ts`。`USER_VISIBLE_AGENT_TYPES` 是公开可见性入口；Minion Code 保留历史 ID 解析，不重新加入创建选项或公开列表。不要为 ACP adapter 另造 Agent 身份。

## Parser、Projector 与快照

CLI 的 Claude Code、Cursor Agent、Codex、Gemini CLI 使用结构化 Parser（Gemini stream-json fixture 核实到 0.27.0）。ACP 的所有 Agent 走通用 Projector，ACP stdout 是协议流，不进入普通终端日志。

`OutputParser` 实现 `processData()`、`finish()`，可选逻辑完成/失败回调；`onPatch`/`onSessionId` 属于 MsgStore。Parser 缓冲不完整 frame，使用 `output/utils/patch.ts` 生成 RFC 6902 patch。Pipeline 先保存 raw stdout，再解析；捕获 parser 异常，退出/destroy 只 finish 一次，并在解除 patch listener 前 flush 残留输出。

ACP `tool_call_update` 是按 `toolCallId` 合并的局部更新，省略字段沿用旧值，显式 `null` 清除字段。保留工具的状态、输入输出、content/locations；运行时诊断不误计作用户工具调用，非阻塞诊断用警告日志。

ACP 帧和工具输出保持有界：帧预算统一取 Definition 的 `maxStdoutFrameBytes`（缺省 1 MiB），**原始行与 transform 后的重序列化帧共用同一预算**，不要在 ProcessManager 内另设常量卡口覆盖它。内联回传大工具结果的 adapter（base64 图片/音频）必须同时声明更大预算**和** `transformStdoutFrame`（`agents/tool-frame-normalizer.ts`）：只提高预算不生效，只做 transform 则大帧仍会撞默认上限。Projector 的 terminal delta 使用有界首尾预览。不要让完成事件重新把完整聚合输出塞回 snapshot。

MsgStore 的 patch `seq` 单调递增，restore 后继续计数；淘汰旧 patch 时折叠入 base snapshot。使用导出的 `sessionMsgStoreManager`。改 `NormalizedEntry` 时同时检查 `shared/log-adapter.ts`、前端日志/Todo/Token 与 `useNormalizedLogs` 的 seq-gap/reconnect 恢复。

`MsgStore.textBlocks` 在规范化提交处维护每轮/每子流的 assistant 正文身份及 OPEN/SEALED/ABORTED 生命周期，Parser/Projector 负责真实语义切换和显式完成信号。Coordinator 的共同 MsgStore listener 转发规范化 patch，并按 seq 忽略 Driver 重复转发；生命周期专用 metadata patch 不刷新 runtime 活跃时间或 TeamRun 心跳。原文摘要修订复用 blockId 并升 sourceRevision；ACP load 回放保留既有身份，回放新增历史不获得翻译 admission 标记。Claude CLI 的 parent_tool_use_id 和 ACP 的 _meta.claudeCode.parentToolUseId 隔离子流；没有协议 chunk ID 时不按内容去重 delta。

ACP 的 `metadata.acpTextIdentity` 持久保存原生 session/message 和子流，角色由 entryType 区分，与 canonical entry/block ID 独立；连续段及跨轮复用 ID 按出现次序关联。load 的 main `user_message_chunk` 结束所有投影子流的段，child 的用户边界只结束自身段；用户原文仍由本地日志负责，不因回放重复新增。reconciler 先为完整回放预留精确协议 occurrence 和旧 acp-message/thought ID，再执行内容兜底，避免更早的新增历史抢占后续已知身份。兜底游标按原生 session/子流隔离，只由语义匹配推进，精确关联不推进该游标（新增历史可能位于本地列表末尾）；保留真正的 ID 漂移恢复，不跨子流按相同内容关联。load 修订保留原 block 身份、升版本并去掉 admission 标记，不补翻历史。

Claude 已知旧 message 的完整摘要在 tracker 的历史修订作用域更新自身节点，不能推进当前流或清空新消息正文指针。普通 OPEN 正文 delta 只写 content；metadata 仅在生命周期或 admission 变化时更新，保持 MsgStore 的 replace 历史压缩。

正文块边界经 SessionManager 的同一 snapshot writer 持久化，随后 TranslationService 异步消费带 translationEpoch 的检查点。只有启用期间观察到的内容取得标记，静态历史不扫描；OPEN 尾段不外发。TextBlockTracker 用保护扫描器识别完整段落，将 UTF-16 结束位置和启用 epoch 写入 textBlock.paragraphs；不拆 provider entry 或改变原文。共享 getTranslationTextBlocks 投影独立 SEALED 段落及剩余尾段，已封口前缀修订推进父 sourceRevision 并撤段落边界，ACP 历史修订同样清除段落与资格。observer/翻译故障不能抛回 Parser/Driver，重启从持久标记补偿。译文只写 TranslationSource/Attempt，独立 translation:invalidated 通知和 owner overlay REST 提供展示/恢复，禁止将译文送回 session:patch、心跳或派活。任务/独立对话与 TeamRun 用户实际投递均接入 MessageDeliveryService，PUBLIC Agent 群消息沿持久资格登记展示来源；完整维护入口见 `docs/conversation-language-translation.md`。

翻译 claim 必须区分当前版本、已过期版本和真实删除。内存修订可能早于持久检查点；此时只取消旧版本，不能写 deletedAt，后续检查点仍更新同一 Source。只有来源身份消失或所属实体不可读才 tombstone。

`session:patch` 只标记快照 dirty，运行中低频 checkpoint；所有 Session 的快照和 external session ID 经串行 writer 写入，终态及替换边界等待强制 flush。保持相同快照去重，避免每个 patch 都写库或连续输出导致 debounce 永远不落盘。

## 针对性验证

从仓库根目录按改动选择对应命令；下列分组不是每次都要全跑。新增行为优先扩展邻近测试，跨层改动再按 `shared -> server -> web` 构建。

```bash
# Session 启停、重发、持久化；独立对话队列
pnpm exec vitest run packages/server/src/services/__tests__/session-manager.lifecycle.test.ts packages/server/src/services/__tests__/conversation.service.test.ts

# Runtime 协调与 Driver 生命周期
pnpm exec vitest run packages/server/src/runtime/__tests__/runtime-coordinator.test.ts packages/server/src/runtime/__tests__/acp-driver-lifecycle.test.ts packages/server/src/runtime/__tests__/cli-driver-lifecycle.test.ts

# 进程与退出清理
pnpm exec vitest run packages/server/src/runtime/__tests__/acp-process-manager.test.ts packages/server/src/runtime/__tests__/launch-cleanup-registry.test.ts packages/server/src/runtime/__tests__/shutdown-coordinator.test.ts

# 输出与历史；单个 parser 改动可只选其 output/__tests__ 文件
pnpm exec vitest run packages/server/src/pipeline/__tests__/agent-pipeline.test.ts packages/server/src/runtime/__tests__/acp-projector.test.ts packages/server/src/runtime/__tests__/acp-history-reconciler.test.ts packages/server/src/output/__tests__/msg-store-seq.test.ts packages/server/src/output/__tests__/msg-store-memory.test.ts

# Provider 投影与 Agent 支持
pnpm exec vitest run packages/server/src/services/__tests__/provider-config.service.test.ts packages/server/src/executors/__tests__/providers.test.ts packages/server/src/runtime/__tests__/acp-driver.test.ts packages/server/src/runtime/__tests__/acp-agent-definitions.test.ts packages/shared/src/__tests__/agent-runtime-support.test.ts

# 托管 MCP 启动配置
pnpm exec vitest run packages/server/src/services/mcp-config.service.test.ts
```

生命周期改动重点验证 early data/exit、启动失败、停止与重发并发、取消/权限失效、旧连接迟到事件、清理失败重试和 snapshot restore。Provider 改动验证有效连接、继承环境冲突和脱敏；用户可见行为变化同步 `packages/docs-site/docs/guide/sessions.md`、`packages/docs-site/docs/integrations/agent-providers.md` 或对应 API 文档。

## 用户投递 receipt 与执行队列

MessageDeliveryService 取得 DISPATCHING claim 后才允许 SessionManager start/send；用户日志保留 originalText 和稳定 `user:<deliveryId>`，Driver 收到转换后的正文及本地附件/规则。任务追问沿用取消/续跑，直接重试沿用 TaskService.retry，但副作用延后至门禁通过。

`InputSubmissionObserver` 只由实际输入传输调用：普通 CLI 使用 BaseExecutor raw duplex 的 child stdin write ACK；Claude native 包住初始化/权限之后的 user body write；Codex native 包住 turn/start 写 ACK（RPC response 不替代 ACK）；ACP 在真实 SDK NDJSON writable 的 session/prompt 帧下游 write 完成后确认。started、Model result、runTurn 返回、ConversationTurn RUNNING 均不证明已发送。raw EOF 由发送位置单独关闭，快速 result 不可再次 end stdin。

只有 receipt 确认事务冻结 actualSentText/SENT。写入和落库之间无法保证外部 exactly-once：WRITING 后失败或重启进入 DELIVERY_UNKNOWN，禁止自动重放。CLAIMED 且未触及输入写入的受控失败可重试；已 SENT 的执行失败只走原执行队列。ConversationTurn 始终由 SessionManager 唯一 pump 执行；取出后先等上一轮结束，再按 deliveryRevision claim；取消/关闭可撤销尚未 claim 的 ACCEPTED，恢复期间的 kick 必须保留。

验证入口：`services/__tests__/message-delivery.integration.test.ts`（临时 SQLite/受控 HTTP/实际 SessionManager→CLI），`runtime/__tests__/cli-driver-submission.test.ts`（真实 BaseExecutor/wrapper），`acp-driver-submission.test.ts`（真实 SDK），以及 Claude/Codex control 测试。测试中的长期 fixture 必须有 teardown。

claim 的 settle 闭包仅在输入传输结束后登记 generation 绑定补偿；确认与恢复落库连续失败时，worker 以退避和有界批次重试状态恢复到 UNKNOWN，不重新写正文，不扫描正常等待 ACK 的 DISPATCHING。异 runtime/turn/transport 的确认拒绝本身不能把正常 ACK 标记未知。Claude 图片分段及 Codex 图片提取必须保留文本的首尾空白、换行和片段间空白，不能 trim 后仍以未 trim 正文冻结 actualSentText。Codex 仅删除已接受为本地图片输入的具体 Markdown 匹配；远程/缺失图片引用和重复匹配之间的正文保持原样。

翻译 HTTP 的固定 system 格式协议负责告知上游逐字保留 opaque 保护占位符与边界；用户仍只配置一份共用翻译模板。该协议不能替代 restore 的严格结构校验，损坏的译文仍拒绝投递/展示。
