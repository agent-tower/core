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

CLI spawn 与 Pipeline attach 之间保留 `collectEarlyPtyEvents()` / `takeEarlyEvents()` 一次性交接，短命进程的 data/exit 不能丢失。Codex CLI `turn.completed` / `turn.failed` 是独立的逻辑终态：先处理最终消息与 usage、标记 store finished，再报告结果；后来到达的 PTY exit 不能把失败改为成功。Parser finish 与终态通知均只执行一次。

终态 DB、快照、auto-commit、commit message 和任务推进由 SessionManager/Team services 处理。auto-commit 绑定 Session generation，follow-up 在其完成或放弃后再启动，避免旧轮 Git 操作与新轮重叠。

### 进程与资源

- 每次可能 spawn 前先写 durable launch claim，再用持久 `ExecutionProcess`、已验证的 transport 复用或明确的创建 child 前失败来解析 claim。`Session.status` 和空进程列表本身都不能证明未启动或已清理；不完整/未解析证据交给 `session-runtime-cleanup-gate.ts`，不能猜测成功。
- 进程记录关联 `runtimeInstanceId`、launch claim、PID/进程组、birth marker 和 ownership token。清理前核验身份，覆盖根进程退出后仍存活的后代；根 exit 只记录退出结果，整树确认另走 `tree_cleanup_completed`。身份缺失或探测失败保留 quarantine/诊断，不能按裸 PID 发信号。
- `close()`/dispose 必须可等待、并发复用且失败后可重试。CLI 保留 active 与 pending cleanup 的真实退出 owner；ACP 保留各 transport 的 ProcessManager 和临时配置 cleanup owner。超时、DB 写失败或禁用新轮都不等于清理成功。
- CLI wrapper 的整树完成证据由父进程持有的能力确认；子进程继承的 ownership marker 仅用于归属发现。沿用 `utils/process-launch.ts`、`tree-cleanup-channel.ts` 和平台进程身份工具，不通过直接杀 wrapper 绕过整树回收。
- 恢复可处理没有当前内存 owner 的旧进程，不能清理仍由当前 runtime 持有的进程。TeamRun 下一项 admission、锁释放与 review 使用统一 cleanup gate，具体业务规则见 TeamRun reference。
- 应用关闭经 `runtime/shutdown-coordinator.ts`、`server-entry-shutdown.ts` 与桌面 shutdown 入口等待并重试清理。未确认 owner 必须保留可重试状态并报告失败，不能静默丢弃或提前 `process.exit`。

托管 Agent 的 opaque API credential 绑定 Session 身份并随 DriverSession/MCP transport 生命周期复用。自然 turn 完成不撤销；显式 stop、dispose、启动失败和应用销毁会撤销。后续重开连接签发新凭据，避免旧 Agent 仍可调用 workspace 服务。入口是 `utils/agent-api-credential.ts` 与 SessionManager 的环境注入。

## Provider 与 Agent 扩展

### 配置入口

Provider 是主要配置入口，profiles 保留兼容。`providers.ts` 合并内置默认与用户配置；`provider-config.service.ts` 负责 draft 归一化、简单/高级映射、冲突诊断和 secret 遮蔽；`provider-effective-connection.service.ts` 统一连接来源及认证解析。编辑、测试和运行配置应复用这些入口，避免各自解释 env/settings 优先级。其返回的 `secret` 只用于服务端，不能直接序列化或打印。

CLI Executor factory 为每次启动生成配置，ACP Definition 将 Provider 投影为 profile/launch spec。显式连接配置应覆盖或移除继承环境中会抢优先级的旧认证变量；已运行 child 保持启动快照，切换配置需要新的启动边界。动态 credential `env_key` 不能占用 `ExecutionEnv` 保护的 Agent Tower、TeamRun 或 MCP 环境变量。

Agent 专属配置使用结构化解析：Codex TOML、Claude JSON 及现有标准工具。保留用户未覆盖的字段；协议 header、认证方式、model/effort/fast-mode 和原生权限配置放在对应 Executor/Definition。比如 Codex 官方 API key 与兼容网关的 ACP authentication hook 不应变成通用 Driver 的 AgentType 分支。

### CLI 与 ACP

- CLI 扩展实现 `BaseExecutor` 的身份、命令与可用性入口，通过 `CommandBuilder`、`ExecutionEnv` 和现有 PTY wrapper 启动；follow-up、slash commands、MCP 路径按 Agent 能力扩展。保留 Windows ConPTY、stdin 临时文件权限与清理、日志脱敏。
- ACP 扩展实现 `AcpAgentDefinition` 并注册到 `agents/registry.ts`；原生 ACP Agent 优先参考 `native-agent.ts`。Definition 负责 launch、Provider 投影、可用性、认证与会话配置，通用 Driver 负责 ACP 生命周期。专属 session option 依据 bootstrap 广告的 capability/configOptions 设置。
- ACP 权限标准为 `ASK` / `UNRESTRICTED`，旧 `AUTO_APPROVE` 由 shared 兼容归一化。Definition 配置原生全权限模式；通用权限请求处理优先 `allow_once`。权限请求是独立协议事件，不能从 tool 的 `pending` 状态推断；结束/取消后使旧请求失效。
- adapter、可执行文件覆盖及打包解析参考相邻 Definition 和 `agents/executable-resolution.ts`。随包发行的 adapter 由 server production dependencies 管理；不要 patch 第三方 adapter 或写用户全局配置来实现单次会话隔离。
- Codex ACP 启动与可用性检测共用系统优先的解析规则：自动查找系统 `codex`，仅在未找到时使用内置 Runtime；查找时排除项目 `node_modules/.bin` 与相对 PATH 目录，不改变 Agent 工具执行时的原始 PATH。`CODEX_PATH` 是 Tower 根据检测结果写入或清除的 adapter 参数，不再作为用户选择 Runtime 的入口；系统 Codex 启动失败不自动重试内置版本。
- 托管 MCP 命令由 `services/mcp-config.service.ts` 统一解析开发源码、编译 CLI 和桌面入口，并注入当前服务 URL。存在 session credential 时传递该凭据，否则才使用 internal token；缺入口或实例信息时显式失败，不猜默认端口。
- Definition 创建的敏感临时配置使用 `managed-directory.ts` 的隔离目录和受限权限，并将幂等 cleanup 交给 Driver；启动失败、transport reset 和 close 都须回收。Pi 的隔离配置/adapter 与历史 Minion bridge 属于对应 Definition。

新增 Agent 时按受影响功能检查 shared `AgentType`/支持矩阵/Provider capabilities/default providers、CLI factory/parser 或 ACP registry、前端 `lib/agent-meta.ts`/Provider 选择器/图标，以及 slash command/skill/MCP 接入。只有提供本机安装能力时才扩展 `packages/server/src/services/agent-cli/manifest.ts`。`USER_VISIBLE_AGENT_TYPES` 是公开可见性入口；Minion Code 保留历史 ID 解析，不重新加入创建选项或公开列表。不要为 ACP adapter 另造 Agent 身份。

## Parser、Projector 与快照

CLI 的 Claude Code、Cursor Agent、Codex 使用结构化 Parser；Gemini CLI 保留 raw stdout。ACP 的所有 Agent 走通用 Projector，ACP stdout 是协议流，不进入普通终端日志。

`OutputParser` 实现 `processData()`、`finish()`，可选逻辑完成/失败回调；`onPatch`/`onSessionId` 属于 MsgStore。Parser 缓冲不完整 frame，使用 `output/utils/patch.ts` 生成 RFC 6902 patch。Pipeline 先保存 raw stdout，再解析；捕获 parser 异常，退出/destroy 只 finish 一次，并在解除 patch listener 前 flush 残留输出。

ACP `tool_call_update` 是按 `toolCallId` 合并的局部更新，省略字段沿用旧值，显式 `null` 清除字段。保留工具的状态、输入输出、content/locations；运行时诊断不误计作用户工具调用，非阻塞诊断用警告日志。

ACP 帧和工具输出保持有界：通用 ProcessManager 保留归一化帧上限，Agent 专属大帧问题由 Definition 的原始帧限制及结构化 transform 处理；Projector 的 terminal delta 使用有界首尾预览。不要让完成事件重新把完整聚合输出塞回 snapshot。

MsgStore 的 patch `seq` 单调递增，restore 后继续计数；淘汰旧 patch 时折叠入 base snapshot。使用导出的 `sessionMsgStoreManager`。改 `NormalizedEntry` 时同时检查 `shared/log-adapter.ts`、前端日志/Todo/Token 与 `useNormalizedLogs` 的 seq-gap/reconnect 恢复。

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
