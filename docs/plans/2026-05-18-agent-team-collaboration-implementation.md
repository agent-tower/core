# 多 Agent 团队协作实施计划

**日期：** 2026-05-18

**关联设计：** `docs/plans/2026-05-15-agent-team-collaboration.md`

**目标：** 将 TeamRun 设计拆成可实施的开发阶段。第一版要跑通一个最小闭环：创建 TeamRun、配置成员、在 Room 中结构化 @ 成员、创建 WorkRequest、启动 AgentInvocation/session、Agent 通过 `post_room_message` 回复、Room 展示消息、TeamRun 静默后由 Reconciler 推进 Task 到 `IN_REVIEW`。

---

## 当前进度快照（2026-05-21）

已合并到 main 并同步到当前工作空间：

- **Phase 1 已完成：** 共享类型、Prisma 模型与迁移。
- **Phase 2 已完成：** 后端 TeamRun 服务与 REST API，包含 MemberPreset、TeamTemplate、TeamRun、RoomMessage、WorkRequest 基础能力。
- **Phase 3 已完成：** Scheduler、资源锁与 AgentInvocation/session 启动。
- **Phase 4 已完成：** Result Hook 与 TeamRun Reconciler。
- **Phase 5 已部分扩展完成：** MCP 最小工具与 TeamRun session 环境注入已完成，包含 `post_room_message` / `list_room_messages`，并通过 `senderInvocationId` 关联 invocation 回复。WorkRequest 控制类 MCP 工具也已补齐，包含 `approve_work_request` / `reject_work_request` / `cancel_work_request` / `stop_member_work`。member/status 查询、完整 TeamRun context 等扩展工具仍可后续补齐。
- **Phase 6 已完成：** 前端基础 TeamRun UI：TaskDetail 中 TeamRun 默认展示 Room timeline，WorkspacePanel 增加 Team Status tab，支持进入某次 invocation 的日志详情。
- **Phase 7A 已完成并合并：** TeamRun 团队设置页，包含 MemberPreset / TeamTemplate 的 UI 管理、CRUD hooks、设置页路由、英文 i18n 与 query 错误态处理。
- **Phase 7B 已完成并合并：** TeamRun 创建入口。实现范围包含 TaskDetail 中已有 Task 的“创建 TeamRun”入口，以及 ProjectKanbanPage 新建任务弹窗中的 `Solo Agent` / `TeamRun` 执行方式选择。TeamRun 创建表单支持 `CONFIRM` / `AUTO`、TeamTemplate、多个 MemberPreset 及成员选择顺序；修复了 TeamRun 创建失败后重试重复创建 Task 的问题。
- **Phase 8 已完成并合并：** TeamRun 实时同步采用统一 `team-run:invalidated` socket 事件，通过 `scopes` 区分 room messages、work requests、agent invocations、team run、task、workspaces 等失效范围。前端只把 socket payload 作为 query invalidation 信号，继续通过 REST refetch 获取真实状态，并保留 5 秒轮询 fallback。
- **Phase 9A 后端/MCP 已完成并合并：** 补齐 WorkRequest approve/reject/cancel REST API、成员 stop REST API、对应 MCP 工具，以及调度层 `approveWorkRequestAndStartNext` / `stopMemberWork` 行为和关键回归测试。
- **Phase 9B 前端控制 UI 已完成并合并：** Team Status 中已支持 `PENDING_APPROVAL` approve/reject/cancel、`QUEUED` cancel、`RUNNING` 成员 stop，并要求用户显式选择 stop only 或 stop + clear queue。操作后通过 query invalidation/refetch 回读服务端真实状态。

Phase 6 的实际落地边界：

- 使用 `GET /tasks/:taskId/team-run` 判断 Task 是否进入 TeamRun 模式。
- TeamRun 存在时，主区域显示 `RoomTimeline`；没有 TeamRun 时保留 Solo 日志体验。
- Room timeline 支持用户发送普通消息和结构化 mention 消息；mention 仍由后端创建 WorkRequest。
- Team Status 作为 WorkspacePanel 的 tab 内容展示 members、work requests、invocations。
- 第一版通过 5 秒轮询刷新 TeamRun detail 和 RoomMessage，并在现有 task/session socket 事件发生时 invalidates TeamRun 查询。
- 本阶段没有新增 TeamRun 专用 socket 事件，没有新增设置页，也没有改任务创建入口。

当前剩余主线：

1. **Phase 10：完整 TeamRun E2E 验证。** 当前核心闭环、控制入口和实时 invalidation 都已经具备，下一步需要跑完整浏览器闭环，覆盖创建 TeamRun、发送 @、confirm approve、启动 invocation、RoomMessage result、stop/cancel、实时刷新以及团队静默进入 `IN_REVIEW`。

---

## 0. 实施原则

- 保持现有 Solo 模式不受影响。
- TeamRun 存在时才启用团队模式；没有 TeamRun 的任务沿用现有 TaskDetail/session 行为。
- 不新增 `Task.executionMode`，第一版通过 Task 是否有关联 TeamRun 判断 Team 模式。
- MCP 不新增 `get_team_context`，扩展现有 `get_context`。
- MCP 不新增 `request_member_work`，统一使用 `post_room_message`，结构化 mentions 非空时创建 WorkRequest。
- 不新增 `submit_work_result`，RoomMessage 通过 `senderInvocationId` 自动关联当前 invocation。Result Hook 检查当前 invocation 是否发过 RoomMessage。
- 不做独立 `cancel_team_run`。整体放弃走现有 Task 取消/删除；TeamRun 内部只提供成员级 stop/queue/cancel 控制。
- 第一版支持 `workspacePolicy = none | shared`，`dedicated` 只预留类型，不做自动集成。

## 1. 推荐开发阶段

### Phase 1：共享类型、Prisma 模型与迁移

**状态：已完成并合并。**

**目标：** 建立 TeamRun 的数据库和共享类型基础。

**建议文件：**

- 修改：`packages/server/prisma/schema.prisma`
- 新增：`packages/server/prisma/migrations/<timestamp>_add_team_run_collaboration/migration.sql`
- 修改：`packages/shared/src/types.ts`

**新增模型建议：**

```prisma
model MemberPreset {
  id              String   @id @default(uuid())
  name            String
  aliases         String   // JSON string: string[]
  providerId      String
  rolePrompt      String
  capabilities    String   // JSON TeamMemberCapabilities
  workspacePolicy String
  triggerPolicy   String
  avatar          String?  // JSON or string ref, see avatar implementation
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model TeamTemplate {
  id        String               @id @default(uuid())
  name      String
  members   TeamTemplateMember[]
  createdAt DateTime             @default(now())
  updatedAt DateTime             @updatedAt
}

model TeamTemplateMember {
  id             String       @id @default(uuid())
  teamTemplateId String
  teamTemplate   TeamTemplate @relation(fields: [teamTemplateId], references: [id], onDelete: Cascade)
  memberPresetId String
  position       Int          @default(0)
}

model TeamRun {
  id           String   @id @default(uuid())
  taskId       String   @unique
  task         Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  mode         String
  reviewReason String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  members      TeamMember[]
  messages     RoomMessage[]
  workRequests WorkRequest[]
  invocations  AgentInvocation[]
}

model TeamMember {
  id              String   @id @default(uuid())
  teamRunId       String
  teamRun         TeamRun  @relation(fields: [teamRunId], references: [id], onDelete: Cascade)
  presetId        String?
  name            String
  aliases         String
  providerId      String
  rolePrompt      String
  capabilities    String
  workspacePolicy String
  triggerPolicy   String
  avatar          String?
  status          String   @default("IDLE")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model RoomMessage {
  id                 String   @id @default(uuid())
  teamRunId          String
  teamRun            TeamRun  @relation(fields: [teamRunId], references: [id], onDelete: Cascade)
  senderType         String
  senderId           String?
  senderInvocationId String?
  kind               String
  content            String
  mentions           String   // JSON structured mentions
  workRequestIds     String?  // JSON string[]
  artifactRefs       String?  // JSON string[]
  attachmentIds      String?  // JSON string[]
  createdAt          DateTime @default(now())
}

model WorkRequest {
  id                String   @id @default(uuid())
  teamRunId         String
  teamRun           TeamRun  @relation(fields: [teamRunId], references: [id], onDelete: Cascade)
  requesterMemberId String?
  requesterType     String
  targetMemberId    String
  triggerMessageId  String
  instruction        String
  ifBusy            String   @default("queue")
  cancelQueued      Boolean  @default(false)
  status            String   @default("QUEUED")
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}

model AgentInvocation {
  id                      String   @id @default(uuid())
  teamRunId               String
  teamRun                 TeamRun  @relation(fields: [teamRunId], references: [id], onDelete: Cascade)
  workRequestId           String
  memberId                String
  workspaceId             String?
  sessionId               String?
  status                  String   @default("QUEUED")
  roomReplyReminderCount  Int      @default(0)
  nextRoomReplyReminderAt DateTime?
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt
}
```

**共享类型建议：**

- `TeamRunMode = 'CONFIRM' | 'AUTO'`
- `WorkspacePolicy = 'none' | 'shared' | 'dedicated'`
- `TeamMemberTriggerPolicy = 'MENTION_ONLY' | 'USER_MESSAGES'`
- `TeamMemberCapabilities`
- `StructuredMention`
- `RoomMessage`
- `WorkRequest`
- `AgentInvocation`
- `TeamRun`
- `MemberPreset`
- `TeamTemplate`

**验收条件：**

- Prisma migration 可应用。
- `pnpm --filter @agent-tower/server prisma generate` 成功。
- `pnpm --filter @agent-tower/shared build` 成功。
- Solo 模式现有类型不破坏。

## 2. Phase 2：后端 TeamRun 服务与 REST API

**状态：已完成并合并。**

**目标：** 提供 TeamRun、成员、房间消息、预设和模板的基础 CRUD/API。

**建议文件：**

- 新增：`packages/server/src/services/team-run.service.ts`
- 新增：`packages/server/src/routes/team-runs.ts`
- 修改：`packages/server/src/routes/index.ts`
- 修改：`packages/server/src/routes/tasks.ts`（如需在 task detail include TeamRun）
- 新增测试：`packages/server/src/services/__tests__/team-run.service.test.ts`

**API 建议：**

```text
GET    /api/member-presets
POST   /api/member-presets
PATCH  /api/member-presets/:id
DELETE /api/member-presets/:id

GET    /api/team-templates
POST   /api/team-templates
PATCH  /api/team-templates/:id
DELETE /api/team-templates/:id

POST   /api/tasks/:taskId/team-runs
GET    /api/tasks/:taskId/team-run
GET    /api/team-runs/:id

POST   /api/team-runs/:id/messages
GET    /api/team-runs/:id/messages
GET    /api/team-runs/:id/members
GET    /api/team-runs/:id/invocations
POST   /api/team-runs/:id/members/:memberId/stop
```

**关键行为：**

- 创建 TeamRun 时从 TeamTemplate 或 MemberPreset 复制 TeamMember 快照。
- TeamTemplate 只是快捷入口，不是必选项。
- `POST /messages` 支持 `content`、`mentions`、`attachmentIds`。
- mentions 非空时创建 WorkRequest。
- RoomMessage 写入 `workRequestIds`。
- 若发送者来自某个 invocation，上层调用应能传入或由上下文推导 `senderInvocationId`。

**验收条件：**

- 可创建 TeamRun。
- 可从多个 MemberPreset 创建 TeamMember 快照。
- 可创建 RoomMessage。
- 带 mentions 的 RoomMessage 会创建 WorkRequest。
- 不带 mentions 的 RoomMessage 不创建 WorkRequest。
- 附件 ID 可保存到 RoomMessage。

## 3. Phase 3：Scheduler、资源锁与 AgentInvocation 启动

**状态：已完成并合并。**

**目标：** 把 WorkRequest 调度成 AgentInvocation，并启动现有 workspace/session。

**建议文件：**

- 新增：`packages/server/src/services/team-scheduler.service.ts`
- 新增：`packages/server/src/services/team-lock.service.ts`
- 修改：`packages/server/src/services/workspace.service.ts`
- 修改：`packages/server/src/services/session-manager.ts`（仅增加 TeamRun 关联后处理 hook）

**调度规则：**

- 同一个 TeamMember 同时最多一个 active invocation/session。
- 成员 running 或 waiting room reply 时，新 WorkRequest 进入该成员队列。
- `ifBusy = queue` 默认排队。
- `ifBusy = cancel_current_and_start` 需要调用者具备 `stopMemberWork`，停止当前 invocation 后启动新请求。
- `cancelQueued` 控制是否清空该成员队列。

**资源锁规则：**

- `writeFiles + shared workspace`：`workspace:{workspaceId}:write` 排他。
- `mergeWorkspace`：`project:{projectId}:merge` 排他。
- `runCommands` 第一版：`workspace:{workspaceId}:command` 排他。
- read 能力不加排他锁。

**Workspace 策略：**

- `none`：不创建代码 workspace，适合 Leader/讨论型成员。启动 session 时需要决定是否允许无 workspace；若现有 Agent CLI 必须有 cwd，使用项目 repoPath 或 TeamRun shared workspace 的只读上下文，具体实现前需要确认。
- `shared`：使用 TeamRun 对应 task 的 shared workspace。第一版可以复用 task 下 active workspace；没有则创建。
- `dedicated`：暂不实现自动集成。

**验收条件：**

- WorkRequest 在 AUTO 模式下可自动启动。
- CONFIRM 模式下 WorkRequest 进入待确认，不自动启动。
- 同一 TeamMember 运行中再次被 @ 会排队。
- 写入型 shared workspace invocation 不并发。
- `stop_member_work` 可停止当前 session，并可按参数清理队列。

## 4. Phase 4：Result Hook 与 TeamRun Reconciler

**状态：已完成并合并。**

**目标：** 让 session 结束后自动检查是否向 Room 回复，并在团队静默时推进 Task 到 `IN_REVIEW`。

**建议文件：**

- 修改：`packages/server/src/services/session-manager.ts`
- 新增：`packages/server/src/services/team-reconciler.service.ts`
- 新增测试：`packages/server/src/services/__tests__/team-reconciler.service.test.ts`

**Result Hook 行为：**

```text
Session ended
  -> 找到关联 AgentInvocation
  -> 检查是否存在 RoomMessage.senderInvocationId = invocation.id
  -> 有：invocation COMPLETED
  -> 无：进入 WAITING_ROOM_REPLY，并给同 session 发送 reminder
  -> reminder 使用指数退避 + 最大次数
  -> 达到最大次数：invocation 进入终态，Team Status 显示 ended without room reply
```

**Reminder 字段：**

- `roomReplyReminderCount`
- `nextRoomReplyReminderAt`

**Reconciler 行为：**

每当 TeamRun 状态变化后调用：

```text
没有 RUNNING invocation
没有 WAITING_ROOM_REPLY invocation
没有 QUEUED WorkRequest
没有 PENDING_APPROVAL WorkRequest
没有占用资源锁
=> Task IN_PROGRESS -> IN_REVIEW，reviewReason = TEAM_QUIESCENT 或具体原因
```

**验收条件：**

- Session 结束但没有 RoomMessage，会触发 reminder。
- Agent 通过 `post_room_message` 回复后，不再触发 reminder。
- reminder 达最大次数后，TeamRun 可静默进入 `IN_REVIEW`。
- 有 queued/running/waiting room reply 时不进入 `IN_REVIEW`。
- TeamRun 后续新增 WorkRequest 并启动时，Task 可回到 `IN_PROGRESS`。

## 5. Phase 5：MCP 工具扩展

**状态：最小闭环已完成并合并；WorkRequest 控制类 MCP 工具已完成并合并；上下文查询类扩展工具待补齐。**

**已完成范围：**

- TeamRun session 启动时注入 TeamRun / TeamMember / AgentInvocation 环境变量。
- `post_room_message` 可在 TeamRun session 中自动绑定 `senderInvocationId`。
- `post_room_message` 携带结构化 mentions 时复用 RoomMessage API 创建 WorkRequest。
- `list_room_messages` 可读取 Team Room 历史消息。
- `approve_work_request` / `reject_work_request` / `cancel_work_request` 可控制 Confirm 模式下的 WorkRequest。
- `stop_member_work` 可停止指定成员当前 session，并可选择清理该成员 queued WorkRequest。

**未完成范围：**

- `list_team_members`
- `get_member_status`
- `get_my_invocations`
- 扩展 `get_context` 返回完整 TeamRun 上下文
- MCP 工具层完整 capability 控制

**目标：** 让 Agent 通过 MCP 获取 TeamRun 上下文、发 RoomMessage、停止成员工作。

**建议文件：**

- 修改：`packages/server/src/mcp/context.ts`
- 修改：`packages/server/src/mcp/tools/sessions.ts` 或新增 `packages/server/src/mcp/tools/team.ts`
- 修改：`packages/server/src/mcp/server.ts`
- 修改：`packages/server/src/mcp/http-client.ts`
- 修改：`docs/MCP.md`

**工具设计：**

- 扩展 `get_context`：
  - Solo：返回原字段 + `mode: 'SOLO'`
  - Team：返回原字段 + `mode: 'TEAM'` + `teamRun/currentMember/currentInvocation/teamMembers/recentRoomMessages`
- `list_room_messages`
- `post_room_message`
- `stop_member_work`
- `list_team_members`
- `get_member_status`
- `get_my_invocations`

**能力控制：**

- 没有 `postRoomMessage` 不能发消息。
- 没有 `mentionMembers` 不能携带结构化 mentions。
- 没有 `stopMemberWork` 不能 stop 其他成员。
- 没有相关 read 能力时限制 diff/files 类工具。

**验收条件：**

- Solo worktree 下 `get_context` 仍兼容。
- TeamRun session 下 `get_context` 返回 team 字段。
- `post_room_message` 自动绑定 `senderInvocationId`。
- `post_room_message` 带 mentions 创建 WorkRequest。
- `stop_member_work` 可受 capability 控制。

## 6. Phase 6：前端基础 TeamRun UI

**状态：已完成并合并。**

**目标：** 在 TaskDetail 中展示 Team Room，并在 WorkspacePanel 增加 Team Status tab。

**建议文件：**

- 修改：`packages/web/src/components/task/TaskDetail.tsx`
- 修改：`packages/web/src/components/workspace/WorkspacePanel.tsx`
- 新增：`packages/web/src/components/team/RoomTimeline.tsx`
- 新增：`packages/web/src/components/team/RoomComposer.tsx`
- 新增：`packages/web/src/components/team/TeamStatusPanel.tsx`
- 新增：`packages/web/src/hooks/use-team-run.ts`
- 新增：`packages/web/src/hooks/use-room-messages.ts`

**UI 行为：**

- Task 有 TeamRun：主日志区域显示 Room timeline。
- Task 无 TeamRun：保留现有 Solo 日志体验。
- Room timeline 模仿微信群聊：头像、名称、气泡、时间。
- 每个 TeamMember 有头像，来自 TeamMember 快照。
- 发送消息时支持结构化 mention chip。
- 附件复用现有 Attachment UI。
- Agent working 行显示 `[avatar] Agent is working... [查看详情]`。
- Team Status tab 显示 members、active invocation、queue、waiting room reply、workspace summary。

**验收条件：**

- TeamRun RoomMessage 可正常显示。
- 发送无 mention 消息不会创建 WorkRequest。
- 发送带 mention 消息会创建 WorkRequest。
- Team Status 能显示队列和运行状态。
- 点击查看详情可进入对应 session/log 详情。

## 7. Phase 7：成员预设、团队模板与 TeamRun 创建入口

**状态：Phase 7A 已完成并合并；Phase 7B 已完成并合并。**

**目标：** 让用户能配置成员预设、可选 TeamTemplate，并能从 UI 创建 TeamRun。

**建议文件：**

- 新增：`packages/web/src/pages/TeamSettingsPage.tsx` 或集成到现有 settings
- 修改：`packages/web/src/layouts/SettingsLayout.tsx`
- 修改：`packages/web/src/routes/index.tsx`
- 修改：任务创建相关组件（`packages/web/src/pages/ProjectKanbanPage.tsx` 当前内联任务创建弹窗）
- 修改：`packages/web/src/components/task/TaskDetail.tsx`（可选：给已有 Task 增加“创建 TeamRun/转换为 TeamRun”入口）
- 修改：`packages/web/src/hooks/use-team-run.ts`
- 新增：`packages/web/src/components/team/MemberPresetForm.tsx`
- 新增：`packages/web/src/components/team/TeamTemplateForm.tsx`
- 新增：`packages/web/src/components/team/CreateTeamRunDialog.tsx`

**配置项：**

- name
- aliases
- provider
- rolePrompt
- capabilities
- workspacePolicy
- triggerPolicy
- avatar（内置头像列表或上传）

**建议拆分：**

Phase 7 可以拆成两个独立任务，也可以合并成一个中等任务：

- **Phase 7A：MemberPreset / TeamTemplate 设置页。**
  - 状态：已完成并合并到 main。
  - 管理成员模板和团队模板。
  - 复用已有 settings 布局。
  - 使用后端已存在的 `/member-presets` 和 `/team-templates` API。
  - 已覆盖 Provider / MemberPreset / TeamTemplate 查询失败态，避免 API 失败时误显示为空列表。
  - 已补英文 i18n，并确认页面没有裸中文 placeholder。
- **Phase 7B：TeamRun 创建入口。**
  - 状态：已完成并合并到 main。
  - 已在桌面 TaskDetail 中给已有 Task 增加“创建 TeamRun”入口。
  - 已在 ProjectKanbanPage 新建任务弹窗中增加 `Solo Agent` / `TeamRun` 执行方式选择。Solo 保持原 provider -> workspace -> session -> start 流程；TeamRun 创建 Task 后创建 TeamRun，不创建 Solo workspace/session。
  - 创建 TeamRun 时支持选择 TeamTemplate、选择多个 MemberPreset，并保留 MemberPreset 选择顺序。暂不实现手动编辑本次成员快照。
  - 已抽出可复用 `TeamRunCreateForm`，供 TaskDetail dialog 与创建任务弹窗复用。
  - 已修复 TeamRun 创建失败后重试重复创建 Task 的问题：创建 Task 成功但 TeamRun 创建失败时保留 pending task id，重试只重试 TeamRun 创建。
  - 残余边界：移动端已有 Task 详情仍走 `MobileTaskDetail`，暂未提供已有 Task 创建 TeamRun 的入口；移动端新建任务弹窗可选择 TeamRun。

**创建 TeamRun 方式：**

- 从 TeamTemplate 快速生成。
- 临时选择多个 MemberPreset。
- 手动编辑本次 TeamRun 的成员快照暂不实现，后续需要时再补。

**验收条件：**

- 可创建/编辑/删除 MemberPreset。
- 可创建 TeamTemplate，但创建 TeamRun 不强制选择模板。
- 至少提供一个 UI 入口可以为 Task 创建 TeamRun；第一版可以先放在 TaskDetail，任务创建弹窗集成可后续做。
- TeamRun 成员配置复制为快照，后续修改 preset 不影响已有 TeamRun。
- 创建 TeamRun 后 TaskDetail 自动切到 Team Room。

## 8. Phase 8：实时事件与通知

**状态：已完成并合并。**

**目标：** TeamRun 相关状态变化能实时同步到 UI。

**建议文件：**

- 修改：`packages/shared/src/socket/events.ts`
- 修改：`packages/server/src/socket/socket-gateway.ts`
- 修改：`packages/web/src/components/GlobalRealtimeSync.tsx`

**实际落地：**

```text
team-run:invalidated
```

实际没有采用多个细粒度数据事件，而是采用统一 invalidation 事件：

- shared 中新增 `TEAM_RUN_INVALIDATED` / `TeamRunInvalidatedPayload`。
- payload 只包含 `teamRunId`、可选 `taskId` / `projectId`、`scopes`、`reason`。
- server EventBus 和 SocketGateway 转发该事件。
- TeamRun 创建、RoomMessage 创建、WorkRequest 状态变化、AgentInvocation 调度/终态变化、成员 stop、TeamRun 进入 review 时 emit invalidation。
- web 新增 `useTeamRunRealtimeSync`，只根据 scopes invalidate TanStack Query，不用 socket payload 覆盖缓存。
- 保留 5 秒轮询 fallback。

**验收条件：**

- RoomMessage 创建后前端实时出现。
- invocation 状态变化后 Team Status 实时更新。
- Reconciler 推进 Task 到 `IN_REVIEW` 后看板实时更新。

## 9. Phase 9：确认模式控制、Stop 能力与用户干预 UI

**状态：Phase 9A 后端/MCP 已完成并合并；Phase 9B 前端控制 UI 已完成并合并。**

**目标：** 让 Confirm 模式真正可用，并让用户/有权限成员能清楚处理队列、停止和确认。

**Phase 9A 已完成范围：**

- `POST /api/team-runs/work-requests/:id/approve`
- `POST /api/team-runs/work-requests/:id/reject`
- `POST /api/team-runs/work-requests/:id/cancel`
- `POST /api/team-runs/:id/members/:memberId/stop`
- MCP `approve_work_request`
- MCP `reject_work_request`
- MCP `cancel_work_request`
- MCP `stop_member_work`
- Scheduler `approveWorkRequestAndStartNext`
- Scheduler `stopMemberWork`
- 回归测试：停止 idle member 不会误触发其他成员 queued work 启动。

**Phase 9B 已完成范围：**

- 在 `packages/web/src/hooks/use-team-run.ts` 增加 approve/reject/cancel/stop mutation。
- 在 `packages/web/src/components/team/TeamStatusPanel.tsx` 将 pending approval、queue、active invocation 分区展示。
- `PENDING_APPROVAL` WorkRequest 支持 approve/reject/cancel。
- `QUEUED` WorkRequest 支持 cancel。
- `RUNNING` invocation 支持 stop，并展开二选一：stop only / stop + clear queue。
- 操作成功后通过 query invalidation/refetch 获取服务端真实状态，不依赖 action 返回体做本地乐观覆盖。
- 增加对应 i18n 文案。

**已完成 API：**

```text
POST /api/team-runs/work-requests/:id/approve
POST /api/team-runs/work-requests/:id/reject
POST /api/team-runs/work-requests/:id/cancel
POST /api/team-runs/:id/members/:memberId/stop
```

**UI 行为：**

- Confirm 模式下，`PENDING_APPROVAL` 的 WorkRequest 在 Team Status 中显示目标成员、来源消息、instruction、provider、capabilities、workspacePolicy。
- 用户可以 approve/reject/cancel。
- 成员运行中时，可以在 Team Status 中停止当前 invocation；停止是否清队列由显式选项控制。
- Room timeline 不写入冗余状态噪声；控制结果主要体现在 Team Status 中。

**已完成 MCP 行为：**

- `stop_member_work` 供有 `stopMemberWork` capability 的 Leader/Dispatcher 停止某个成员当前 session。
- `stop_member_work` 应支持是否清空目标成员队列。
- 被 stop 的 invocation 不触发 no-room-reply reminder。

**验收条件：**

- Confirm 模式下 mention 不会自动启动 invocation，而是进入待确认。
- Approve 后启动 invocation。
- Reject/cancel 不启动 invocation。
- Stop 当前成员工作后释放资源锁，不触发 no-room-reply reminder。
- 队列状态在 Team Status 中可见。

## 10. Phase 10：测试与验证

**状态：未开始。建议在 Phase 7/8 后做完整闭环验证；期间每个开发任务继续保持局部测试。**

**目标：** 覆盖最小闭环和关键状态机。

**建议测试：**

- 服务层单测：
  - RoomMessage mentions -> WorkRequest
  - post_room_message 自动绑定 senderInvocationId
  - 同成员运行中再次 @ 排队
  - Resource lock 阻止 shared workspace 并发写
  - Result Hook reminder
  - Reconciler 静默进入 `IN_REVIEW`
- MCP 测试：
  - Solo `get_context` 兼容
  - Team `get_context` 返回 team 字段
  - capability 限制
- 前端测试：
  - Room timeline 渲染
  - mention 消息发送
  - Team Status 展示
- E2E：
  - 创建 TeamRun
  - 发送 @
  - 看到 WorkRequest / running 状态
  - 模拟 Agent 回复 RoomMessage
  - 团队静默后进入 `IN_REVIEW`

**验收条件：**

- `pnpm -r build` 通过。
- 相关 vitest 通过。
- TeamRun 最小闭环可在浏览器中验证。
- Solo 模式任务仍可正常启动、续聊、查看日志和 merge。

## 11. 推荐任务拆分顺序

建议串行/并行关系：

1. **串行起点：Phase 1 数据模型与共享类型。**
2. Phase 2 后端 API 依赖 Phase 1。
3. Phase 3 Scheduler 依赖 Phase 2。
4. Phase 4 Result Hook/Reconciler 依赖 Phase 3。
5. Phase 5 MCP 可在 Phase 2 后开始，但完整 senderInvocationId 依赖 Phase 3。
6. Phase 6 前端 Room UI 可在 Phase 2 API 稳定后开始。
7. Phase 7A 设置页已审查通过等待合并；Phase 7B TeamRun 创建入口在 7A 合并后开始。
8. Phase 8 实时事件已完成，采用统一 `team-run:invalidated` 事件作为 query invalidation 信号。
9. Phase 9A 后端/MCP 控制入口已完成；Phase 9B 前端控制 UI 已完成。
10. Phase 10 测试贯穿每个阶段，最终补 E2E。

## 12. 下一批建议创建的 Agent Tower 任务

当前 Phase 1-9 已完成。下一批建议围绕“完整 TeamRun E2E 验证”和第一版收尾缺口展开：

### Task C：MemberPreset / TeamTemplate 设置页

状态：已完成并合并到 main。

范围：

- 新增团队设置页或集成到现有 settings。
- 提供 MemberPreset 创建/编辑/删除。
- 提供 TeamTemplate 创建/编辑/删除。
- 支持 avatar 内置选择；上传头像可先复用现有附件能力或作为后续增强。
- 不改 Task 创建入口。

验收：

- 能通过 UI 管理 MemberPreset。
- 能通过 UI 管理 TeamTemplate。
- Preset/template 保存后刷新页面仍可加载。
- `pnpm --filter web build` 通过。

### Task D：TaskDetail 创建 TeamRun 入口

状态：已完成并合并到 main。

范围：

- 在已有 TaskDetail 中，当 Task 没有 TeamRun 时提供创建 TeamRun 入口。
- 支持选择 TeamTemplate、多个 MemberPreset，或手动配置成员快照。
- 创建成功后自动切到 Team Room。
- 不强制改造 ProjectKanbanPage 的任务创建弹窗。

验收：

- 已有 Task 可从 UI 创建 TeamRun。
- 创建后可在 Room timeline 发送消息。
- 成员快照不随 preset 后续修改而变化。
- Solo Task 未创建 TeamRun 时原体验不变。

### Task E：Confirm 模式 WorkRequest 控制

状态：已完成并合并到 main。

范围：

- REST API 与 MCP 工具已完成。
- 前端 approve/reject/cancel/stop mutation 已完成。
- Team Status 中展示待确认请求和操作按钮已完成。
- Team Status 中展示可取消的 queued request 已完成。
- Team Status 中展示 running member 的 stop 按钮，并提供是否清空队列的显式选项已完成。
- 保持 Room timeline 不写入控制噪声。

验收：

- Confirm 模式下 mention 进入待确认。
- Approve 后启动，reject/cancel 不启动。
- Stop 当前成员工作后释放锁并刷新 Team Status。

### Task F：TeamRun 实时事件

状态：已完成并合并到 main。

范围：

- 增加统一 `team-run:invalidated` socket 事件。
- 前端用事件 invalidation 补强 5 秒轮询。

验收：

- RoomMessage 创建后无需等待轮询即可出现。
- invocation/workRequest 状态变化能实时刷新 Team Status。
- Solo 模式 socket 同步不受影响。

### Task G：完整 TeamRun E2E 验证

状态：未开始。

范围：

- 使用浏览器跑通创建 TeamRun、Room 消息、mention、Confirm approve、invocation 启动、Team Status 刷新。
- 覆盖 queued request cancel、running member stop only / stop + clear queue。
- 覆盖 Agent 通过 RoomMessage 发送 result 后，Result Hook 不再提醒。
- 覆盖团队静默后 Task 进入 `IN_REVIEW`。
- 验证 Solo 模式仍可正常创建 session、续聊、查看日志。

验收：

- 完整 TeamRun 关键路径可在浏览器中跑通。
- 失败项形成明确 bug 列表或修复任务。
- `pnpm -r build` 或等价构建命令通过。
