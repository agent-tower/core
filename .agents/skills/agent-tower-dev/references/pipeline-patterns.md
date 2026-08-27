# Pipeline、Executor 与 Parser

## 职责

```text
SessionManager -> RuntimeCoordinator -> CLI Driver -> Executor / PTY / AgentPipeline / Parser
                                     -> ACP Driver -> ACP Agent Registry -> Agent Definition
                                                   -> ACP SDK / adapter or native ACP CLI / Projector
                                     -> MsgStore / EventBus
```

- `SessionManager` 拥有 Session/Task/TeamRun 业务状态、环境组装、snapshot、auto-commit 和结束后处理，不持有 PTY/Pipeline。独立对话的后续消息先持久化为 `ConversationTurn`，接口返回 `202` 后由每个 Session 的 worker 按队列顺序串行交给 RuntimeCoordinator；稳定的用户 entry id 使崩溃重放幂等，服务重启需把 `RUNNING` turn 恢复为 `QUEUED`。
- `RuntimeCoordinator` 按 Tower session 隔离 DriverSession，维护单 active turn、turnId/sequence、权限状态、迟到事件过滤和可等待销毁。
- CLI Driver 选择 Executor，并拥有 PTY、AgentPipeline、Parser、early event 和真实 child 退出跟踪。
- 通用 ACP Driver 拥有 adapter/native ACP process、initialize、session new/load、prompt/cancel、权限响应和协议清理；ACP stdout 不进入普通日志。
- ACP ProcessManager 为每次 launch 记录 runtime instance、进程组/树身份和 birth/ownership marker；Unix 停止前必须通过 PID/PGID/birth identity 重新核验并确认所有 owned groups 退出（root 先退出也要覆盖 re-parented descendants），Windows 使用等价的 descendant tree kill。adapter/root `exited` 只记录退出码并把 owned-tree cleanup 置为待处理，不能单独确认整树退出；只有 ProcessManager 完成身份复验、终止和存活确认后才写 `CONFIRMED`。旧 transport 的 exit/cleanup 事件只能匹配同一 runtime instance，不能影响新 generation。
- ACP Provider 权限策略使用 `ASK` 与 `UNRESTRICTED`；旧 `AUTO_APPROVE` 只作兼容输入并规范化为 `UNRESTRICTED`。无限制优先由 Agent Definition 进入原生 full access/bypass/yolo/force 模式，Agent 广告缺少所需 mode 时显式失败；只有缺少原生全权限模式的 Agent 才由通用 Driver 自动响应工具权限，并优先选择不持久化的 `allow_once`。
- ACP Agent Registry 按 `AgentType` 选择 Definition；Definition 负责 Provider 投影、可执行文件/adapter 解析、可用性、Session metadata 与 Agent 专属 model/effort/mode 配置。新增 ACP Agent 不复制 Driver。
- 用户可见的稳定 ACP Definition 包含 Claude Code、Codex、Qwen Code、Gemini CLI、Cursor Agent、Kiro CLI、OpenCode、Pi Coding Agent 和 Grok Build。Minion Code 仅保留历史兼容：保留 `AgentType`、Definition 和 legacy 内置 Provider ID，供已有 Session/Provider 按 ID 解析，但不得加入用户创建选项、公开 Agent/Provider 列表、Provider capability 响应或公开文档。`AgentType` 表示身份，不能再为 adapter 另造 `PI_ACP` 一类身份；运行协议只由 `RuntimeType.ACP` 表达。
- Native ACP 客户端共用 Definition 工厂完成可执行文件解析、Provider 投影和 Session 配置。Claude Code 与 Codex 的 adapter 及兼容 Runtime 通过 server 的固定 adapter 依赖随 Agent Tower 发布，显式 executable env 有效时才覆盖内置 Runtime；Pi CLI 作为 server production dependency 发布，默认解析 server `node_modules/.bin/pi`，仅由有效的 `PI_CODING_AGENT_PATH`/`PI_PATH` 覆盖。Pi MCP 通过隔离 `PI_CODING_AGENT_DIR`、Pi settings 和 `pi-mcp-adapter` 接入，Minion MCP 通过隔离 `PYTHONPATH` bridge 接入。不要 patch 第三方 adapter，也不要写用户全局配置。
- Agent Tower 托管的 MCP 启动配置统一由 `mcp-config.service.ts` 生成；Route、ACP Driver 和 Agent Definition 不得自行按 `import.meta.url` 推断 entry。源码开发态使用 server 自带的绝对 `tsx` loader 运行 `src/mcp/index.ts`，编译 CLI 与桌面 runtime 使用各自 `dist/mcp/index.js`；每次启动必须注入当前服务实例的 URL 与 internal token，入口或实例地址缺失时显式失败，不能降级为空 MCP 列表或静默连接默认端口。
- Definition 创建的临时配置可能包含内部 MCP token，必须使用 `0700` 目录和 `0600` 文件，并把幂等 cleanup 交给 ACP Driver；启动/握手失败、正常 close 和进程意外退出都必须触发清理。
- ACP Driver 的辅助 launch cleanup 由独立 registry 持有 owner；每个 transport generation 单独登记，前三次立即失败后保留 callback 并按有上限的退避间隔持续重试，coordinator dispose 不得丢失旧 owner。只有 cleanup `CONFIRMED` 才能删除 owner；应用销毁边界 drain 后仍有 `PENDING`/`RUNNING`/`FAILED` owner 时必须保留 callback、状态和 retry timer，并让 `destroyAll()` 明确失败以阻止正常关闭。重复 destroy 复用进行中的清理、失败后可再次尝试，不能用永久 destroying 标记静默跳过。
- CLI Driver 的 `admissionClosed` 只禁止新 turn，不代表进程树已清理；重复或并发 `close()` 必须复用当前 promise，超时后保留同一 raw process-exit owner 并允许受控重试，只有真实 `processExitCompletion` 到达且同 generation 的 started/exit/tree-cleanup 事件已按序投递后才可 resolve success。逻辑 turn 完成但 wrapper 尚未退出时，owner 转入 pending cleanup 集合，允许后续 turn 继续但不得丢失 raw listener；关闭时必须同时 drain active 与 pending owners。PTY wrapper 的硬升级只能由 wrapper 对已知进程组/树执行（Unix detached group，Windows `taskkill /T /F` + descendant poll），owner 不得直接 SIGKILL wrapper；身份探测或 started 持久化失败也必须把 PTY owner 交给可重试 close，而不能解析为 SAFE_PRE_CHILD_FAILURE。应用级 shutdown coordinator 在 Fastify `app.close()` 失败或已 closed 后仍直接重试 SessionManager/RuntimeCoordinator，并用 referenced、有界退避 timer 保持宿主存活；未确认 owner 时不得 `process.exit`。
- CLI wrapper 的 tree cleanup confirmation 必须由父进程内存持有的 completion capability 标记；Agent child 不继承 channel/secret，但会继承仅用于归属发现的 ownership marker，不能据此伪造 completion。Unix `ps` 与 Windows PowerShell/CIM probe 使用 `CLEAN_EMPTY`、`ALIVE`、`PROBE_UNAVAILABLE`、`IDENTITY_INCOMPLETE` 三态/四态结果，只有成功且身份完整的 `CLEAN_EMPTY` 才能由 parent mark completion；probe 异常保留 owner/quarantine 并以有界退避恢复，不能用共享 tmp evidence 文件、TCP bearer secret 或 root exit 作为确认。
- Runtime/Agent 专属的 Provider 协议元数据与兼容 Header 放在 Definition 投影层，并合并用户自定义配置；通用 ACP Driver 不感知具体网关认证或来源标识。
- ACP 初始化后的显式认证通过 Agent Definition 的可选 capability/authenticate hook 执行；通用 Driver 只负责合并 capability 并调用 hook，不得按 AgentType 或凭证环境变量分支。Codex 官方 API Key 必须显式选择 `api-key`，简单 OpenAI-compatible 网关使用 adapter 的 `gateway` 认证，避免首次安装依赖已有 `CODEX_HOME` 登录态。
- Agent 专属 ACP session option 只能在对应 Definition 中按 bootstrap response 广告的 `configOptions` 设置，不能假设通用 ACP 都支持。Codex Fast 模式使用 `fast-mode` option；CLI Runtime 则使用 Codex `features.fast_mode`/`service_tier` 配置覆盖。
- Parser/ACP Projector 将输出转为 `NormalizedEntry` JSON Patch；MsgStore 生成统一 snapshot。
- ACP `tool_call_update` 是按 `toolCallId` 发送的局部更新；Projector 必须累计并合并工具状态，省略字段沿用旧值、显式 `null` 清除字段。保留 title/kind/status/content/locations/input/output 的结构化语义，不能用单次 update 重建并覆盖完整工具条目；ACP `pending` 也不等同于独立的 permission request。
- ACP adapter 可能用伪 `tool_call` 转发运行时诊断（例如 `mcp_startup.*`）；这类事件不计入用户工具调用，非阻塞失败应投影为警告日志并保留诊断内容，真正导致 turn/session 失败的错误仍使用错误日志。
- ACP stdout 的通用归一化后单帧上限保持 `1 MiB`。已知 adapter 若会把合法的大型工具输出重复塞入单帧，只能由对应 Agent Definition 声明更大的原始帧硬上限和结构化 frame transform，在进入通用 ACP SDK 前移除重复数据并生成有界预览；不得全局放宽、取消上限或 patch 第三方 adapter。terminal output delta 由 Projector 增量合并为固定大小的首尾预览，完成事件不得让 snapshot 再持有完整聚合输出。

DriverSession 可以跨 turn 保留协议连接和 external session id，但 MsgStore 是 turn-bound 资源，必须由 `runTurn` 注入。idle DriverSession 不得捕获 MsgStore，否则 SessionManager 释放 snapshot store 后，延迟 follow-up 会把输出写入失效对象并造成大对象常驻。

托管 Agent 的 workspace-service opaque credential 与 DriverSession/MCP transport 同生命周期：逻辑 turn 自然完成不撤销，CLI/ACP follow-up 继续使用原 credential；DriverSession dispose、显式 Session stop/delete、启动失败和 app destroy 必须撤销。显式 stop 因此会关闭 ACP DriverSession，后续 follow-up 通过持久化 external session id 重开连接并获得新 credential；sendMessage 为替换 active turn 做的健康 cancel 仍可复用连接。

ACP 协议违规、连接关闭或 adapter 进程退出会使当前 transport 不可复用，必须停止对应进程、执行 launch cleanup 并清空 session-ready 状态。DriverSession 本身可继续持有 external session id 与同生命周期 credential；下一次 turn 为新 child 分配独立 `runtimeInstanceId`，重新 initialize 并通过 `session/load` 恢复。旧 transport 的迟到 close/exit 不得清理新 transport。

ACP 在 sendMessage 替换 active turn 时先用 `session/cancel` 等待 prompt 收敛，健康 DriverSession 可供该 follow-up 复用；只有取消失败或超时才销毁连接。用户显式停止整个 Tower Session 时关闭 DriverSession，以便同步撤销其 credential。用户主动取消造成的 prompt rejection 不得投影为连接错误。同一 Tower Session 真正重连时，COMPLETED/FAILED/CANCELLED 且持有完整持久化 snapshot 的 follow-up 使用 context-only `session/resume`；若 Agent 不支持 resume，可回退 `session/load`，但不得导入其历史。RUNNING 等未完成状态使用 `session/load` 补齐可能未落盘的历史：回放先投影到临时 MsgStore，再按稳定 ACP entry ID 和有序内容语义与本地 snapshot 合并，以本轮新建 user message 为插入边界并保持本地 user message 权威，最后用单个 `/entries` replacement patch 提交，不能逐条追加回放事件。跨 Tower Session 只续接原生上下文时也使用 context-only resume，load fallback 同样不得导入旧历史。

`Session.status = RUNNING` 跟随逻辑 Runtime turn 启动，每次初始 prompt 和 follow-up 都必须在 `startTurn` 边界持久化；不能依赖 OS process `started`，因为 ACP 会跨 turn 复用同一进程。`Session.status` 也不能证明 child 从未生成或已经退出。每次可能 spawn 的 initial/follow-up turn 必须先原子写入 durable launch claim；只有完整 `ExecutionProcess` row、已验证的 transport reuse 或明确发生在 child 创建前的失败才能解析 claim。空 process 集合仅在明确 `NOT_STARTED` 或已解析的 `SAFE_PRE_CHILD_FAILURE` 下安全；claimed/unresolved、计数不一致和 process-row 写入窗口一律 quarantine。

`ExecutionProcess.cleanupState` 用 `ACTIVE` 表示当前 server generation 正常持有，dispose/root exit 开始 cleanup 时进入 `PENDING`，失败进入带有界退避时间的 `FAILED`，整棵 owned tree 经身份核验确认退出后才进入 `CONFIRMED`。新 generation 必须持久化 `runtimeInstanceId + pid + processGroupId + birthMarker + ownershipToken + launchClaimNumber`；任一 identity 缺失都进入 `QUARANTINED`，不得按裸 PID/PGID 发信号，也不得算 cleanup 成功。quarantine 由 heartbeat/startup 周期输出持久诊断并阻塞 admission，直到运维人员用外部核验得到的完整 ownership evidence 处置进程树并把该 generation 记录为 `CONFIRMED`。启动恢复可接管 `PENDING`/`FAILED`，也可接管没有当前内存 owner 的旧 `ACTIVE`；不得清理当前 generation 仍持有的 `ACTIVE` runtime。

Route 不直接 spawn PTY，Parser 不更新 Prisma 或 Task 状态。

## 启动与结束

spawn 与 Pipeline attach 之间存在竞态。保留 `collectEarlyPtyEvents()` / `takeEarlyEvents()` 一次性交接，否则短命进程可能丢失 exit 并永久停在 RUNNING。

Session 结束后的 DB 状态、snapshot、auto-commit、commit message、Task review 和 TeamRun reconciliation 由 SessionManager/Team services 负责。OS child 使用独立 `runtimeInstanceId` 记入 `ExecutionProcess`，真实退出才写 exitCode，不能把 turn completion 当作 process exit。修改结束路径时覆盖正常完成、非零退出、stop、启动失败、并发删除和 server shutdown。

`AgentType` 表示 Agent 身份，`RuntimeType` 表示 CLI/ACP 执行协议。Provider 选择两者，Session 创建时固化 Runtime；创建时必须通过 shared Runtime 支持矩阵校验，纯 ACP Agent 不得无 Provider 回退到 CLI。同一 Session follow-up 不允许跨 Runtime 切换。TeamRun 存活判断使用 `hasActiveTurn()`，`AWAITING_PERMISSION` 是活跃且由用户控制的等待，不触发 heartbeat nudge。

`session:patch` 只标记 snapshot dirty；运行中按低频 checkpoint 持久化，所有 session 的 snapshot DB 写入经单一串行 writer 排队，相同 snapshot 跳过。external session id 持久化也复用该 writer，避免与 snapshot update 倒序提交。COMPLETED/FAILED/CANCELLED、pipeline 替换等边界必须 `await` 强制 flush；不能恢复为每 patch 写库或不断重置的短 debounce。

Codex `exec --json` 的成功 `turn.completed` 是逻辑完成边界，不必继续等待包装进程退出。Pipeline 必须先保留 raw stdout、处理完该 frame 的最终消息/usage 并标记 MsgStore finished，再通知 SessionManager 持久化 `COMPLETED`；残留 PTY 只在后台短暂宽限后清理。`turn.failed` 同样是一次性的失败逻辑边界，必须优先于随后 0/undefined PTY exit，持久化 `FAILED` 且不得触发成功 auto-commit/Task review。逻辑完成后的 auto-commit 绑定 generation，并在 follow-up 开始前完成或放弃，不能与新轮 Git 操作重叠。`turn.failed`、用户 stop、非零提前退出仍走各自失败/取消路径，logical completion、PTY exit 与 destroy 竞争时只允许一次终态和一次 parser finish。

## AgentPipeline

`OutputParser` 至少实现 `processData(data)` 和 `finish(exitCode?)`；支持逻辑完成边界的 parser 可选提供一次性的 `onTurnCompleted(listener)` 或 `onTurnFailed(listener)`。`onPatch` / `onSessionId` 属于 MsgStore，不是 Parser 接口；Parser 构造时接收 MsgStore，Pipeline 监听这些 MsgStore 事件后发 EventBus。

保持以下不变量：

- raw stdout 先写入 MsgStore；parser 失败仍可恢复日志。
- 捕获 `processData`/`finish` 异常，不从 node-pty callback 抛出。
- exit/destroy 竞争时 `finish()` 只运行一次。
- destroy 先 flush parser，再解除 patch listener。
- 所有退出路径释放 listener、PTY 和 cancellation 资源。

## Executor

实现 `BaseExecutor` 时提供 `agentType`、`displayName`、`buildCommandBuilder()` 和 `getAvailabilityInfo()`；按能力覆盖 slash commands、capabilities、follow-up 和 MCP config path。基类 `spawnFollowUp()` 默认抛 unsupported。

使用 `CommandBuilder`、`ExecutionEnv` 和跨平台 PTY wrapper，不拼 shell 字符串。处理 Windows ConPTY、executable 解析、stdin 临时文件权限/清理。日志不记录完整 prompt 或 secret；credential 参数加入 redaction 测试。

Provider 是主要配置入口，profiles 只保留兼容。Executor factory 根据 `AgentType` 和 provider config 动态创建实例。

Provider 显式连接凭证必须在每次 spawn 时从当前 Provider 重新解析，并通过单次 executor 环境投影。投影时显式覆盖或屏蔽父进程中会抢优先级的旧认证变量；运行中的 child 保持启动快照，不热更新 env/args。

自定义 Provider 的动态 credential `env_key` 不得使用 ExecutionEnv 已保护的 Agent Tower subprocess、TeamRun/MCP identity 或 service env 名；resolver/normalization 必须在 probe/save/spawn 前返回字段诊断，不能放宽子进程环境过滤来允许覆盖内部变量。

## Parser 与 MsgStore

Claude Code、Cursor Agent、Codex 有结构化 parser；Gemini 当前保留 raw stdout。Parser 缓冲不完整 frame，使用 `output/utils/patch.ts` 生成 RFC 6902 patch，并在 finish 处理残留数据。不要按任意 PTY chunk 直接 `JSON.parse`，未知或坏 frame 不能阻断后续输出。

改变 `NormalizedEntry` 时同步 `shared/log-adapter.ts` 和前端 LogStream/Todo/Token。使用导出的 `sessionMsgStoreManager`，不存在公共 `SessionMsgStoreManager.getInstance()`。

MsgStore patch `seq` 单调递增，并在内存上限下把淘汰消息折叠进 base snapshot。修改时验证 seq/stale replace、memory cap、token/session/message id、snapshot restore/persist，以及前端 seq-gap 恢复。

## 新增 Agent

检查这些接触点：

1. shared `AgentType` 与公开类型。
2. shared Runtime 支持矩阵、Provider capability/default provider，以及 Provider UI 的 Agent + Runtime 组合。
3. CLI Agent 检查 executor、command config、factory/export 和 parser；ACP Agent 检查 Registry Definition、启动/可用性、Provider 投影、Session 配置和 Projector 特例。
4. 前端 agent meta、provider/model selector、logo 和 capability 展示。
5. slash command、skill/MCP config；只有纳入本机安装能力时才加入 CLI environment manifest，不能因支持 ACP 就假装支持安装。
6. shared/server/web 构建与公开 provider 文档。

测试覆盖 early data/exit、parser throw、重复 exit/destroy、spawn failure、cancel/follow-up 和 snapshot restore。
