# 自主合并方案：审查/负责人 Agent 通过 MCP 合并多工程师成果

> 状态：设计稿（已自审修订 v2）
> 作者：资深全栈架构师 Agent
> 日期：2026-06-11

## 1. 背景与目标

### 1.1 背景

TeamRun 多 Agent 协作模式下，多个工程师成员以 `workspacePolicy: 'dedicated'` 并行开发，
各自在独立 git worktree（分支 `team-{runId}/member-{id}`）中工作。当前成果合并回主工作区
只能由用户在 UI 手动触发，负责人/审查类 Agent 无法在审查或测试通过后自主完成合并闭环。

### 1.2 目标

- 审查 Agent / 负责人 Agent 可通过 MCP 工具在**审查通过（可选叠加测试通过）后**自主合并
  所有工程师的 dedicated workspace → TeamRun 主工作区。
- 合并行为受**服务端硬门禁**约束，不依赖提示词自觉。
- 冲突不阻塞整体：可部分成功，失败项生成返工闭环。
- 全程可审计、可观测（房间播报 + 审查记录表）。

### 1.3 非目标（本期不做）

- 主工作区 → 项目主分支（`mainBranch`）的自动合并（保留人工确认，可作后续演进开关）。
- 自动解决 git 冲突（冲突交还对应工程师处理）。
- 跨 TeamRun / 跨 Task 的合并编排。
- 分布式锁（当前单实例部署，沿用进程内 `TeamLockService`）。

## 2. 现状分析

### 2.1 已有地基（直接复用）

| 能力 | 位置 | 说明 |
|------|------|------|
| 合并实现 | `workspace.service.ts` → `mergeChildIntoParent()` | dedicated 子工作区合并回 TeamRun 主工作区，含 clean 检查、divergence 检查、`MergeConflictError`（带源/目标分支元数据） |
| 合并 REST | `POST /workspaces/:id/merge` | 支持 `x-agent-tower-invocation-id` header 作为锁持有者 |
| 项目级合并锁 | `team-lock.service.ts` → `project:{id}:merge` | mergeWorkspace 能力的成员调度时即持有，串行化合并 |
| 主工作区保护 | `assertNoActiveWriteSessions()` | 主工作区有活跃写会话时拒绝合并 |
| 成员身份注入 | `codex.executor.ts` 等 | `AGENT_TOWER_TEAM_RUN_ID` / `AGENT_TOWER_MEMBER_ID` / `AGENT_TOWER_INVOCATION_ID` 注入 Agent 的 MCP server 环境 |
| 能力校验框架 | `mcp/server.ts` → `requireCurrentMemberCapabilities()` | 查库比对能力位，缺失即抛错（现仅覆盖 3 个房间工具） |
| 分支状态查询 | `worktree.manager.ts` → `getBranchStatus()` / `isWorktreeClean()` | ahead/behind、工作区清洁检查 |
| 能力位预留 | `TeamMemberCapabilities` | `mergeWorkspace` / `markReadyForReview` / `readDiff` 已定义，默认 false |

### 2.2 现存缺口

1. **`merge_workspace` MCP 工具无任何能力校验**（`mcp/tools/workspaces.ts`）。
   通用工具与团队工具注册在同一个 MCP server（`createMcpServer()`），任意团队成员
   Agent 理论上可合并任意 workspace，`mergeWorkspace=false` 形同虚设。⚠️ 本方案顺带修复。
2. 无「审查/测试通过」的服务端门禁，无审查记录。
3. 无批量合并编排与冲突降级流程。
4. `markReadyForReview` 能力位定义了但无消费方。

### 2.3 权限生效现状（结论：三档）

- **硬校验**（仅 3 个工具）：`list_room_messages`→readRoom、`post_private_message`→postRoomMessage+mentionMembers、`stop_member_work`→stopMemberWork。
- **间接生效**：writeFiles / runCommands / mergeWorkspace 仅影响调度锁（`getRequiredLocks`）。
- **未生效**：文件/命令能力位管不到 PTY 内 Agent 的真实 shell 行为；mergeWorkspace / readDiff / markReadyForReview 无消费方。

> 配套措施（与本方案互补）：把成员 capabilities 自动注入 rolePrompt（事前软约束），
> 本方案提供事中硬拦截，房间播报提供事后审计 —— 三层纵深防御。

## 3. 方案设计

### 3.1 数据模型（schema.prisma 新增）

```prisma
// 工作区审查/测试记录（追加式，保留完整审计轨迹，不做 update）
// kind: REVIEW | TEST
// verdict: APPROVED | CHANGES_REQUESTED | PASSED | FAILED
model WorkspaceVerdict {
  id            String   @id @default(uuid())
  workspaceId   String
  teamRunId     String
  kind          String              // REVIEW / TEST
  verdict       String              // REVIEW: APPROVED/CHANGES_REQUESTED; TEST: PASSED/FAILED
  reviewedSha   String              // 结论针对的子工作区 HEAD commit（关键防御，见 3.4-G1）
  reviewerMemberId String?          // REVIEW 必填；TEST 为执行测试的成员
  reason        String?             // 结论说明 / 测试报告摘要
  createdAt     DateTime @default(now())

  @@index([workspaceId, kind, createdAt])
  @@index([teamRunId])
}
```

设计要点：
- **独立表而非 Workspace 加字段**：追加式写入保留全部历史（谁、何时、对哪个 commit、什么结论），满足审计。
- **`reviewedSha` 是门禁核心**：结论只对特定 commit 有效，杜绝「批准后又偷偷提交」的越权窗口。
- 不引入 TeamRun 配置项的新表；门禁策略放 `TeamRun.mode` 旁的新字段或 AppSettings（见 3.5）。

### 3.2 REST API（routes 新增/修改）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/team-runs/:id/mergeable-workspaces` | 列出全部 dedicated 子工作区 + 合并就绪度 |
| POST | `/workspaces/:id/verdicts` | 写入审查/测试结论（body: kind, verdict, reviewedSha, reason） |
| GET | `/workspaces/:id/verdicts` | 查询结论历史 |
| POST | `/team-runs/:id/merge-members` | 批量合并编排（body: workspaceIds?, 默认全部就绪项） |
| POST | `/workspaces/:id/merge`（现有，改造） | 增加门禁校验（见 3.4） |

`mergeable-workspaces` 响应示例：

```jsonc
[
  {
    "workspaceId": "ws-1",
    "ownerMemberId": "m-eng-a",
    "ownerName": "工程师A",
    "branchName": "team-xxx/member-abc",
    "headSha": "5f3a...",
    "clean": true,
    "aheadOfMain": 4,
    "behindMain": 1,
    "hasActiveInvocation": false,
    "latestReview": { "verdict": "APPROVED", "reviewedSha": "5f3a...", "reviewer": "m-lead" },
    "latestTest":   { "verdict": "PASSED",   "reviewedSha": "5f3a..." },
    "mergeReady": true,          // 服务端综合判定
    "blockers": []               // 不就绪时给出原因列表，供 Agent 自主决策
  }
]
```

### 3.3 MCP 工具（mcp/server.ts 注册，TeamRun 上下文内）

所有工具均走「MCP 薄壳 → AgentTowerClient(HTTP) → REST → Service」既有模式。

| 工具 | 能力校验 | 对应 REST | 实现复杂度 |
|------|---------|-----------|-----------|
| `list_mergeable_workspaces` | readDiff | GET mergeable-workspaces | 查询拼装，低 |
| `record_review_verdict` | mergeWorkspace（审查权随合并权） | POST verdicts (kind=REVIEW) | CRUD，低 |
| `report_test_result` | runCommands | POST verdicts (kind=TEST) | CRUD，低 |
| `merge_member_workspace` | mergeWorkspace | POST /workspaces/:id/merge | 复用现有 + 门禁，低 |
| `merge_all_member_workspaces` | mergeWorkspace | POST merge-members | for 循环编排，中（~120 行） |

同时修复存量缺口：
- 现有 `merge_workspace` 工具：在 TeamRun 上下文存在时（env 可判断），强制 `requireCurrentMemberCapabilities(['mergeWorkspace'])`；无 TeamRun 上下文（用户自己的 IDE/CLI 调用）保持现状。

### 3.4 服务端门禁（Merge Gate，防御核心）

`workspaceService.merge()` 在 TeamRun 子工作区路径上增加 gate（按序校验，任一失败返回结构化错误码）：

- **G1 结论绑定 commit**：存在 `kind=REVIEW, verdict=APPROVED` 的最新记录，且
  `reviewedSha == 子工作区当前 HEAD`。HEAD 漂移 → `REVIEW_STALE`，要求重新审查。
- **G2 职责分离**：`reviewerMemberId != workspace.ownerMemberId` → 否则 `SELF_REVIEW_FORBIDDEN`。
  工程师不能批准并合并自己的代码（即使他有 mergeWorkspace 能力）。
- **G3 测试门禁（可配置）**：策略开启时要求 `kind=TEST, verdict=PASSED` 且 sha 匹配。
- **G4 调用者能力**：请求携带的成员上下文（header `x-agent-tower-member-id`，由 MCP 层注入）
  必须具有 `mergeWorkspace=true`。
- **G5 子工作区静默**：owner 成员无活跃 invocation（防止边写边合）→ `OWNER_BUSY`。
- **G6 主工作区静默**：复用 `assertNoActiveWriteSessions()`（已有）。
- **G7 幂等**：workspace 已是 `MERGED` → 直接返回成功（no-op），附原 sha。

> 批量编排产生的「同步合并提交」例外处理见 3.5-步骤③。

### 3.5 批量合并编排（merge_all_member_workspaces）

```
输入: teamRunId, workspaceIds?（默认全部 mergeReady 项）
输出: { merged: [...], skipped: [{wsId, reason, conflictFiles?}], partial: boolean }

① 以 invocationId 为 owner 获取 project:{id}:merge 锁（已持有则复用）
   —— try/finally 保证 releaseByOwner，异常不泄漏锁
② 按 behindMain 升序排序（先合分歧小的，减少后续同步量）
③ for each workspace:
   a. 跑 Merge Gate（G1~G7），失败 → skipped.push({reason}) 并 continue
   b. 若 behind 主分支 > 0：服务端执行 git merge main → child（同步提交）
      - 同步产生冲突 → skipped.push({reason: 'SYNC_CONFLICT', files}) 并 continue
      - 同步成功后 HEAD 漂移属预期：校验改为
        「git log reviewedSha..HEAD 仅含本次编排创建的同步 merge commit」
        （commit message 带编排标记 + committer 校验），否则 REVIEW_STALE
   c. mergeChildIntoParent() → 成功则 workspace 置 MERGED
   d. 每步结果以 SYSTEM RoomMessage 播报到房间
④ 返回汇总报告；存在 skipped 时 partial=true
⑤ 不自动推进 Task 状态（保持现有 reconciler 的 TEAM_QUIESCENT → IN_REVIEW 机制，
   是否自动 DONE 留给用户配置，默认关闭）
```

冲突返工闭环：Reviewer Agent 拿到 skipped 列表后，对每个冲突项
`post_room_message` @对应工程师（生成 WorkRequest），工程师在自己 worktree 解冲突
（merge main → 解决 → commit）后重新 ready → 重新审查（HEAD 已变，G1 强制）→ 再次合并。

### 3.6 工作流时序（典型）

```
工程师A/B/C (dedicated, 并行开发)
   │ 完成 → post_room_message "ready for review" (markReadyForReview 置位)
   ▼
Reviewer Agent（被 @ 触发，capabilities: readDiff + mergeWorkspace）
   │ list_mergeable_workspaces
   │ get_workspace_diff(ws) 逐个审查
   │ （可选）@测试成员 跑测试 → report_test_result
   │ record_review_verdict(ws, APPROVED, headSha)
   │ merge_all_member_workspaces
   ▼
服务端: Gate 校验 → 顺序合并 → SYSTEM 播报 → 返回 partial 报告
   │ 冲突项 → Reviewer @工程师 返工 → 循环
   ▼
全部合并 → 团队静默 → reconciler 推 Task IN_REVIEW → 用户终审
```

### 3.7 配套：能力位注入提示词（用户提议，采纳为第一道防线）

调度器组装成员 prompt 时（现有 rolePrompt 拼装处）自动追加：

```
[你的权限] 你具备: readRoom, postRoomMessage, readFiles, writeFiles。
你不具备: mergeWorkspace, stopMemberWork —— 不要尝试调用相关工具，调用将被服务端拒绝。
```

定位：减少误操作与无效尝试（省 token、省轮次），**不可作为安全边界**
（LLM 可能被房间消息注入诱导忽略提示词）。安全边界始终是 3.4 的服务端 Gate。

## 4. 实现拆解（3 个 PR）

| PR | 内容 | 涉及文件 | 预估 |
|----|------|---------|------|
| PR1 数据模型+门禁 | WorkspaceVerdict 表、verdicts REST、merge gate（G1~G7）、修复 merge_workspace 裸奔 | schema.prisma、workspace.service.ts、routes/workspaces.ts、mcp/tools/workspaces.ts | ~400 行 |
| PR2 MCP 工具 | 5 个新工具 + http-client 方法 + mergeable-workspaces 查询 | mcp/server.ts、mcp/http-client.ts、routes/team-runs.ts、team-run.service.ts | ~450 行 |
| PR3 批量编排+播报 | merge-members 编排、SYSTEM 播报、能力位注入提示词 | workspace.service.ts、team-run.service.ts、team-scheduler.service.ts | ~350 行 |

前端可选增量（不阻塞）：workspace 列表显示 review/test 徽标、合并报告卡片。

## 5. 测试策略

- **单测（vitest，沿用现有 __tests__ 模式）**
  - Gate 矩阵：G1~G7 每条的通过/拒绝/错误码（重点：sha 漂移、自审自合、同步提交例外）
  - 编排：全成功 / 部分冲突 / 全冲突 / 空列表 / 重复调用幂等
  - 锁：批量合并中途抛异常后锁必须释放（finally 路径）
  - 能力校验：无 mergeWorkspace 成员调用 5 个工具均被拒
- **集成测**：真实 git 仓库 fixture（现有 worktree 测试基建）跑 3 成员并行 → 审查 → 批量合并全链路
- **回归**：现有 merge / scheduler / reconciler 测试不破坏

## 6. 风险与权衡

| 风险 | 应对 |
|------|------|
| 审查后代码变更（TOCTOU） | G1 reviewedSha 绑定 + 同步提交白名单校验 |
| 提示词注入诱导 Reviewer 乱合 | 服务端 Gate 兜底；审查权与作者分离（G2）；播报留痕 |
| 批量合并锁持有时间长 | 按 behind 升序减少同步量；单 workspace 失败不重试直接 skip；finally 释放 |
| 服务崩溃在合并中途 | 每个 workspace 的合并原子推进（git squash commit + DB 状态同事务窗口小）；重启后重跑幂等（G7） |
| 内存锁不支持多实例 | 当前单实例部署可接受；文档标注，未来换 DB 行锁/advisory lock |
| 误把测试 Agent 结论当真 | report_test_result 要求 runCommands 能力；报告原文落库可追溯 |

## 7. 备选方案对比（已评审）

- **A. 纯提示词约束**：零开发，无硬门禁，LLM 误操作/注入风险高 → 仅作第一道防线（3.7），不作为方案主体。
- **B. 服务端 Merge Gate + 批量编排（本方案）**：安全与自主性平衡，复用度最高。✅ 推荐
- **C. 事件驱动全自动合并**（测试通过事件直接触发，无 Agent 决策）：自动化最高但失去审查灵活性 → 作为 B 之上的可配置演进开关（门禁策略全开 + 定时触发即可达成，无需另起架构）。
