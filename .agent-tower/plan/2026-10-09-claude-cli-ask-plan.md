# Claude CLI「请求批准（ASK）」接入方案

- 日期：2026-10-09
- 状态：方案；没有修改产品实现，没有启用 ASK。
- 代码基线：`836115dc2d20bc9031a732e69dd888b119587949`。
- 范围：仅 Claude Code / CLI / ASK。保留 CLI 身份、启动方式和原生会话，不切换为 ACP。
- 调查方式：只读代码、官方文档及已安装 SDK 发布源码；只运行 `--version`、`--help` 等无模型命令。没有启动模型、改动用户配置/数据库或操作现有测试服务。

## 1. 推荐结论，先用容易理解的方式说

Claude 本身已经有一条结构化的「向宿主询问权限」通道，官方 Agent SDK 就在使用它。Tower 需要把这条通道接到已有审批卡片上：

```text
Claude 原生权限检查
  → 确实需要人工批准时，发送带请求 ID 的 JSON
  → Tower 显示已有审批卡片
  → 用户选择本次批准 / 本次拒绝
  → Tower 将对应 JSON 回传给同一个 Claude 进程
  → Claude 决定后续执行及工具结果
```

推荐采用 **Claude 原生 stream-json 双向控制协议，配合 ASK 专用、持续开放的真实 stdin 管道**。保留现有 CLI Driver、Executor 和日志 Parser；复用审批 API、Socket 和 UI。

这项工作不只是加一个参数。当前 Tower 会把首条输入从临时文件送给 Claude，然后关闭 stdin；后续审批答复到不了这个 stdin。还必须接通请求的解析、答复和取消，并在原生 `result` 到达时正确收尾。

ASK 的含义继续是「遵循 Claude 原生按需审批」。原生已允许的读取、命令、规则或其他操作可以直接执行。Tower 不承诺每个工具都询问，不增加自己的风险分类器。

第一版只提供「本次批准」「本次拒绝」，不返回 `updatedPermissions`，不写入“永远允许”规则，也不增加输入修改、用户问答或计划确认功能。

## 2. 已核实的事实与证据边界

| 内容 | 本次核实结果 | 不能据此宣称的事情 |
| --- | --- | --- |
| 本机 CLI | `claude --version` 为 **2.1.293**；平台 **Darwin arm64**；安装的是系统 Claude Code 原生可执行文件 | 尚未完成该版本的真实审批往返 |
| 参数解析 | `--permission-mode default --permission-prompt-tool stdio --permission-prompts host --input-format stream-json --output-format stream-json --help` 返回 0 | `--help` 通过不证明实际启动、resume 和审批都生效 |
| `default` 与 `manual` | 官方 CLI reference：`manual` 是 `default` 的别名，2.1.200 起提供；帮助显示 `manual`，两者都接受 | 不能因帮助没有列出 `default` 就判定不支持 |
| 官方协议实现 | 仓库已安装官方 `@anthropic-ai/claude-agent-sdk` **0.3.207**，其元数据对应 Claude Code **2.1.207**；`sdk.mjs` 明确为 `canUseTool` 配置 `--permission-prompt-tool stdio`，处理 `control_request`、`control_response`、`control_cancel_request` | 不能把 SDK 的 2.1.207 协议实现当成本机 2.1.293 的真实运行验证；也不能假定所有旧版本或未来版本兼容 |
| 原生审批语义 | 官方权限文档说明：原生 allow/deny/mode 等先处理；剩余需要人工决定的调用才进入 `canUseTool` | callback 不是逐工具审批层，也不是所有宿主操作的隔离边界 |
| Tower 输入 | `BaseExecutor.spawnWithStdin()` 使用 `pipe-file` wrapper；wrapper 通过 `stdinStream.pipe(child.stdin)` 送文件，默认会结束 child stdin | `AgentPipeline.write()` 写入外层 PTY，不能补回已经关闭的 child stdin |
| Tower CLI 审批 | `CliDriverSession.capabilities.permissions = false`，没有 `resolvePermission()`；Claude Parser 忽略 control 消息 | 不能仅将 capability 改为 true 就启用 ASK |
| Tower 逻辑终态 | Claude Parser 处理 `result` 文本与 usage，但目前没有 `onTurnCompleted/onTurnFailed`；CLI 主要依赖进程退出结束 | 改成保持 stdin 开放后，若仍等待自然退出，会发生结果已出但 Tower 一直运行 |
| Tower 现有审批闭环 | Coordinator、DTO、REST、Socket、RuntimePermissionPrompt 已支持 ACP 的待审批状态和答复 | 能复用的是 Tower 端交互契约，不是把 Claude CLI 转成 ACP |

**版本要求建议：**以本机 2.1.293 作为首个验证基线；本次没有足够证据确定协议的最早可支持版本，因此不编造 `>=某版本` 的支持承诺。实现时建立经过验收的版本/平台范围，并检查实际解析到的 executable、版本和所需原生接口。未知组合先显示 `CAPABILITY_UNVERIFIED`。正式启动仍需有界的初始化/模式确认；失败后结束启动，不能回退到 FULL_ACCESS。

旧版本如具备已验证的 stdio 协议，可以另行纳入范围。`--permission-prompts host` 只在明确支持该参数的版本中投影；使用它时不得允许 `none` 覆盖。保留 `--permission-prompt-tool stdio`，这是已读官方 SDK 的直接实现依据。

## 3. 两种原生通道的取舍

| 通道 | 原生依据与可行性 | Tower 的代价/限制 | 建议 |
| --- | --- | --- | --- |
| **stdio 双向控制协议** | 官方 SDK 用 `--permission-prompt-tool stdio`；原生以 `can_use_tool` 请求，宿主返回 allow/deny；具有 request ID、取消消息及初始化控制请求 | 需要补齐持久 stdin、协议消息分流和结束处理；独立原始协议不是完整公开的版本化规范，需以已验证版本约束 | **推荐**。请求与发出请求的原生进程直接关联，契合现有 Coordinator |
| **命名 MCP permission prompt tool** | 官方 CLI reference 正式支持 `--permission-prompt-tool <MCP tool>`；CLI 等待该 MCP server 连接 | 要增加审批专用 MCP 工具及等待/取消桥，处理 MCP 配置、认证、连接超时；官方说明从 2.1.199 起，该 prompt tool 对标注需要用户交互的 MCP 工具返回 allow 仍会被转换成 deny | 可行备选，本次不作为首选；不能假定与 stdio host 的批准能力完全相同 |

`stdio` 在官方 SDK 中是这个参数的特殊宿主通道值，不是要求再创建一个名字叫 stdio 的普通 MCP 工具。两种机制不能混用；SDK 也明确拒绝同时配置 `canUseTool` 和另一个 permission prompt tool。

不推荐解析终端中的“Allow?”文本、自动输入 y/n、通过通用 Driver 自动 allow，或换成 Claude ACP。它们都不能完成本任务要求的原生 CLI 审批契约。

## 4. 最小可靠的实现结构

### 4.1 Executor 配置原生模式，Service 决定能否使用

沿用现有链路：

```text
SessionManager.startRuntimeTurn()
  → ExecutionPermissionService.authorize(providerSnapshot)
  → RuntimeOpenInput / RuntimeRunTurnInput.executionPermission = ASK
  → CLI Driver
  → ClaudeCodeExecutor 生成 default + stdio-host 参数
```

Provider 仍只保存 `executionPermission: ASK`；SessionManager 仍创建启动快照。CLI 每轮新进程使用本轮已授权快照。审批答复不重新从已被编辑的 Provider 推断实际模式。

ASK 启动应显式配置：

```text
-p
--permission-mode default
--permission-prompt-tool stdio
--permission-prompts host       # 已确认具备此参数的版本
--input-format stream-json
--output-format stream-json
--verbose
--include-partial-messages
--replay-user-messages
```

保留当前 `--disallowedTools=AskUserQuestion` 的产品限制，不在这次范围中新增问答功能。ASK 不新增沙箱配置，不关闭用户已有沙箱，也不把用户原生 allow/deny 规则删除。请求是否出现继续由原生决定。

配置及最终命令需要满足：

- 同一命令只生成一份规范权限投影；初始/续聊共用构建方法，删除 ASK 可达路径中旧 `plan/approvals → bypassPermissions` 的重复参数逻辑。当前 Service 已对 `plan/approvals=true` 返回冲突，继续保留该保护。
- ASK 不携带 `--dangerously-skip-permissions`，也不开放 bypass 切换参数；`permissions.defaultMode` 只接受与 default 等价的配置（包括已验证的 manual 别名）。其他模式返回 `CONFLICT`，而不是靠参数顺序覆盖。
- 校验原生设置、实际启动参数和旧 profile 的 `cmd.additionalParams`：不得覆盖 permission mode、permission prompt、input/output format，也不得通过额外 settings/config 路径隐藏冲突。
- 当前正常 Provider 工厂会重建 cmd，仅空 ID 的 legacy profile 保留命令覆盖；不能把尚不存在的正常 Provider 命令覆盖入口当成现状。两条现有路径都要检查最终 argv。
- `claudeCodeRouter` 和未知命令 wrapper 的 stdio-host 能力没有核实，首版 ASK 置灰。不是仅检查 PATH 中的 claude 就允许另一个实际命令运行。
- 保留当前认证、ANTHROPIC 环境合并、MCP service credential 和原生会话目录。不要改 HOME、覆盖用户全局配置或清除正常的工具许可规则。

### 4.2 输入必须成为真正可持续的管道

建议增加 **仅 Claude CLI ASK 使用的 `pipe-duplex` 启动方式**，保留外层 CLI wrapper 的现有进程归属、信号转发和整树 cleanup；无需引入 SDK 运行依赖或抽取/改名 ACP ProcessManager。

具体结构：

1. wrapper 内的 Claude child 使用 `stdin/stdout/stderr` 三条真实 pipe。
2. Tower 与 wrapper 通过本次启动私有的本地 IPC 通道收发管道数据（Unix domain socket / Windows named pipe）。IPC 只负责字节传输、写入确认和 EOF，不解释权限。
3. `SpawnedChild` 增加可选 duplex I/O handle：订阅 stdout/stderr、`writeStdin()`、`endStdin()` 和幂等 dispose。现有单次文件输入及普通 CLI 路径不改行为。
4. stdout 给现有 Claude Parser；stderr 单独形成有界诊断。Machine JSON 不经 ConPTY 行折叠，审批答复不经终端键盘输入。
5. 临时 endpoint/config 使用现有受限权限/清理惯例；每次启动独立且有连接归属校验，不把控制凭据或 endpoint 配置传进 Claude 子进程环境。连接失败、超时或断开都使本次启动失败并触发现有 cleanup。
6. 按顺序串行写入初始化、模式确认、用户消息和审批答复；真实 pipe 保留 backpressure。写入失败不报告“审批成功”，也不盲目重试可能已经送达的批准。

这比单纯把 `stdinStream.pipe()` 改为 `{end:false}` 多一些代码，但后者没有解决 Tower 如何写到 child stdin、PTY 回显/行长度、Windows JSON 折行、写入失败和 stderr 混入协议的问题。**不要将开放后的协议 stdin 直接暴露给现有 `session:input`。**

ASK Driver 的 `terminalInput=false`，`writeInput()` 在服务端拒绝/忽略外部任意输入；UI 隐藏输入不是保护本身。终端 resize 不能影响协议 pipe，可保持日志查看或单独禁用本模式的 resize。

### 4.3 原生控制协议放 Claude 专属模块

建议新增 `runtime/claude-cli-control.ts`，负责初始化控制消息、请求映射、答复序列化和取消。它不判断角色、不审阅命令风险、不自动允许请求。

Claude Parser 保持唯一 NDJSON 缓冲/分帧入口，通过可选回调把以下结构化消息交给该模块，继续把普通 system/assistant/user/result 消息写入原有 MsgStore：

- `control_request`：仅 `request.subtype === can_use_tool` 转换为本次范围的执行权限请求。
- `control_response`：匹配 Tower 发出的 initialize/set_permission_mode 等控制请求。
- `control_cancel_request`：使对应原生请求和 Tower 请求失效。
- `result`：先记录文本/错误/usage，再通知一次逻辑完成或失败。

消息按类型/schema 校验，有界缓存与帧大小，不靠标题、理由或命令文本判断权限类型。格式错误/未知控制请求返回明确协议错误或结束本轮，不能默默当作已经批准。读流不因等待用户答复而阻塞：继续消费取消、退出和其他请求。

原生请求示意（字段据已读 SDK 发布源码，2.1.293 仍待真实核对）：

```json
{"type":"control_request","request_id":"native-request","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"..."},"tool_use_id":"tool-use"}}
```

批准示意：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"native-request","response":{"behavior":"allow","updatedInput":{"command":"..."},"toolUseID":"tool-use"}}}
```

拒绝示意：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"native-request","response":{"behavior":"deny","message":"User denied this action","toolUseID":"tool-use"}}}
```

每帧末尾换行。用户正常拒绝仍是协议 `success`，不是 `control_response.error`。批准回传服务器保存的原始 input，不接受浏览器上传任意 `updatedInput`；仅回传本次 allow，不回传持久 permission updates。一次拒绝默认不加 `interrupt:true`，让 Claude 得知拒绝并决定是否换做法；停止会话则走单独的 stop/cancel 生命周期。

官方 SDK 类型还包含 `requires_user_interaction`，并规定这类工具不能用通用的一键批准/拒绝卡片替代真实交互。`AskUserQuestion` 继续禁用；其他这种请求或 `request_user_dialog` 不冒充执行权限请求，首版给出「此原生交互尚未支持」诊断并安全结束/取消该流程。未来如要支持问答/计划卡片，应另立范围。

## 5. 复用现有审批界面和 API

| 层 | 复用位置 | 必要调整 |
| --- | --- | --- |
| 共享 DTO | `packages/shared/src/types.ts`：`RuntimePermissionRequest/Option`、`RuntimeStateDto` | 保留 request/session/turn/tool ID 和 once allow/reject；可增加有界、脱敏的可选工具输入详情与原生说明字段，供用户了解所批准的动作 |
| Driver 契约 | `runtime/contracts.ts`：permission stream event、`DriverSession.resolvePermission()` | 不新建第二套审批 API；Claude CLI ASK 提供 resolver 和 conditional capability |
| 状态协调 | `runtime/runtime-coordinator.ts` | 复用 pendingPermissions、`AWAITING_PERMISSION`、代际过滤、失效与重连状态；加强异步答复期间的重复/取消检查 |
| Service | `services/session-manager.ts` | 复用 admission、快照和授权；答复前按实际启动 mode/context 复核现有部署策略 |
| REST | `routes/sessions.ts`：GET `/sessions/:id/runtime`，POST `/sessions/:id/permissions/:requestId/resolve` | 继续只接收 optionId；不存在/迟到/重复返回 409；如部署策略拒绝，保留 403，不能被现有通用 catch 转成 409 |
| Socket | `core/event-bus.ts`、`socket/socket-gateway.ts`、shared `socket/events.ts` | 复用 permission requested/invalidated、runtime state changed；无需发明 CLI 专属事件 |
| 前端 | `hooks/use-sessions.ts`、`components/agent/RuntimePermissionPrompt.tsx` | 继续 REST 状态恢复与 Socket 更新；保留本次批准/拒绝按钮，补工具详情/说明展示及 i18n（若 DTO 增补） |
| 页面 | `AgentSessionPanel`、`ConversationPage` | 已挂载审批组件；复用任务与独立对话，不做新权限入口 |

工具摘要优先使用原生 `title/description/display_name`，并显示明确的工具名称、命令/路径等用户需要判断的参数。脱敏和有界展示属于信息呈现，不是风险判断。不要只显示“Bash 需要批准”却藏掉待执行动作；长参数需要明确截断提示和有界详情，不把凭据输出到 UI。

Tower `requestId` 使用本次生成的 ID，内部映射到 `(turnId, runtimeInstanceId, nativeRequestId, toolUseId)`；不把 native ID 当跨进程全局 ID。重复原生通知按同一 generation 去重。完整 input/resolver 只在内存中保留，不进入 Provider、日志快照或数据库。

## 6. 启动、续聊和终止的具体处理

### 初始启动

1. Service 检查可用组合与现有部署 allowed modes，创建 ASK 快照；保持 durable launch claim 与 admission cancellation。
2. 建立本次私有 I/O，spawn wrapper/Claude，安装早期 stdout/exit 缓存与 owner。必须先挂消息处理，再发初始化和用户输入，避免很早出现的审批被丢掉。
3. 发送 `initialize` 控制请求并有界等待成功；不广告本次无法处理的 dialogs/hooks/SDK MCP 功能。
4. 以已验证协议发送 `set_permission_mode: default` 并等待原生确认，作为新建/恢复共用的模式应用步骤。检查可获得的 init/status 模式信息；不同版本的广告字段本次尚未真实核实。原生拒绝模式或无法确认应用时，启动失败。
5. 发布实际启动快照后，发送一条现有 `buildUserMessageNDJSON()` 用户消息；文本/图片内容仍采用原有构造。不追加 CLI argv prompt，不在首条消息后 EOF。
6. 原生审批到来时立即显示卡片并进入 `AWAITING_PERMISSION`；等待用户不算超时或空闲。初始化/写入需要超时，人的等待不采用相同短超时。

### 续聊、恢复、切换 Provider

- 继续现有 **每轮新 CLI 进程 + `--resume <externalSessionId>`**。不为了审批把它改成一条跨轮常驻 Claude 进程。
- 每轮都在 Service 重新取得本轮 Provider 快照和 ASK 授权，使用同一组 stdio/default 参数，并在恢复初始化后重设/确认 default，才发新用户消息。历史 FULL_ACCESS 原生会话不能仅凭 ID 被当作已受 ASK 控制。
- 若原生版本无法在 resume 时可靠重新配置权限，拒绝该恢复路径，明确要求新会话；不静默保留历史 bypass、不悄悄另开会话冒充续聊。
- 当前 CLI Driver 对标记为 pre-child 的 follow-up 失败可 fallback 到新启动。新增权限/协议/恢复配置错误必须保持明确诊断，不能被这个通用 fallback 吞掉；仅原有明确允许的新建语义才可继续。
- Provider 在运行中被编辑不改变当前进程快照；下一轮按最新配置重新授权。通过队列、TeamRun 或 MCP 进入的执行沿用已有 Service admission；本任务不新增身份/RBAC 系统。

### 批准 / 拒绝

- Coordinator 复核请求仍属于当前 Session/turn，option 确实提供；Service 复核本轮实际 mode 的部署授权，不能拿编辑后的 Provider 来扩大授权。
- Driver 在写入前再次检查 active runtime/generation、请求状态和 I/O 存活，用原子的 pending→responding 状态阻止两次答复。只把一次用户决定送到绑定的原生进程。
- 写入确认只意味着数据已交给原生 stdin，不代表工具已执行；实际结果由后续原生 tool_result 决定。写入确认后失效本次卡片；若还有请求，继续等待。
- native cancel/stop 与响应并发时按事件先后及 generation 判断；失效后不重放批准。传输是否送达不确定时结束该 transport并报告错误，不能重新发送 allow。

### 取消、退出、结果及迟到答复

- `control_cancel_request`：清掉两层 pending mapping，发送既有 invalidated/state 更新；对应按钮之后返回 409。
- Session stop、active turn 被新消息替换、启动 admission 取消：先禁止答复并使请求失效，再沿用现有 CLI cancel/wrapper 整树 cleanup。不要为了结束等待自动批准，也不要额外发“用户拒绝”冒充用户选择。
- 进程退出、管道断开、协议错误：失效所有当前请求，flush parser，按原有失败/退出规则终态；根进程 exit 与整树 cleanup 仍分别处理。
- 原生最终 `result`：先完成现有日志/usage，再通知一次成功或失败，关闭本轮 stdin，让原生自然结束；保留现有有界 stop/cleanup 后备。这是持久 stdin 接入的必需配套。
- 新一轮开始前必须满足现有清理门槛。旧进程的请求、exit、迟到 result 和 HTTP 答复不能修改新一轮。
- 浏览器断线/刷新不批准或取消请求；重连 GET runtime 恢复卡片。Tower 重启后内存 resolver 已不存在，不能从历史日志复活审批；按原有进程恢复/清理流程处理。
- 保留 onData/exit 的早期交接及 started 持久化屏障，新增 pipe stdout/stderr/断连也必须参与该交接。不得因为失败发生在 handshake 就把已经 spawn 的进程误标成“未创建 child”。

## 7. 能力与置灰行为

`ExecutionPermissionService.nativeSupport()` 当前统一拒绝所有 CLI ASK。实现后只对通过条件的 Claude CLI 添加例外；其他 Agent、Claude ACP 和 AUTO_SANDBOX 规则不改。

应复用一个 Claude CLI 通道能力结果，供 Provider 能力展示、保存/测试以及 Session admission 使用。实际 executable/版本检测采用有界无模型命令及缓存，不能在 UI render 时启动模型或用户配置中的未知 wrapper。

| 情况 | 原因/行为 |
| --- | --- |
| 本地缺 CLI、已知版本缺所需通道/参数 | `RUNTIME_MODE_UNSUPPORTED`，说明缺少可转发的原生 CLI 审批通道 |
| 版本、平台、router 或 command override 未验收 | `CAPABILITY_UNVERIFIED`，说明该实际组合尚未验证 |
| 原始设置/危险 flags 冲突 | `CONFLICT`，具体指出冲突字段；保存/启动拒绝 |
| 当前部署不允许 ASK | `POLICY_MODE_DENIED`，403 |
| 有能力但本次 handshake/模式确认/pipe 失败 | 稳定 runtime 启动错误，结束并 cleanup；不得换 FULL_ACCESS |

版本/可执行文件/影响启动的 Provider 配置变化使缓存失效。详情接口和能力接口应对同一组合返回一致结果；当前 options() 是同步静态结果，接入动态探测时需调整相邻调用，不能只在前端去掉置灰。沿用现有 reason code 即可，无需在本任务中建立完整 Agent 能力矩阵服务。

## 8. 预计改动文件

以下为实施时的预计清单，**本次未修改**：

| 文件/模块 | 工作 |
| --- | --- |
| `packages/server/src/executors/claude-code.executor.ts` | 统一命令构建；ASK 的 default/stdin-host 投影；初始和 resume 使用新 duplex 启动 |
| `packages/server/src/executors/base.executor.ts` | 可选 duplex spawn/handle，沿用 early events、owner、日志脱敏；原有单次路径保持原行为 |
| `packages/server/src/utils/process-launch.ts` | wrapper 增加限定的 pipe-duplex mode，保留进程身份与整树清理状态机 |
| `packages/server/src/utils/cli-duplex-channel.ts`（拟新增） | 私有本地 IPC、I/O framing、backpressure、断连/写入确认和清理；只负责传输 |
| `packages/server/src/runtime/claude-cli-control.ts`（拟新增） | Claude 原生控制请求、初始化、模式确认、pending mapping、once 答复、取消 |
| `packages/server/src/runtime/cli-driver.ts` | 条件 capability、resolvePermission、raw input 拒绝、每轮 owner 与 pending 生命周期 |
| `packages/server/src/runtime/cli-parser.ts`、`output/claude-code-parser.ts` | 可选 control callback，复用单一分帧；原生 result 逻辑终态 |
| `packages/server/src/pipeline/agent-pipeline.ts` | 可选 pipe stdout source/stderr 诊断；保留 PTY wrapper 的 stop/exit owner、finish 一次及早期交接 |
| `packages/server/src/services/execution-permission.service.ts`、`services/claude-cli-capabilities.service.ts`（拟新增） | Claude ASK 条件能力、配置冲突、同一探测结果复用；其余模式保持当前矩阵 |
| `packages/server/src/services/session-manager.ts`、`runtime/runtime-coordinator.ts` | 现有启动快照、回复前 mode 授权、异步答复失效竞态、早期启动模式展示 |
| `packages/server/src/routes/providers.ts`、`services/provider-config.service.ts` | 复用实际组合的能力/诊断；保持 Provider 备份与历史读取 |
| `packages/server/src/routes/sessions.ts` | 保留 resolve 路由；权限拒绝 403 与失效请求 409 区分 |
| `packages/shared/src/types.ts`、`packages/web/src/components/agent/RuntimePermissionPrompt.tsx`、相邻 i18n | 若现有 summary 不足，补可选、脱敏的动作详情；不增加另一套审批 DTO/API |
| 邻近测试、公开 `integrations/agent-providers.md` | 实施后增加回归和真实支持说明；实现指导在实施完成后同步，不能先宣称已支持 |

不需要新增数据库字段、迁移 Provider schema、改 Claude ACP Definition 或建立多用户模型。IPC 与控制协议是两个不同职责，不把它们做成通用“审批风险服务”。

## 9. 实施顺序与验收门槛

### 第一步：独立验证 native stdio 协议

使用临时仓库、独立 Claude 配置及本机 2.1.293，确认 initialize/default 配置、`can_use_tool` 与 once allow/deny、cancel、result、resume 的真实字段。先用无模型初始化探针；模型场景须在进入实施验证时另行明确执行，本次没有运行。

真实工具场景使用临时文件，无删除真实文件、外部发信或网络写操作。通过原生 ask 规则/未预批准的临时动作稳定触发审批，避免“没有请求”被误判为桥接成功。认证与必要凭据由验证环境提供，不修改现有用户测试数据。

此步失败则保留置灰及具体原因，不先开功能。2.1.207 的源码可供协议参考，但若要支持该版本须单独验证，不能代替 2.1.293 的检查。

### 第二步：接双向 I/O 与控制模块

以模拟 Claude 子进程完成：stdin 始终开放、初始化后才发送首条消息、任意分块/Unicode/长输入、multiple pending、stdout/stderr 分离、断连/backpressure、取消、早期退出和 cleanup。保留现有图片/长 prompt 不进 argv 的行为。

### 第三步：接既有审批闭环

补 Driver resolver、权限状态、原生 result 终态与一次答复保护；在 Service 沿用快照/授权。在页面显示动作及 once 按钮，通过现有 REST 和 Socket 完成往返。先验证 API，再进行短 UI smoke，不派发审查/测试成员。

### 第四步：满足验证后才开放 ASK

只对通过验收的实际 Claude CLI 组合去掉置灰；保留不支持/未验证原因。更新公开文档、支持记录及实施指导。是否进入实施由负责人根据本方案与用户决定，本次交付停在方案。

必验场景：

1. **基本闭环**：ASK 在临时动作执行前出现审批；批准一次后动作发生；拒绝后该动作没有发生，原生可解释拒绝或改做法。
2. **按需语义**：原生可直接允许的只读操作不被 Tower 额外询问；明确 deny 不出现虚假的可批准卡片。
3. **续聊/恢复**：ASK → ASK；旧 FULL_ACCESS 原生 session → 新 ASK；init/resume 后确认 default，否则明确失败。不存在已执行动作再询问的路径。
4. **并发答复**：双击、两个浏览器同时批准、批准/拒绝竞态，只回传一次；非法 option、另一 Session ID、旧 turn 返回 409。
5. **失效**：native cancel、Session stop、用户消息替换、进程退出、pipe 断开、迟到 HTTP/原生请求全部失效；新 generation 不受旧回调影响。
6. **重连**：浏览器断线/刷新恢复 pending；Tower 重启后不从快照恢复过期 resolver。
7. **授权**：注入现有禁用 ASK 策略，保存/启动不能绕过；答复前策略收紧返回 403，不发送 allow。该测试不声称新增多用户治理。
8. **配置冲突**：dangerous flags、mode、host/none、legacy plan/approvals、additional settings、router/未知 executable，明确拒绝/置灰；不受参数先后顺序影响。
9. **输入绕过**：直接调用 session:input 发送伪造 control_response 无法写入 ASK child stdin；终端 resize 不破坏协议。
10. **终态与清理**：result 后 UI 正确结束并保存 usage，stdin EOF 后原生退出；失败 result/非零 exit/挂起后代正确处理；所有临时文件/endpoint 和整树 owner 回收，cleanup 未确认时不准开 replacement。
11. **交互边界**：requires_user_interaction / AskUserQuestion / request_user_dialog 不被普通批准按钮冒充；给出具体限制且没有自动允许。
12. **兼容与范围**：已有 FULL_ACCESS、Claude ACP、其他 CLI 的 launch/input/finish 不回归；旧 unrestricted/危险 true 仍为 FULL_ACCESS，不自动改成 ASK。

实现后的验证命令按受影响范围执行，重点是现有 `claude-code.executor.test.ts`、`stdin-prompt.executors.test.ts`、`cli-driver-lifecycle.test.ts`、`runtime-coordinator.test.ts`、`agent-pipeline.test.ts`、`execution-permission.service.test.ts` 与新增 control/channel 回归；构建顺序 `shared → server → web`。本次方案不运行产品测试或构建，不启动长期 dev server。

## 10. 日志、兼容及剩余风险

**日志：**审批控制消息不得混进 assistant/tool 文本、token usage 或历史 MsgStore；诊断只记 session/turn/runtime/request 关联 ID、工具名、传输状态和用户选择。完整 input、更新后的输入、IPC 认证材料不记进 stdout/PTY debug/error excerpt。当前 BaseExecutor 有原始 PTY 预览日志，ASK pipe 分支必须避免复用它来输出完整控制帧。用户可见动作详情需独立脱敏；只有后续原生 tool_result 才代表执行结果。

**兼容：**不批量改旧 Provider 或原生全局配置；旧 FULL_ACCESS 保持现有语义，已有 ASK 失效配置在组合通过验证后可显式使用；不由能力变化自动改模式。新 control callback/duplex source 为可选扩展，其他 Parser 和单次 CLI 输入保持原方式。历史日志可读，但不反推旧审批、更不复活 pending。resume 必须覆盖并确认旧模式。

**尚未验证：**真实模型审批往返、本机 2.1.293 的初始化/恢复模式字段、取消竞态、后台子任务与 result/EOF 的关系、Windows/Linux、Electron 打包 Node/IPC、router/custom wrapper。官方 SDK 参考版本与本机 native 版本不同，更新后应重验。

**保留的原生边界：**用户规则、组织强制 deny/ask、hooks、插件、MCP 和特殊工具交互仍由 Claude 决定。default 不是宿主资源隔离；本次不保证所有插件/宿主操作逐一审批，不实现完整问答/计划流程，也不解决多用户资源治理。若原生某类强制交互无法通过本通道正确表达，应明确限制该组合/流程，不能自动允许或宣称所有审批已完善。

**主要代价：**新双向 I/O 是最大的工程量；选它是为了避免将协议控制依赖于终端行为。原生协议仍有演进风险，所以先验证一个版本/平台的纵向闭环，再开放 ASK；任何验证失败都保持失效状态和具体原因。

## 11. 官方依据与本地定位

官方页面于 2026-10-09 读取：

- [CLI reference](https://code.claude.com/docs/en/cli-reference)：default/manual 别名、permission prompt tool、host/none、stream-json 和 resume。
- [Permissions](https://code.claude.com/docs/en/permissions)：原生按需规则。
- [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)：原生权限决策顺序与 callback 边界。
- [Agent SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input)：canUseTool、allow/deny、取消及问答区别。
- 官方发布包 [sdk.mjs 0.3.207](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.207/sdk.mjs) 与 [sdk.d.ts 0.3.207](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.207/sdk.d.ts)：本次直接阅读本地安装副本；确认 stdio 参数、控制消息、PermissionResult、requires_user_interaction、result 后 endInput。
- 官方 Python SDK [query.py](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)：作为交叉依据，确认控制消息响应与取消不回传；main 为易变参考，不能充当固定版本验收记录。

本地核心定位：`ClaudeCodeExecutor.spawn/spawnFollowUp`，`BaseExecutor.spawnWithStdin`，`process-launch.ts` 的 `pipe-file`，`CliDriverSession.attachSpawnedTurn`，`ClaudeCodeParser.handleMessage/handleResultMessage`，`RuntimeCoordinator.resolvePermission/createSink`，`SessionManager.startRuntimeTurn/resolveRuntimePermission`。产品实现与实施指导均未在本次更改。
