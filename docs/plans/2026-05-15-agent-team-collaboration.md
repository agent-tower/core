# 多 Agent 团队协作功能计划

**日期：** 2026-05-15

**目标：** 为 Agent Tower 设计 `TeamRun` 模式，让用户可以为一个任务配置一组 AI Agent 成员，只提出需求后，由 Agent 团队通过共享房间自动协作完成工作。用户负责选择合适的 Agent、Provider、工具权限、提示词、运行模式和成员能力边界；Agent Tower 负责提供房间消息、成员预设、触发调度、MCP 通信、workspace/session 执行管线和可观测 UI。

---

## 1. 产品方向

Agent Tower 的任务执行应支持两种模式：

- **Solo 模式：** 保留现有体验。一个任务启动一个 Agent session，任务主区域展示日志/对话流水。
- **TeamRun 模式：** 一个任务拥有一个团队房间。默认主视图展示 `RoomMessage`，而不是原始 Agent 日志。某个 Agent 的日志只作为某次 invocation 的详情查看。

TeamRun 不是固定流程工作流，而是一套自动运行的 Agent 团队系统。用户可以创建：

- 只有一个实现者的团队
- 没有 Leader 的多个程序员团队
- 一个 Leader 加多个实现/审查/测试成员的团队
- 任意用户自定义组合

是否配置 Leader、团队能否高质量跑起来，是用户配置的结果。Agent Tower 不强制补一个项目主管，也不强制某种流程。

## 2. 核心原则

### 2.1 RoomMessage 必须存在

`RoomMessage` 是 TeamRun 的主协作记录，必须持久化。

它记录团队级语义，例如：

- 用户需求
- Agent 之间的派活请求
- 有意义的 Agent 工作结果
- 决策
- 产物
- 对用户和其他 Agent 有价值的系统事件

它不应该记录噪声，例如：

- 原始 stdout
- 命令日志
- 临时失败状态
- “我还在工作”
- “我出错了但没有结论”

这类过程信息应显示在 Agent 状态或 invocation 详情里，不进入 Team Room，避免污染其他 Agent 的上下文。

### 2.2 TeamRun 默认展示群消息

TeamRun 模式下，现有日志流水区域改为展示 Room timeline。

如果某个 Agent 正在工作，Room 中可以显示紧凑状态：

```text
Implementer is working... [查看详情]
```

点击详情后再查看该 Agent invocation 对应的 session 日志、token、diff、命令输出等细节。

### 2.3 Agent 通过 Agent Tower 间接通信

Agent 之间不直接互相调用。所有通信都经过 Agent Tower：

```text
Agent A
  -> MCP tool
  -> Agent Tower backend
  -> RoomMessage / WorkRequest
  -> Scheduler
  -> Agent B invocation/session
```

这样可以统一处理：

- 消息持久化
- 调度
- 权限能力
- UI 展示
- 状态恢复
- Result Hook
- 队列和取消

### 2.4 不定死流程

系统不硬编码：

```text
architect -> implementer -> reviewer -> tester
```

实际流程由 RoomMessage 和 `@` 触发机制驱动：

- 用户可以 @ 某个成员
- Agent 可以 @ 其他成员
- Leader 可以 @ Implementer 干活
- Implementer 可以 @ Reviewer 审查
- Reviewer 可以 @ Implementer 修复

Agent Tower 只负责把结构化 mention 转成 `WorkRequest` 并调度执行。

### 2.5 提示词完全由用户负责

Agent Tower 暂时不自动注入默认运行协议 prompt。

用户负责在成员模板或团队模板中写清楚：

- Leader 如何拆任务
- Implementer 如何实现
- Reviewer 如何审查
- Tester 如何测试
- Agent 完成或需要回应团队时是否需要向 Room 发送消息
- Agent 是否可以 @ 其他成员

Agent Tower 可以后续在 UI 中提供可选提示词示例，但不默认注入。

## 3. 核心对象

推荐概念模型：

```text
Task
  -> TeamRun
      -> TeamMember
      -> RoomMessage
      -> WorkRequest
      -> AgentInvocation
      -> Workspace
      -> Session
```

现有 `Workspace` 和 `Session` 应尽量复用。当前数据库已经允许一个 Task 下存在多个 Workspace，一个 Workspace 下存在多个 Session，但 TeamRun 需要新的协作层对象。

## 4. 成员预设与运行时成员

### 4.1 区分模板和运行快照

需要区分三个概念：

```text
MemberPreset  // 设置页中的可复用成员模板
TeamTemplate  // 一组成员预设组成的可选快捷团队模板
TeamMember    // 某次 TeamRun 中复制出来的成员快照
```

`MemberPreset` 在设置页配置。创建 TeamRun 时，从 preset 或 template 复制出 `TeamMember` 快照。

这样可以保证历史任务稳定：以后修改全局 Reviewer 模板，不会改变旧 TeamRun 中 Reviewer 当时的 provider、prompt、capabilities 和 workspacePolicy。

`TeamTemplate` 只是为了快速生成团队，不是创建 TeamRun 的必选项。创建 TeamRun 时应支持：

- 从 TeamTemplate 快速生成成员列表
- 临时选择多个 MemberPreset 组成团队
- 手动添加或编辑本次 TeamRun 的成员配置

### 4.2 MemberPreset 字段

建议字段：

```ts
MemberPreset {
  id: string
  name: string
  aliases: string[]
  providerId: string
  rolePrompt: string
  capabilities: TeamMemberCapabilities
  workspacePolicy: WorkspacePolicy
  triggerPolicy: TeamMemberTriggerPolicy
  createdAt: string
  updatedAt: string
}
```

`aliases` 用于 mention 和展示，例如：

```text
@leader
@architect
@implementer
@reviewer
@tester
@架构师
```

### 4.3 TeamMember 快照字段

建议字段：

```ts
TeamMember {
  id: string
  teamRunId: string
  presetId?: string | null
  name: string
  aliases: string[]
  providerId: string
  rolePrompt: string
  capabilities: TeamMemberCapabilities
  workspacePolicy: WorkspacePolicy
  triggerPolicy: TeamMemberTriggerPolicy
  status: TeamMemberStatus
  createdAt: string
  updatedAt: string
}
```

`rolePrompt`、`capabilities`、`workspacePolicy` 和 `triggerPolicy` 在创建 TeamRun 时复制。用户可以为单次 TeamRun 临时修改，不影响全局 preset。

## 5. Capabilities 与 WorkspacePolicy

### 5.1 Capabilities

`TeamMember.capabilities` 定义这个成员允许或预期能做什么。

建议结构：

```ts
TeamMemberCapabilities {
  readRoom: boolean
  postRoomMessage: boolean
  mentionMembers: boolean
  stopMemberWork: boolean
  markReadyForReview: boolean
  readFiles: boolean
  writeFiles: boolean
  runCommands: boolean
  readDiff: boolean
  mergeWorkspace: boolean
}
```

示例：

```text
Leader
- readRoom
- postRoomMessage
- mentionMembers
- stopMemberWork
- markReadyForReview
- 可以没有 workspace 访问能力

Architect
- readRoom
- postRoomMessage
- mentionMembers
- readFiles
- readDiff
- 默认不 writeFiles

Implementer
- readRoom
- postRoomMessage
- readFiles
- writeFiles
- runCommands
- readDiff

Reviewer
- readRoom
- postRoomMessage
- mentionMembers
- readFiles
- runCommands
- readDiff
- 默认不 writeFiles，除非用户显式配置
```

这些能力应在成员模板中配置，并复制到 TeamMember 快照。

第一版可以主要在 MCP 工具层做能力控制，并通过用户配置的 prompt 告知 Agent。完整 OS 级沙箱不是第一版目标。

### 5.2 WorkspacePolicy

`workspacePolicy` 定义这个成员在哪里工作。

建议值：

```ts
type WorkspacePolicy = 'none' | 'shared' | 'dedicated'
```

含义：

- `none`：不需要代码工作区。适合 Leader、规划、讨论、总结类 Agent。
- `shared`：使用 TeamRun 的共享 workspace。适合第一版实现、审查、测试。
- `dedicated`：为成员或 invocation 创建独立 workspace。适合未来并行开发，但需要后续设计集成/合并机制。

第一版建议至少支持：

```text
none
shared
```

`dedicated` 可以先在模型中预留，但自动集成策略后续再设计。

## 6. TeamRun 运行模式

TeamRun 支持两种模式：

```ts
type TeamRunMode = 'CONFIRM' | 'AUTO'
```

### 6.1 Confirm 模式

Confirm 模式用于调试团队配置和提示词。

流程：

```text
RoomMessage / MCP request
  -> WorkRequest(PENDING_APPROVAL)
  -> 用户查看目标成员、prompt、provider、capabilities、workspacePolicy
  -> 用户 approve / reject / edit
  -> 批准后启动 AgentInvocation
```

这个模式方便用户检查每次 Agent 被唤醒前到底会收到什么上下文和指令。

### 6.2 Auto 模式

Auto 模式用于自动运行。

流程：

```text
RoomMessage / MCP request
  -> WorkRequest(QUEUED)
  -> Scheduler 自动启动 invocation
```

Auto 模式不应该额外加“写权限也必须人工确认”之类产品限制。成员是否有写权限，已经由 `capabilities` 和 `workspacePolicy` 决定。如果用户配置了某个成员可以写文件并处于 Auto 模式，那么它被请求时就可以自动运行。

系统仍然需要运行时一致性规则，例如：

- 同一个 invocation 不应重复启动
- 已取消 invocation 不应继续写结果
- 用户可以停止 TeamRun
- no-room-reply reminder 不应无限循环

这些是状态一致性，不是对 Auto 模式的产品限制。

## 6.3 成员触发策略

普通 Agent 不应该监听所有未 @ 的群消息。它们默认只响应明确分配给自己的工作。

公司群类比：

- 老板在群里直接说一句话，普通工作者从工作的角度不一定需要响应。
- 如果老板 @ 某个人，这个人才需要处理。
- 如果团队里有项目经理/Leader，Leader 可以负责监听老板的普通消息，再分配给其他人。

因此不应硬编码“Leader 类型”，而应在成员上配置触发策略：

```ts
type TeamMemberTriggerPolicy =
  | 'MENTION_ONLY'
  | 'USER_MESSAGES'
```

含义：

- `MENTION_ONLY`：默认策略。只有被结构化 @ 指向时，才创建 WorkRequest。
- `USER_MESSAGES`：监听用户发送的未 @ 消息。适合 Leader、Dispatcher、Manager 这类成员。

第一版不建议支持 `ALL_ROOM_MESSAGES`，因为这可能让 Leader 或其他成员对每条 Agent 结果自动反应，容易形成循环。Agent 如果需要 Leader 介入，应明确 @leader。

触发规则：

```text
用户消息有 @
  -> 给被 @ 的成员创建 WorkRequest

用户消息无 @
  -> 给 triggerPolicy = USER_MESSAGES 的成员创建 WorkRequest
  -> 如果没有这样的成员，只记录 RoomMessage

Agent 消息有 @
  -> 给被 @ 的成员创建 WorkRequest

Agent 消息无 @
  -> 只记录 RoomMessage，不触发任何成员
```

这使普通成员保持“只处理明确分配给我的工作”，同时允许用户配置一个 Leader 自动接收老板的普通需求。

## 7. RoomMessage

### 7.1 用途

`RoomMessage` 是 TeamRun 的主时间线和协作历史，用户和 Agent 都可以读取。

建议字段：

```ts
RoomMessage {
  id: string
  teamRunId: string
  senderType: 'user' | 'agent' | 'system'
  senderId?: string | null
  senderInvocationId?: string | null
  kind: RoomMessageKind
  content: string
  mentions: string[]
  workRequestIds?: string[]
  artifactRefs?: string[]
  attachmentIds?: string[]
  createdAt: string
}
```

建议类型：

```ts
type RoomMessageKind =
  | 'chat'
  | 'work_request'
  | 'work_started'
  | 'artifact'
  | 'review'
  | 'decision'
  | 'system'
```

### 7.2 Mention 需要结构化

`@` 不应只靠文本解析。前端或 MCP 调用方应发送结构化 mentions。

示例：

```json
{
  "content": "@reviewer 请审查当前 diff",
  "mentions": ["team_member_reviewer"],
  "kind": "work_request"
}
```

文本用于展示，`mentions` 字段才是触发依据。

### 7.3 RoomMessage 附件

第一版 RoomMessage 支持附件，但复用现有 `Attachment` 能力，不重新设计复杂文件系统。

建议：

- `RoomMessage` 保存 `attachmentIds` 引用现有附件。
- 用户可以在 Team Room 中发送需求文档、截图、日志文件等附件。
- Agent 通过扩展后的 `get_context` 或 `list_room_messages` 获取 RoomMessage 时，可以看到附件引用。
- 附件的上传、存储、预览和清理尽量沿用现有 Attachment 逻辑。
- 不在第一版为 TeamRun 额外设计独立的附件存储系统。

### 7.4 普通消息与结构化 @

用户侧和 Agent/MCP 侧都不应显式区分“发消息”和“派活”两种沟通方式。

TeamRun 的主输入框就是一个群聊输入框。对用户和 Agent 来说，在团队群里结构化 `@member` 就是在叫这个成员处理事情，不应该要求发送者理解底层 `RoomMessage` 和 `WorkRequest` 的区别。

第一版统一规则：

```text
消息包含结构化 mention -> 创建 RoomMessage，并自动创建 WorkRequest
消息不包含结构化 mention -> 只创建普通 RoomMessage，不触发新 Agent
```

示例：

```text
@implementer 把这个功能做掉
```

这会创建 RoomMessage，同时为 `implementer` 创建 WorkRequest。

```text
这个方向不对，我们先重新考虑一下
```

这只是一条普通 RoomMessage，不触发新 Agent。

```text
@reviewer 你怎么看这个 diff？
```

虽然语气像讨论，但用户已经在群里叫了 `reviewer`，因此应创建 WorkRequest，让 reviewer 被唤醒并回答。

被 @ 的 Agent 如何处理，由它自己的角色 prompt 和上下文决定。它可以直接回复一句，也可以改代码，也可以继续 @ 其他成员。

因此 MCP 不需要同时提供“发消息”和“派活”两套工具。统一使用 `post_room_message`：

```text
post_room_message(content, mentions)
  -> mentions 为空：只创建 RoomMessage
  -> mentions 非空：创建 RoomMessage + WorkRequest
```

如果只是想在文字上提到某个成员但不想唤醒它，就不要使用结构化 mention chip，只写普通文本名字。

后续如果用户确实需要“只提及某成员但不启动”，可以再设计转义或高级操作，例如 `@@reviewer`、右键选择“仅提及不唤醒”等。第一版不作为核心需求。

## 8. WorkRequest 与 AgentInvocation

### 8.1 WorkRequest

`WorkRequest` 是调度器看到的“请求某成员工作”的结构化对象。

建议字段：

```ts
WorkRequest {
  id: string
  teamRunId: string
  requesterMemberId?: string | null
  requesterType: 'user' | 'agent' | 'system'
  targetMemberId: string
  triggerMessageId: string
  instruction: string
  ifBusy: 'queue' | 'cancel_current_and_start'
  cancelQueued: boolean
  status: 'PENDING_APPROVAL' | 'QUEUED' | 'STARTED' | 'REJECTED' | 'CANCELLED'
  createdAt: string
  updatedAt: string
}
```

### 8.2 AgentInvocation

`AgentInvocation` 表示某个成员被请求后实际运行的一次工作。

建议字段：

```ts
AgentInvocation {
  id: string
  teamRunId: string
  workRequestId: string
  memberId: string
  workspaceId?: string | null
  sessionId?: string | null
  status:
    | 'QUEUED'
    | 'RUNNING'
    | 'SESSION_ENDED'
    | 'WAITING_ROOM_REPLY'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED'
  roomReplyReminderCount: number
  createdAt: string
  updatedAt: string
}
```

### 8.3 运行时一致性规则

这些规则不是 Auto 模式限制，而是防止系统状态损坏：

- invocation 不重复启动
- 已取消 invocation 不被恢复
- session 失败要更新 invocation 状态
- 用户或有权限的成员可以停止某个成员当前工作
- Task 取消/删除时，应顺带停止 TeamRun 内所有运行中 invocation、取消队列并释放资源锁
- 没有 Room 回复时的 reminder 不无限循环

同一个 TeamMember 同时最多只能有一个 active invocation/session。

第一版规则：

```text
目标成员 idle
  -> 立即启动 invocation

目标成员 running / waiting_room_reply
  -> 新 WorkRequest 进入该成员队列

目标成员已有 queued work
  -> 继续追加到队列

当前 invocation completed / failed / cancelled / 达到 no-room-reply 最大重试
  -> 调度器启动该成员队列中的下一个 WorkRequest
```

运行中的成员被 @ 时，不默认打断当前 session，也不默认把新消息插入当前 session。这样可以避免当前工作半途被打断，导致原任务和新任务都处理不完整。

如果需要停止某个成员当前工作，应通过显式停止能力处理，例如 Leader 调用 MCP 停止工具，或用户在 UI 中手动停止。

Leader/Dispatcher 通过 `post_room_message` 结构化 @ 其他成员时，可以在 mention 上指定目标成员忙碌时的策略：

```ts
type IfBusyPolicy =
  | 'queue'
  | 'cancel_current_and_start'
```

含义：

- `queue`：默认值。目标成员正在运行时，新 WorkRequest 进入队列。
- `cancel_current_and_start`：停止目标成员当前 invocation/session，将当前 invocation 标记为 `CANCELLED`，释放资源锁，然后尽快启动新 WorkRequest。

权限要求：

- `ifBusy = 'queue'` 只需要 `postRoomMessage` 和 `mentionMembers` capability。
- `ifBusy = 'cancel_current_and_start'` 需要 `postRoomMessage + mentionMembers + stopMemberWork` capability。

`cancelQueued` 用于控制是否清理目标成员已有队列：

- `cancelQueued = false`：只停止当前工作，新请求插到队首或立即启动，旧队列保留。
- `cancelQueued = true`：取消当前工作和该成员队列中的后续 WorkRequest，用新请求替换。

被 `cancel_current_and_start` 取消的 invocation 不应触发 Result Hook reminder。停止原因可在 Team Status 中展示；RoomMessage 默认只展示新的派活消息，是否额外写系统取消消息后续再定。

第一版不设计独立的 `cancel_team_run`。如果用户要放弃整个团队执行，应使用现有 Task 生命周期，例如取消/删除/放弃 Task。TeamRun 是 Task 内部执行细节，不应新增一个和看板 Task 状态竞争的整体取消状态。

### 8.4 Capability Lock / Resource Lock

并发控制不应简单理解为“相同 capability 不能并行”。更准确的规则是：**相同的排他资源不能被并行占用**。

有些能力天然可以并行：

```text
readRoom
postRoomMessage
mentionMembers
readFiles
readDiff
```

真正危险的是会修改共享状态的能力：

```text
writeFiles      // 写同一个 workspace
mergeWorkspace  // merge 同一个项目/目标分支
runCommands     // 可能修改文件、启动服务或占用端口
```

建议引入调度层的资源锁概念：

```ts
CapabilityLock {
  resourceKey: string
  mode: 'shared' | 'exclusive'
  holderInvocationId: string
}
```

初期规则：

- `writeFiles + shared workspace` 需要排他锁：`workspace:{workspaceId}:write`
- `mergeWorkspace` 需要排他锁：`project:{projectId}:merge`
- `runCommands` 第一版先保守视为排他锁：`workspace:{workspaceId}:command`
- `readRoom`、`postRoomMessage`、`mentionMembers`、`readFiles`、`readDiff` 不需要排他锁，可并行

调度流程：

```text
WorkRequest created
  -> Scheduler 根据目标成员 capabilities 和 workspacePolicy 计算 required locks
  -> lock 可用：启动 invocation
  -> lock 不可用：WorkRequest / AgentInvocation 保持 QUEUED
  -> lock 释放后自动继续调度
```

Auto 模式下也遵守资源锁，但这不是人工确认或产品限制，而是运行时一致性保证。它只会让 invocation 自动排队，不会要求用户确认。

Room 不应写入“等待锁”之类噪声。Team Status 中可以展示原因：

```text
Reviewer queued
Reason: waiting for workspace write lock held by Implementer
```

第一版建议明确：

- 同一个 shared workspace 中，同一时间只允许一个拥有 `writeFiles` 的 invocation 运行。
- 同一个项目/目标分支，同一时间只允许一个拥有 `mergeWorkspace` 的 invocation 运行。
- `mergeWorkspace` 最好等待所有写入型 invocation 结束后再启动。
- `runCommands` 先按排他处理，避免测试、构建、脚本、服务端口互相污染；后续可以细分 read-only command 和 mutating command 再放宽。
- 如果未来支持 `dedicated workspace`，多个拥有 `writeFiles` 的成员写不同 workspace 时可以并行。

## 9. Result Hook

### 9.1 问题

TeamRun 中，session 结束不代表该 Agent 已经在团队房间里回复过。

Agent 可能正常结束，也可能报错、上下文中断、命令失败，或者忘记向 Room 发送任何回应。

### 9.2 正确行为

当 session 结束时，Agent Tower 检查对应 invocation 是否已经向 Room 发送过 RoomMessage。

```text
Session ended
  -> 检查 invocation 是否已有 RoomMessage 回复
  -> 如果有：invocation completed
  -> 如果没有：向同一个 session 发送后续消息，让该 Agent 继续处理或回复 Room
```

这个 hook 的消息不进入 Team Room。它是发给当前 Agent 的继续工作指令。

### 9.3 Room 回复检测方式

是否已经回复 Room 不应通过文本猜测判断，例如扫描 Agent 输出里有没有 `result:`、`完成了` 等关键词。这种方式不稳定，也容易误判。

回复必须通过结构化数据显式关联到当前 invocation。

推荐规则：

1. Scheduler 启动成员工作时创建 `AgentInvocation`，并记录对应 `sessionId`。
2. Agent 通过唯一沟通入口 `post_room_message` 向 Team Room 发送消息。
3. 后端根据当前 session / MCP 上下文自动为 RoomMessage 写入 `senderInvocationId = currentInvocation.id`。
4. 如果 RoomMessage 带结构化 mentions，后端同时为被 @ 成员创建 WorkRequest。
5. Session end hook 检测时，只查是否存在 `senderInvocationId = invocation.id` 的 RoomMessage。

判断逻辑示例：

```ts
const hasRoomReply =
  await prisma.roomMessage.count({
    where: {
      teamRunId: invocation.teamRunId,
      senderInvocationId: invocation.id,
      senderId: invocation.memberId,
    },
  }) > 0
```

Agent 调用示例：

```json
{
  "content": "我已经审查了当前 diff，发现两个问题：...",
  "mentions": []
}
```

后端创建 RoomMessage 时自动补上下文：

```json
{
  "senderType": "agent",
  "senderId": "member_reviewer",
  "senderInvocationId": "invocation_456",
  "content": "我已经审查了当前 diff，发现两个问题：...",
  "mentions": []
}
```

如果 Agent 回复时继续 @ 其他成员：

```json
{
  "content": "@implementer 请修复这两个问题。",
  "mentions": [
    {
      "memberId": "member_implementer",
      "ifBusy": "queue",
      "cancelQueued": false
    }
  ]
}
```

后端创建当前 Agent 的 RoomMessage，并基于结构化 mentions 创建新的 WorkRequest。

因此，Result Hook 的检测规则应是：只要当前 invocation 通过 `post_room_message` 成功向 Room 发送过至少一条 RoomMessage，就认为它已经回复，不再触发 no-room-reply reminder。普通 stdout、session log、未关联 invocation 的 RoomMessage 都不算回复。

### 9.4 Reminder 的意图

Reminder 不应该让 Agent 往 Room 里发“我失败了”“我还没完成”这种噪声。

正确意图是：

- 如果任务没完成，继续把任务做完
- 如果已经有可以回复团队的信息，向 Team Room 发送有意义的回应
- 只有当有真实结果、决策、交接或需要其他成员处理时，才发 RoomMessage

建议 reminder 文案：

```text
你当前这次工作还没有向 Team Room 发送回应。

请继续处理刚才的任务，不要只汇报状态。

如果任务尚未完成，请继续完成它。
如果你已经有可以回复团队的信息，请向 Team Room 发送消息，说明最终产物、结论或有价值的下一步。
```

这是 Result Hook 的后续消息，不是系统默认注入的角色 prompt。

### 9.5 状态流

建议 invocation 状态流：

```text
RUNNING
  -> SESSION_ENDED
  -> WAITING_ROOM_REPLY
  -> RUNNING          // Agent 收到 reminder 后继续工作
  -> COMPLETED        // Agent 向 Room 发送回应
  -> FAILED/CANCELLED // 明确失败或取消
```

### 9.6 Reminder 限制

系统需要避免无限提醒。

建议字段：

```ts
roomReplyReminderCount: number
nextRoomReplyReminderAt?: string | null
```

Reminder 应支持指数退避和最大重试次数。

示例策略：

```text
第 1 次：session ended 后立即提醒
第 2 次：等待 1 分钟
第 3 次：等待 3 分钟
第 4 次：等待 10 分钟
超过最大次数：停止提醒
```

具体间隔可以配置，但原则是：

- 不在 Team Room 里写 reminder 噪声
- reminder 只发送给当前 invocation 对应的 session
- 每次 reminder 后更新 `roomReplyReminderCount`
- 如果还未到 `nextRoomReplyReminderAt`，不重复提醒
- 达到最大次数后，UI 在 Team Status 中展示该 invocation ended without room reply
- 达到最大次数后不再继续自动唤醒，避免空转

## 10. MCP 工具设计

MCP 工具用于让团队成员读取 Room、发送 RoomMessage、通过结构化 @ 唤醒其他成员，并管理自身可见的团队上下文。

### 10.1 第一版工具列表

建议工具：

```text
get_context
list_room_messages
post_room_message
stop_member_work
mark_task_ready_for_review
list_team_members
get_member_status
get_my_invocations
```

后续可选：

```text
get_invocation
list_work_requests
cancel_work_request
get_team_workspace_diff
```

### 10.2 工具语义

`get_context`

- 保留现有基础上下文字段，继续返回 project、task、workspace、session 等信息。
- 增加 `mode` 字段：`SOLO` 或 `TEAM`。
- Solo 模式下保持现有行为，只额外返回 `mode: 'SOLO'`。
- TeamRun 模式下，在现有字段基础上追加 team 字段，例如 TeamRun、当前成员、团队成员、当前 WorkRequest、当前 invocation 和最近 RoomMessages。
- 这样 Agent 只需要记一个上下文工具，不需要新增 `get_team_context`。

建议返回结构：

```json
{
  "mode": "TEAM",
  "project": {},
  "task": {},
  "workspace": {},
  "session": {},
  "teamRun": {},
  "currentMember": {},
  "currentInvocation": {},
  "teamMembers": [],
  "recentRoomMessages": []
}
```

`list_room_messages`

- 分页读取 RoomMessage 历史。

`post_room_message`

- 向 Room 发送消息。
- 可带结构化 mentions；mentions 非空时，自动为被 @ 成员创建 WorkRequest。
- 结构化 mention 可支持 `ifBusy` 参数：
  - `queue`：默认。目标成员忙碌时排队。
  - `cancel_current_and_start`：停止目标成员当前工作并启动新请求，需要调用者具备 `stopMemberWork`。
- 支持 `cancelQueued` 参数，决定是否同时取消目标成员队列中尚未启动的 WorkRequest。
- 如果只是想在文本中提到某个成员但不想唤醒它，不应使用结构化 mention。

`stop_member_work`

- 显式停止某个成员当前运行中的 invocation/session。
- 主要给 Leader、Dispatcher 或用户授权的管理类成员使用。
- 需要 `stopMemberWork` capability。
- 停止后应将目标 invocation 标记为 `CANCELLED` 或其他明确终态，并释放相关资源锁。
- 是否清理该成员队列中的后续 WorkRequest 应由参数决定，例如 `cancelQueued: boolean`。
- 停止事件可以在 Team Status 中展示；是否写入 RoomMessage 需要谨慎，避免噪声。若写入，应是简洁的系统事件。

`mark_task_ready_for_review`

- 将当前 TeamRun 对应的 Task 标记为 `IN_REVIEW`。
- 用于让 Leader/Dispatcher 等有权限成员在判断团队工作已完成后，明确告诉 Agent Tower 进入审查状态。
- 需要 `markReadyForReview` capability。
- 用户在 UI 中也应始终可以手动执行同等操作。
- 不建议由系统仅根据“没有 queued/running work”自动猜测完成，因为没有后续工作不等于任务已经完成。

`list_team_members`

- 返回团队成员、aliases、能力概览、当前状态。

`get_member_status`

- 查询成员 idle、queued、running、waiting room reply 等状态。

`get_my_invocations`

- 查询当前成员自己的 invocation。

### 10.3 工具能力控制

MCP 工具应尽量遵守 `TeamMember.capabilities`。

示例：

- 没有 `postRoomMessage` 的成员不能调用 `post_room_message`
- 没有 `mentionMembers` 的成员不能在 `post_room_message` 中携带结构化 mentions
- 没有 `stopMemberWork` 的成员不能调用 `stop_member_work`
- 没有 `markReadyForReview` 的成员不能调用 `mark_task_ready_for_review`
- 没有 `readDiff` 的成员不能调用 diff 相关工具
- 没有 `mergeWorkspace` 的成员不能合并 workspace

第一版做到 MCP 工具层能力控制即可。完整进程沙箱后续再考虑。

## 11. 触发引擎

### 11.1 事件流

推荐流：

```text
RoomMessageCreated
  -> Trigger Engine
  -> WorkRequest
  -> Mode Policy
  -> Scheduler
  -> AgentInvocation
  -> Workspace/Session
  -> Result Hook
  -> Result RoomMessage
```

### 11.2 触发来源

触发可以来自：

- 用户在 TeamRun 房间发送消息
- Agent 通过 MCP 调用
- 后续可配置的系统事件

Agent 之间互相触发是必需能力，例如：

```text
Leader -> @implementer 按这个方案实现
Implementer -> @reviewer 请审查当前 diff
Reviewer -> @implementer 请修复这些问题
```

### 11.3 Confirm 与 Auto 行为

`CONFIRM` 模式：

```text
WorkRequest -> PENDING_APPROVAL -> 用户确认 -> QUEUED/RUNNING
```

`AUTO` 模式：

```text
WorkRequest -> QUEUED -> RUNNING
```

Auto 模式不因为写权限额外要求确认。写权限是成员配置的一部分。

## 12. UI 计划

### 12.1 布局策略

TeamRun 应尽量复用现有 Agent Tower 任务详情布局。

已确认方向：

- 原有主日志区域在 TeamRun 模式下展示 RoomMessage timeline。
- 右侧 `WorkspacePanel` 保持原结构。
- 在右侧面板增加 `Team Status` tab。

概念布局：

```text
TaskDetail
├─ 主区域
│  └─ Team 模式：RoomMessage timeline
│
└─ WorkspacePanel
   ├─ Files
   ├─ Git Changes
   ├─ Terminal
   ├─ History
   └─ Team Status
```

这样保留 Agent Tower 现有 workspace、diff、terminal、文件能力，同时 TeamRun 的默认视角变成团队协作房间。

### 12.2 Room timeline 展示内容

Room timeline 展示：

- 用户消息
- Agent 消息
- 派活请求
- 有意义的回应/结果
- decision / artifact
- 紧凑 active invocation 行

不展示：

- 原始 stdout
- 完整命令日志
- 临时失败状态
- 内部 Result Hook reminder

示例：

```text
User: @leader 实现 TeamRun 协作功能
Leader: @implementer 先做 RoomMessage 数据模型和接口
Implementer is working... [查看详情]
Implementer: Result: 已完成 RoomMessage model 和 API 草稿
Implementer: @reviewer 请审查当前 diff
Reviewer is working... [查看详情]
Reviewer: Result: 发现两个问题...
```

### 12.3 Room timeline 视觉样式

Room timeline 的视觉方向可以模仿微信群聊布局，让 TeamRun 更像一个真实团队群。

建议：

- 每个 TeamMember 都有头像。
- 创建成员模板时可以设置默认头像。
- 用户可以从内置头像列表中选择头像。
- 用户也可以上传新头像。
- Room 中按发送者展示头像、名称、消息气泡和时间。
- 用户自己的消息与 Agent 消息可以采用左右分栏或明显区分的气泡样式。
- Agent 正在工作时，用该 Agent 的头像展示紧凑 loading 行，例如：

```text
[Implementer avatar] Implementer is working... [查看详情]
```

头像应作为 `MemberPreset` 的一部分保存，并在创建 TeamRun 时复制到 `TeamMember` 快照，避免历史 TeamRun 因 preset 头像变化而改变显示。

### 12.4 Team Status tab

`Team Status` tab 展示：

- members 和当前状态
- active invocation
- queued work requests
- 最近完成的 invocations
- waiting-room-reply invocations
- shared workspace summary
- reply/artifact refs

示例：

```text
Members
- Leader       idle
- Implementer  running
- Reviewer     queued

Queue
- Reviewer: review current diff

Active
- Implementer: session running, elapsed time, provider, view logs

Results / Artifacts
- architecture plan
- implementation reply/result
- review reply/result
```

### 12.5 Invocation 详情

从 Room 或 Team Status 点击“查看详情”后，展示某次 invocation 细节：

- trigger message
- target member
- provider
- workspace/session
- session logs
- token usage
- diff 或 changed files
- room reply message

第一版可以复用现有 session log/detail 组件，不必重写全新的日志查看器。

## 13. 兼容现有任务

现有任务继续保持 Solo 模式。

推荐兼容逻辑：

- Task 没有 TeamRun：渲染现有 Solo 体验
- Task 有 TeamRun：主区域渲染 RoomMessage，并显示 Team Status tab

初期可以不新增 `Task.executionMode` 字段，直接通过是否存在 TeamRun 判断。

### 13.1 TeamRun 与 Task 状态流转

现有看板状态仍然表示 Task 生命周期：

```text
TODO -> IN_PROGRESS -> IN_REVIEW -> DONE / CANCELLED
```

TeamRun 内部状态表示 Task 内部的自动团队运行细节，例如：

```text
Member: idle / queued / running / waiting_room_reply
Invocation: queued / running / completed / cancelled
WorkRequest: queued / started / cancelled
```

两者不应互相替代。

建议规则：

- 第一个 TeamRun invocation 启动时，Task 进入 `IN_PROGRESS`。
- 单个 session 结束只更新 invocation，不直接推进 Task。
- 某个 Agent 被 `stop_member_work` 停止，不改变 Task 状态。
- 某个成员队列被清理，不改变 Task 状态。
- Task 被用户取消/删除时，停止 TeamRun 中所有 running invocation，取消 queued WorkRequest，并释放资源锁。
- Workspace merge 成功后，沿用现有逻辑让 Task 进入 `DONE`。
- TeamRun 下不能继续使用“任务下所有 CHAT session 结束后自动进入 `IN_REVIEW`”作为唯一规则，因为 session 结束可能只是一个 invocation 的中间状态，甚至可能还在 `WAITING_ROOM_REPLY`。

TeamRun 进入 `IN_REVIEW` 需要由状态归并器（`TeamRun Reconciler`）统一判断，而不是由单个 session 结束时直接推进。

### 13.2 TeamRun Reconciler

`TeamRun Reconciler` 的职责是：每当 TeamRun 相关状态变化时，重新判断当前 Task 是否应保持 `IN_PROGRESS`，还是应该进入 `IN_REVIEW`。

触发重算的事件包括：

- invocation 开始或结束
- invocation 通过 `post_room_message` 向 Room 回复
- Result Hook reminder 达到最大次数
- WorkRequest 创建、取消、入队、出队
- stop_member_work
- 资源锁获取或释放
- session completed / failed / cancelled

建议伪代码：

```ts
async function reconcileTeamRun(taskId: string) {
  const teamRun = await getTeamRun(taskId)
  if (!teamRun) return

  if (await hasRunningInvocation(teamRun.id)) return
  if (await hasWaitingResultInvocation(teamRun.id)) return
  if (await hasQueuedWorkRequest(teamRun.id)) return
  if (await hasPendingApproval(teamRun.id)) return

  await moveTaskToReview(taskId, 'TEAM_QUIESCENT')
}
```

### 13.3 reviewReason

为了让用户知道为什么进入 `IN_REVIEW`，建议在 TeamRun 或 Task 侧记录 `reviewReason`：

```ts
reviewReason:
  | 'READY'
  | 'TEAM_QUIESCENT'
  | 'PENDING_APPROVAL'
  | 'FAILED'
  | 'ENDED_WITHOUT_ROOM_REPLY'
```

显示方式示例：

- `TEAM_QUIESCENT`：团队已无活动，等待用户决定下一步
- `PENDING_APPROVAL`：有待确认的请求
- `ENDED_WITHOUT_ROOM_REPLY`：有成员未向 Room 回复
- `FAILED`：某个关键 invocation 失败

### 13.4 进入 IN_REVIEW 的语义

在 TeamRun 模式下，`IN_REVIEW` 不只代表“已经完成可以审查”，也代表“Agent 团队当前没有可继续自动推进的工作，需要用户介入判断下一步”。

这意味着它既可能对应成功完成，也可能对应卡住、失败、无 Room 回复、或没有后续可自动推进的工作。

## 14. 第一版范围

### 14.1 包含

第一版建议包含：

- MemberPreset 设置
- TeamTemplate 或至少创建任务时选择多个 MemberPreset
- TeamRun 创建
- TeamMember 快照
- RoomMessage 持久化和 UI timeline
- 通过 `post_room_message` 的结构化 mention 创建 WorkRequest
- Confirm / Auto 模式
- AgentInvocation 调度
- shared workspace 支持
- Result Hook：session ended without Room reply 后向同 session 发送继续工作消息
- Team Status tab
- 团队协作相关 MCP tools

### 14.2 暂缓

第一版暂缓：

- dedicated workspace 自动集成
- 可视化 workflow graph editor
- 强制 Leader 角色
- 自动 merge 到 main
- 完整 OS 级 sandbox
- 一个 Task 多个 TeamRun 并行
- Auto 模式下的产品级最大轮次/写入确认限制

### 14.3 未来畅想（暂不实现）

以下是后续可以探索的方向，不进入第一版实现范围：

- **用户打断工作：** 允许用户在 Agent 团队运行过程中打断当前工作，插入新的方向调整、补充要求或纠偏意见。这个能力需要和当前 invocation/session 的中断、队列重排、RoomMessage 记录方式一起设计。
- **角色纠正机制：** 根据用户在历史对话中对某个角色的反馈，沉淀该角色的偏好和修正意见，让成员模板或角色配置逐渐更贴合用户习惯。例如用户多次纠正 Reviewer 的审查标准、Implementer 的代码风格后，系统可以保存这些意见，并在用户确认后用于改进对应角色配置。

## 15. 待讨论问题

当前核心方案已基本对齐。后续进入实现前，仍可继续细化字段命名、API 路径、UI 细节和迁移步骤。

## 16. 建议实现阶段

### Phase 1：数据模型与 API

- 新增 TeamRun、MemberPreset、TeamMember、RoomMessage、WorkRequest、AgentInvocation 模型。
- 新增 presets、team runs、members、room messages、invocations API。
- 增加 member snapshot 和 room message 创建测试。

### Phase 2：Room UI 与 Team Status

- TaskDetail 在 TeamRun 存在时主区域展示 RoomMessage timeline。
- WorkspacePanel 增加 Team Status tab。
- 展示 members、queue、active invocation 和 invocation 详情入口。

### Phase 3：Trigger Engine 与 Scheduler

- 将 `post_room_message` 的结构化 mentions 转为 WorkRequest。
- 实现 Confirm / Auto 模式。
- 根据 target member provider 和 workspacePolicy 启动 session。

### Phase 4：MCP 工具

- 扩展 `get_context` 支持 TeamRun 上下文，并增加 room、member、invocation 工具。
- 通过 `post_room_message` 统一处理回复和结构化 @ 触发。
- 在 MCP 工具层执行 capabilities 控制。

### Phase 5：Result Hook

- 检测 session ended without Room reply。
- 向同 session 发送继续工作 reminder。
- 跟踪 waiting-room-reply 状态和 reminder count。
- 不向 Room 写临时失败/状态噪声。

### Phase 6：兼容与打磨

- 保证 Solo 模式不受影响。
- 优化任务创建 TeamRun 流程。
- 增加成员预设和团队模板设置页。
- 打磨 Team Status 可观测信息。
