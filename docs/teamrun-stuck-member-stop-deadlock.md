# Bug 定位：「卡死的成员无法停止」

> 定位阶段：只读分析，未修改 `packages/**` 任何代码；分析时间 2026-09-11T03:45Z ~ 04:00Z。
> **修复阶段（2026-09-11）：§5 的 P0-1 / P0-2 / P0-3 与 P1（部分）/ P2 已实施**，
> 实施记录、验证结果与残留风险见 **§7**。§1–§4 保留定位时的事实与因果。
> ⚠️ **§7.6 记录了一次回退**：orphan 首扫（`reconcileOrphanInvocations`）**仍只处理 `RUNNING`**，
> 不再扩展覆盖 `WAITING_ROOM_REPLY`；卡死的 `WAITING_ROOM_REPLY` 由**到期补催路径**回收。
> 因此本文中所有"orphan 首扫已覆盖 `WAITING_ROOM_REPLY`"的表述均已按实际代码更正。

## 0. 一句话结论

`TeamReconcilerService` 在**持有**成员级准入锁（admission barrier）时，调用了
`SessionManager.sendMessage()`，而后者会**再次申请同一把锁**。
这把锁是**进程内内存 Promise 链，没有超时、没有租约**，因此第一次补催
（`WAITING_ROOM_REPLY` 的 room reply reminder）就把它**永久焊死**：
watchdog 卡在 tick 里、`stopMemberWork` 从此永远等不到锁。

**这不是"会话内容多导致的性能问题"，是一个独立的死锁。**

---

## 1. 根因（已证实）

### 1.1 锁本身：内存 Promise 链，无超时

`packages/server/src/services/team-member-admission-barrier.ts`（全文 30 行）：

```ts
const memberAdmissionBarriers = new Map<string, Promise<void>>();
export async function acquireTeamMemberAdmission(teamRunId, memberId) {
  const key = `scheduling:${teamRunId}:member:${memberId}`;
  const previous = memberAdmissionBarriers.get(key) ?? Promise.resolve();
  ...
  const current = previous.then(() => hold);
  memberAdmissionBarriers.set(key, current);
  await previous;          // <-- 没有超时、没有 lease、没有抢占
  ...
  return () => { resolveHold(); ... };   // <-- 只有持有者自己调用才会释放
}
```

结论：
- **纯内存锁**（不是 DB 锁，也没有 heartbeat/lease 字段）；
- 只能由持有者调用返回的 `release()` 释放；
- 若持有者在临界区内永不返回，**没有任何机制能把它解开**；
- 进程重启即可清除（内存态），但 DB 状态不会因此改变。

### 1.2 死锁点：持锁 → 嵌套申请同一把锁

`team-reconciler.service.ts:191-225` `reconcileInvocation()`：

```ts
const releaseAdmission = await acquireTeamMemberAdmission(candidate.teamRunId, candidate.memberId);
try {
  result = await this.reconcileInvocationUnderAdmission(invocationId);   // ← 持锁期间
} finally {
  releaseAdmission();
}
```

`reconcileInvocationUnderAdmission` 在 `team-reconciler.service.ts:331-333` 内联发送补催：

```ts
if (invocation.sessionId) {
  await this.sendRoomReplyReminder(invocation.sessionId, invocation.id);   // ← 仍在持锁
}
```

`sendRoomReplyReminder`（`:1235-1254`）→ `sessionMessenger.sendMessage(...)`。
而 `sessionMessenger` 在生产接线中**就是 SessionManager 本身**：

- `session-manager.ts:196-202`：`new TeamReconcilerService({ sessionMessenger: this, scheduleReminders: false })`
- `member-heartbeat-scheduler.ts:44-48`：`new TeamReconcilerService({ sessionMessenger: deps.sessionManager, scheduleReminders: false })`

`SessionManager.sendMessage` 在 `session-manager.ts:732-736` **再次申请同一把锁**：

```ts
releaseTeamRunAdmission = await acquireTeamMemberAdmission(
  teamRunInvocation.teamRunId,
  teamRunInvocation.memberId,      // ← 与上面同一把 key
);
await this.assertTeamRunDispatchAdmitted(id, expectedTeamRunInvocationId);
```

因为该 session 确实存在 invocation 记录，`teamRunInvocation` 非空，所以这一行**必然执行**，
`await previous` 等待的正是自己持有的 `hold`，**永久挂起**（`finally` 里的 `releaseAdmission()`
永远不会执行）。**这是必然触发的自死锁，不是竞态。**

> 代码本身已经意识到了这个纪律：`team-scheduler.service.ts:989` 注释写着
> *"Never call startNextSessions recursively while holding this barrier."*，
> 且 `reconcileStalledInvocations`（`:430-438`）**刻意在 `releaseAdmission()` 之后**
> 才 `sendHeartbeatNudge`。**偏偏 room reply reminder 这一条漏了。**

### 1.3 触发链（时间线，日志 + DB 交叉验证）

| 时刻 (UTC) | 事件 | 证据 |
|---|---|---|
| 03:12:18.877 | invocation `9d55e79f` 创建 | DB `AgentInvocation.createdAt` |
| 03:17:59~03:18:02 | ACP 进程树清理失败（`owned tree still alive`） | `server.log` |
| 03:18:03.659 | **Session `67bcb01f` exit code 1**（`WAITING_ROOM_REPLY`） | `server.log` `session.exit` |
| 03:18:03.609 | Session 落库 `FAILED` | DB `Session.updatedAt` |
| 03:18:03.704 | invocation 进入 `WAITING_ROOM_REPLY`，`count=1`，下次补催 `+60s` | DB `updatedAt` / `nextRoomReplyReminderAt` |
| **03:19:03.701** | **补催到期** → watchdog tick → **死锁** | 此后 `roomReplyReminderCount` 恒为 `1` |
| 03:41 / 03:42 | Leader `stop_member_work` 两次 `-32001` | 报告 |
| 03:44:51 | 用户 UI 点停止，转圈不停 | 报告 |
| 04:00 | invocation 仍 `WAITING_ROOM_REPLY`，`count=1`，watchdog 无任何后续日志 | DB + `server.log` 尾部 |

**关键不可反驳的证据**：`roomReplyReminderCount` 停在 `1`。
若这次 tick 正常跑完，`:311-322` 的 CAS 会把它写成 `2`，`nextRoomReplyReminderAt` 推到 `+120s`。
它没有变 → 这次 tick **在写库之前就卡住了**，即卡在 `:332` 的 `sendRoomReplyReminder` 上。
`server.log` 最后一行就是 `03:18:03.659`，之后 watchdog 再无任何输出。

### 1.4 独立复现（不含 DB / 不含 ACP，纯锁语义）

用与 `team-member-admission-barrier.ts` 逐行等价的实现 + 与
`reconcileInvocation → sendMessage` 相同的调用顺序：

```
reminder pass   : TIMEOUT     ← reconcileInvocation 自我死锁
stopMemberWork  : TIMEOUT     ← 之后所有停止请求永久阻塞
```

脚本 `/tmp/at-deadlock-repro/repro.mjs`（约 40 行，可复跑）。

### 1.5 测试为什么没拦住（缺口）

`services/__tests__/team-reconciler.service.test.ts:1743-1769`
（`marks invocation waiting, increments reminder count, and sends a reminder...`）
正是这条路径，但它注入的是 **`createMessengerMock()`**：

```ts
expect(messenger.sendMessage).toHaveBeenCalledWith(sessionId, TEAM_ROOM_REPLY_REMINDER, undefined, invocation.id);
```

mock **不会申请准入锁**，所以测试永远绿。**真实 `SessionManager` 接线从未被这条路径覆盖。**

---

## 2. 为什么两条停止路径都失效（已证实）

两者**最终是同一个阻塞点**：

| 入口 | 路径 | 阻塞位置 |
|---|---|---|
| UI 停止按钮 | `TeamStatusPanel.tsx:499/513` → `useStopMemberWork` → `POST /api/team-runs/:id/members/:memberId/stop` → `routes/team-runs.ts:620-629` | `team-scheduler.service.ts:944` |
| MCP `stop_member_work` | `mcp/server.ts:504-518` → `mcp/http-client.ts:358-365` → **同一个 HTTP 路由** | 同上 |

```ts
// team-scheduler.service.ts:934-944
async stopMemberWork(teamRunId, memberId, options) {
  ...
  const releaseMemberSchedulingLock = await acquireTeamMemberAdmission(teamRunId, memberId);  // ← 永久挂起
```

**注意**：第 944 行在 `try` **之前**，一行业务逻辑都还没跑。所以：
- 停止请求**根本没执行**任何操作（没写 `dispatchRevokedAt`、没取消排队请求、没停进程）；
- 它只是安静地等一把永远不会释放的锁。

两者差异仅在**超时与反馈**：
- **MCP**：有请求超时，`-32001`（`ErrorCode.RequestTimeout`）→ Leader 看到明确报错；
- **UI**：`useMutation` 无超时（`use-team-run.ts:509-521`），POST 永不返回 →
  `stopMemberWork.isPending === true` → 按钮 disabled + 显示 "Stopping…" **无限转圈**，
  既不报错也不恢复。**这正是用户说的"点它停止也停止不了"。**

**附加结论**：`SessionManager.stop` 自身也依赖同一个 `pendingFinalization`
（`session-manager.ts:854`），而该 finalization 同样卡在 `reconcileInvocation` 里
（session exit 路径 `:2639`）。两条路互为因果、无法互相解救。

---

## 3. 会不会自愈？—— 不会（已证实）

### 3.1 自愈所需的唯一路径已被自己堵死

`WAITING_ROOM_REPLY` 的终态化**只能**靠 `reconcileDueRoomReplyReminders`
（`team-reconciler.service.ts:337-358`）按计数/退避推进：
`count >= maxRoomReplyReminders(10)` → `FAILED`（`:290-307`）。

而 watchdog 的 `tick()`（`member-heartbeat-scheduler.ts:87-124`）有 **`running` 重入闸**：

```ts
if (this.running) return;      // ← tick 卡住后，之后每一 tick 直接 return
this.running = true;
...
} finally { this.running = false; }   // ← 永不执行
```

第一次补催 tick 卡死 → `this.running` 永远为 `true` → **watchdog 全局停摆**。
`count` 停在 `1`，永远到不了 `10`。

### 3.2 即使补催修好，session 已死这条路仍然不终态

- `reconcileStalledInvocations`（`:411-415`）只查 `status: 'RUNNING'` → **跳过** `WAITING_ROOM_REPLY`；
- `reconcileOrphanInvocations`（`:452-456`）也只查 `status: 'RUNNING'` → 重启后同样**跳过**；
- `reconcileIncompleteTerminalInvocations`（`:482-484`）只捞**已终态但 WorkRequest 仍 STARTED** 的；
- `SESSION_ENDED` 这个状态在 `ACTIVE_INVOCATION_STATUSES` 里被**读取**，
  但**全仓库没有任何一处写入它**（`grep 'SESSION_ENDED'` 只命中读取侧）。

**即：session 进程死了、`Session.status = FAILED`，状态机完全不知道。**

### 3.3 因此（含"即使修好第 4 节 P0-1"）

- **当前实例**：永不恢复。已卡 ~27 分钟且无任何推进迹象。
- **若不修 P0-2（session 死亡终态化）**：即使修好死锁，补催会在死进程上反复发送，
  按 `DEFAULT_REMINDER_DELAYS_MS = [60s,120s,240s,300s×7]` 走满 10 次
  → **约 42 分钟**后才转 `FAILED`。
- **若连 watchdog 死锁一起算**：**∞（永不）**。

### 3.4 影响范围（重要：不是全团队停摆）

锁 key 是 `scheduling:${teamRunId}:member:${memberId}`，**按成员隔离**。
DB 复核确认同 TeamRun 内其他成员（`3ec6ffde` 测试工程师、`5db2bed7`、`660fbf15`）
的 invocation **仍为 `RUNNING`，未受影响**。
受损面 = ①该成员的一切停止/续催/回收；②**watchdog 全部 6 个阶段**
（`activeTurn reconciliation`、queue pump 等）——因为 tick 整体卡住。

---

## 4. 恢复办法（已区分可行 / 不可行）

### ❌ 不可行：继续点"停止"

第 944 行的锁在**进程内**、由死锁的 Promise 链持有。
任何 DB 修补都释放不了它；**只要不重启，`stopMemberWork` 永远挂起。**

### ✅ 可行 A（推荐，无需重启服务）：直接改 DB 该行终态

把卡死的 invocation 置为终态，UI 立刻恢复：

```sql
-- 只读确认（可先跑）
SELECT id,status,roomReplyReminderCount,nextRoomReplyReminderAt
FROM AgentInvocation WHERE id='9d55e79f-82c1-4817-b07a-1b441406ea22';

-- 修复：终态化 + 清理提醒游标
UPDATE AgentInvocation
SET status='CANCELLED', nextRoomReplyReminderAt=NULL, roomReplyReminderCount=0, firstNudgeAt=NULL
WHERE id='9d55e79f-82c1-4817-b07a-1b441406ea22'
  AND status='WAITING_ROOM_REPLY';

-- 对应的 WorkRequest 仍是 STARTED，需要一并收口
UPDATE WorkRequest SET status='CANCELLED'
WHERE id='4cddb7f4-a8d7-43a5-8bd0-2ae81c4752cd' AND status='STARTED';
```

- 优点：**不重启、不动正在跑的 ACP 会话**，不影响测试工程师的 WS 采样；
- 缺点：绕过 cleanup gate（该 session 进程树已死，`Session.status` 已是 `FAILED`，风险低）；
- 注意：**watchdog 仍卡在 `running=true`**，所以这个成员之后的**续催/回收/stop 依旧不工作**，
  直到重启。它只解决"UI 卡在等待回复"的即时可见问题。

> ⚠️ 上面那条 `WorkRequest` 的 id 取自本次 DB 查询；当前 TeamRun 内该成员对应的
> WorkRequest 为 `4cddb7f4-a8d7-43a5-8bd0-2ae81c4752cd`，**执行前请重新 SELECT 核对**。

### ✅ 可行 B（彻底）：重启服务

只有它能把**内存锁**和 `running=true` 一起清掉，并让所有成员恢复正常调度。

> **（已修复）** 定位时这里写着「单纯重启修不好这一行，因为 `reconcileOrphanInvocations`
> 只处理 `RUNNING`」。**这个前提至今仍然成立**（见 §7.6 的回退），但结论已经改变：
> 卡死的 `WAITING_ROOM_REPLY` 由**到期补催路径**回收 —— `reconcileDueRoomReplyReminders`
> （每 30s）→ `reconcileInvocation` → `isSessionRuntimeDead()` → `FAILED`，
> 这条记录在重启后下一轮补催就会被收口，**不再需要 A 的 DB 修补**。
> 定位阶段记录的原结论保留如下，仅作历史参考：
>
> > 单纯重启不能修好这一行 —— `reconcileOrphanInvocations` 只处理 `RUNNING`，
> > 不会捞 `WAITING_ROOM_REPLY`。所以**推荐 A + B 一起做**。

（当前约束下不应重启；建议等测试工程师 WS 采样结束后执行。）

---

## 5. 修复方案（按优先级）

> **状态：全部已实施**（实施细节、改动文件、验证与偏差见 §7）。下面保留方案原文，
> 并在每一项标注实际落点。

### P0-1 · 拆掉自死锁：持锁期间不做嵌套申请（✅ 已实施）

把 `sendRoomReplyReminder` 移出临界区，与 `sendHeartbeatNudge` 对齐：

- `reconcileInvocationUnderAdmission` 不再直接发送，改为**返回一个待执行动作**
  `{ kind: 'reminder', sessionId, invocationId }`；
- `reconcileInvocation` 在 `finally { releaseAdmission(); }` **之后**再执行该动作
  （即 `if (result.kind === 'terminal')` 的同一层级）。

收益：解除死锁；`reconcileStalledInvocations` 已经在用这个正确模式，属于**向既有约定收口**，
不是新抽象。风险低。

**回归测试（可复现路径）**：用**真锁**冒充 messenger，断言"在飞时"不再挂：

```ts
// 关键：messenger.sendMessage 内部真的去申请同一把成员锁
const messenger = {
  sendMessage: async () => { const rel = await acquireTeamMemberAdmission(tr, m); rel(); },
  ...
};
const p = service.reconcileDueRoomReplyReminders();
await expect(Promise.race([p, timeout(1000)])).resolves.not.toBe('TIMEOUT');
```

现有 `team-reconciler.service.test.ts` 的 `createMessengerMock()` 用例保留，
并新增真锁用例 `sends the room reply reminder only after releasing member admission`
（已实测：把代码临时还原成"持锁内发送"后该用例失败为 `TIMEOUT`，修复后通过）。

### P0-2 · 会话已死 → 终态化（✅ 已实施，判定条件有一处必要收敛）

在 `reconcileInvocationUnderAdmission` 的 `hasRoomReply` 判定**之外**，增加
"runtime 已死"的终态判定，直接把 invocation 置 `FAILED` 并走 `afterInvocationTerminal`
（释放锁、推进队列、review）。

- 复用既有 `session-runtime-cleanup-gate.ts`（`isSessionRuntimeCleanupConfirmed`），
  **没有**新建判定逻辑；
- `WAITING_ROOM_REPLY` + 死进程的情况**立即**终态，不必等 42 分钟计数走满；
- `reconcileOrphanInvocations` **不**覆盖 `WAITING_ROOM_REPLY`（只处理 `RUNNING`，见 §7.2 / §7.6）；
  卡死的 `WAITING_ROOM_REPLY` 由到期补催路径（`reconcileDueRoomReplyReminders` → `isSessionRuntimeDead()`）回收。

> ⚠️ **方案里"或 cleanup gate 确认无 turn / 无进程所有者"这一条不能单独作为死亡判定**
> （实施时收敛，理由见 §7.2）：**正常结束一轮的会话同样是"无 active turn + cleanup 已确认"**
> （`Session.status = COMPLETED`），那正是补催/续跑要走的合法路径。
> 因此最终判定是：`!hasActiveTurn` **且** `Session.status ∈ {FAILED, CANCELLED}` **且**
> cleanup gate 确认（`isSessionRuntimeDead()`）。gate 仍然必须确认：
> 只有它证明 owned 进程树真的不在了，标记 `FAILED` 才不会让同一成员并发起第二个 session。

**回归测试**（已实施，`team-scheduler.service.test.ts` / `team-reconciler.service.test.ts`）：
① 正常 COMPLETED 会话仍走补催（防过度终态化）；② 异常死亡会话立即 FAILED 且 WorkRequest 收口；
③ 启动 orphan 首扫**只**回收 `RUNNING`，健康的 `WAITING_ROOM_REPLY` 不被误杀
（`leaves a healthy WAITING_ROOM_REPLY invocation alone on the startup scan`）；④ `stopMemberWork` 在有限时间内返回。

### P0-3 · stop 路径必须有界（不让 UI 无限转圈）（✅ 已实施）

`stopMemberWork` 与 `stopSession` 对 barrier 的等待已加**超时**
（默认 30s，`DEFAULT_MEMBER_ADMISSION_ACQUIRE_TIMEOUT_MS`，可经
`TeamSchedulerDependencies.memberAdmissionTimeoutMs` 覆盖），
超时抛出 `MemberAdmissionBusyError`（`ServiceError`，`code: 'MEMBER_ADMISSION_BUSY'`，HTTP 409）。
前端 `useStopMemberWork` 增加 45s 客户端超时（`AbortSignal.timeout`），
超时抛错 → 面板既有的 `stopMemberWork.isError` 分支给出可见失败反馈，不再无限 "Stopping…"。

### P1 · barrier 本身加可观测性 / 租约（🟡 部分实施）

- ✅ 记录 `acquiredAt` 与持有者标签；持有超过 60s 打 `console.error`
  （`[TeamMemberAdmission] ... has been held by '<label>' for over 60s`）；
  超时错误的文案里也会带上当前持有者与已持有时长。
- ✅ 已给所有生产调用点补上 holder 标签（`stopMemberWork`、`stopSession`、
  `startNext`、`startNextSessions`、`reconcileInvocation`、`sessionManager.sendMessage` 等）。
- ❌ **没有做**超时强制释放（也不建议做）：该锁保证"同一成员不得并发起 session"，
  超时只放弃**等待**，并把该等待位从队列中"穿过"，持有者保持不变。
- ❌ 没有引入 lease/DB 持久化：重启清空内存锁的语义不变。

### P2 · watchdog 阶段隔离（✅ 已实施）

`tick()` 任一阶段卡住会让**全部 6 个阶段**停摆。已给每个阶段加超时
（默认 5min，`MemberHeartbeatSchedulerDeps.stageTimeoutMs` 可覆盖，含 `withStageTimeout`）：
超时打 `console.error`、跳过该阶段并继续后续阶段；被放弃的阶段仍在后台运行。
超时也返回 `false`，因此 orphan 首扫这种一次性阶段会在下一个 tick 重试而不是被标记为已完成。

---

## 6. 已证实 vs 推测

**已证实（代码/DB/日志/复现）**
1. admission barrier 是内存 Promise 链，无超时/租约（读源码 + 复现）。
2. `reconcileInvocation` 持锁期间调用 `sendMessage`，后者再申请同一把锁 → 必然自死锁（读源码 + 复现）。
3. 生产接线中 messenger 就是 SessionManager（`session-manager.ts:198`、`member-heartbeat-scheduler.ts:46`）。
4. 两条停止路径都收敛到 `team-scheduler.service.ts:944` 的同一把锁（读源码）。
5. UI 无超时 → 无限 `isPending`；MCP 有超时 → `-32001`（读源码 + 与现象吻合）。
6. `roomReplyReminderCount` 停在 `1`，`server.log` 尾部停在 03:18:03.659 —— 补催 tick 未完成。
7. `hasRoomReply` 为假（DB: 该 invocation 的 room message 数 = 0）。
8. 该 invocation 确实卡在 `WAITING_ROOM_REPLY`，session 确实 `FAILED`（DB）。
9. 无任何代码写入 `SESSION_ENDED`；orphan/stalled 两个 reconciler 都只处理 `RUNNING`（grep 全仓库）。
   （**保持原状**：orphan 首扫仍只处理 `RUNNING`；死掉的 `WAITING_ROOM_REPLY` 改由到期补催路径回收，见 §7.2 / §7.6。）
10. watchdog `running` 重入闸会导致 tick 永久停摆（读源码）。

**推测（未直接观测，但推理强）**
- 卡住的那一次 tick 具体发生在 `03:19:03` 之后的**哪一次** 30s tick（`:332` 之前无落库，无法精确定位）。
- 首次 `stopMemberWork`（03:41）与"持锁 tick"的先后顺序；两种顺序都指向同一把锁，不影响结论。
- `session.runtimeDispose: owned tree still alive` 是否与 ACP 崩溃同源（本次未追）。

**未做（受并发约束限制）**
- 未重启/未杀进程、未跑 ACP 会话、未写 `packages/**`；未跑集成测试（会与采样/运行中 DB 冲突）。
- 建议后续由测试工程师按 §5 的两个回归用例补验证。
  （§7 已按该建议补齐自动化回归；真实 provider 端到端行为仍由测试角色覆盖。）

---

## 7. 实施记录（2026-09-11）

### 7.1 改动清单

| 文件 | 改动 |
|---|---|
| `services/team-reconciler.service.ts` | P0-1：`reconcileInvocationUnderAdmission` 返回 `{ kind: 'reminder' }`，由 `reconcileInvocation` 在释放 barrier 后发送；P0-2：新增 `isSessionRuntimeDead()` 并在 `hasRoomReply` 之后终态化；orphan 首扫保持 `RUNNING` 单状态口径（`ORPHAN_RECOVERABLE_INVOCATION_STATUSES = ['RUNNING']`，`claimStalledTerminalUnderAdmission` 保留 `recoverableStatuses` 参数，见 §7.6）；各调用点补 holder 标签 |
| `services/team-member-admission-barrier.ts` | P0-3/P1：`acquireTeamMemberAdmission(..., { holder, timeoutMs })`、`MemberAdmissionBusyError`（409 `MEMBER_ADMISSION_BUSY`）、持有者标签 + 持有超 60s 告警；超时只放弃等待位，**不释放持有者** |
| `services/team-scheduler.service.ts` | P0-3：`stopMemberWork` / `stopSession` 的 barrier 等待加超时（`memberAdmissionTimeoutMs`，默认 30s）；start 路径补 holder 标签 |
| `services/member-heartbeat-scheduler.ts` | P2：`withStageTimeout()`，各阶段默认 5min 上限 |
| `services/session-manager.ts` | follow-up 领取 barrier 时补 holder 标签（`sessionManager.sendMessage`） |
| `packages/web/src/hooks/use-team-run.ts` | P0-3：`useStopMemberWork` 45s 客户端超时 + 超时错误文案 |
| `.agents/skills/agent-tower-dev/references/teamrun-patterns.md` | 同步 barrier 超时/标签语义与新的死亡回收规则 |

新增/扩展测试：

- `services/__tests__/team-member-admission-barrier.test.ts`（新）：stuck holder 下 fail fast；
  被放弃的等待位"穿过"且不破坏互斥；持有超时告警。
- `services/__tests__/team-reconciler.service.test.ts`：真锁 messenger 回归；
  正常 COMPLETED 会话仍补催；异常死亡会话立即 FAILED；orphan 首扫不误杀健康的 `WAITING_ROOM_REPLY`。
- `services/__tests__/team-scheduler.service.test.ts`：barrier 被占时 `stopMemberWork`
  返回 409 `MEMBER_ADMISSION_BUSY`；会话中途死亡被回收后 `stopMemberWork` 有限时间返回。
- `services/__tests__/member-heartbeat-scheduler.test.ts`：单阶段挂起不阻断后续阶段。

### 7.2 与方案的偏差（P0-2 判定条件收敛）

方案原文写的是"session `FAILED`/`CANCELLED`，**或** `hasActiveTurn === false` 且 cleanup gate 已确认"。
实施时把后半句收敛掉了，因为按字面实现会**误杀正常路径**：

- CLI 类 provider 每轮结束进程就退出，`Session.status = COMPLETED`；
- 此时 `hasActiveTurn === false`、cleanup gate 也**已确认**（进程树确实清完了）；
- 而这恰恰是补催/续跑要走的合法路径（`WAITING_ROOM_REPLY` 保留 runtime 供 reminder 续跑）。

因此最终判定 = `!hasActiveTurn` **且** `Session.status ∈ {FAILED, CANCELLED}` **且** cleanup gate 确认。
gate 不能省：只有它证明 owned 进程树真的不在，标 `FAILED` 才不会让同一成员并发起第二个 session。

启动首扫（`reconcileOrphanInvocations`）**保持 `RUNNING` 单状态口径**（见 §7.6 的回退）：
它无法区分"进程重启后 runtime 已脱管"与"健康的会话正等待汇报"，因为 cleanup gate 刻意忽略
`Session.status`，而 `WAITING_ROOM_REPLY` 正是健康会话的合法后续状态。
死掉的 `WAITING_ROOM_REPLY` 由到期补催路径回收：`nextRoomReplyReminderAt` 过期 →
`reconcileDueRoomReplyReminders` → `reconcileInvocation` → `isSessionRuntimeDead()`
（`Session.status ∈ {FAILED, CANCELLED}` + cleanup gate 确认）→ `FAILED`，
同样要求 cleanup gate 确认。

### 7.3 验证结果

| 命令 | 结果 |
|---|---|
| `pnpm --filter @agent-tower/server build` | 通过（prisma generate + tsc） |
| `pnpm exec vitest run team-member-admission-barrier / member-heartbeat-scheduler` | 6 passed |
| `pnpm exec vitest run team-reconciler.service / team-scheduler.service` | 159 passed |
| `pnpm --filter web build` | 通过（vite build，仅有既有的 chunk 体积告警） |

回归有效性单独验证：把 P0-1 临时还原成"持锁内发送"后，
新用例 `sends the room reply reminder only after releasing member admission`
失败为 `TIMEOUT`（即真实死锁），修复后通过 —— 证明该用例确实覆盖真实接线。

### 7.4 重启后当前这条卡死记录是否会自动回收

**会，不需要手工改数据库。** 依据（只读核对运行中 DB）：

- 卡死 invocation `9d55e79f-82c1-4817-b07a-1b441406ea22`：`WAITING_ROOM_REPLY`，
  `roomReplyReminderCount = 1`，`nextRoomReplyReminderAt` 已过期；
- 对应 session `67bcb01f`：`FAILED`，`runtimeLaunchState = PROCESS_RECORDED`，
  claim 计数 `1/1/1` 自洽；
- 其 `ExecutionProcess`：`cleanupState = CONFIRMED`，ownership 字段（claim number /
  runtimeInstanceId / pid / processGroupId / birthMarker / ownershipToken）齐全，
  即 cleanup gate 会判定 `confirmed`。

重启后它的回收路径：

1. **到期补催阶段**（每 30s）：`nextRoomReplyReminderAt` 早已过期 → `reconcileInvocation`
   → `isSessionRuntimeDead()` → `FAILED`（这是 `WAITING_ROOM_REPLY` 的**唯一**回收路径）；
2. **orphan 首扫**（启动后 ~10s）：只扫 `RUNNING`，**不会**碰这条 `WAITING_ROOM_REPLY`，
   因此这里不再作为它的兜底（见 §7.6）。

回收会经 `afterInvocationTerminal` 把 `WorkRequest 4cddb7f4-...` 从 `STARTED`
收口为 `FAILED`、释放 workspace 锁并推进队列；watchdog 的 `running = true` 也随重启清空。

### 7.5 残留风险与未做项

- **未做**：barrier 的租约/持久化、超时强制释放（有意不做，会破坏"同一成员不并发起 session"）。
- **未做**：失败 invocation 的自动重派。异常死亡会话现在直接 `FAILED`，
  WorkRequest 一并 `FAILED`；是否自动重试该请求仍由负责人/PM 决策。
- **风险（已消除）**：曾经把启动首扫扩展到 `WAITING_ROOM_REPLY`，会把重启瞬间遗留的
  "健康等待汇报"会话误判失败。该扩展已在 §7.6 回退，首扫恢复 `RUNNING` 单状态口径；
  首次回收窗口从"启动后 ~10s"变为"下一轮补催（≤30s）"。
- **风险（既有，未变）**：如果 owned 进程树始终无法确认清理（quarantine / `cleanup_unconfirmed`），
  成员仍会被阻塞——这是有意保留的安全边界，只解决了"永久无界"而不是"永不阻塞"。
- **未验证**：真实 ACP provider 的端到端崩溃恢复（本次只跑单测 + 构建，未重启服务、未跑 ACP 会话）。
- 前端只加了成员停止按钮（`useStopMemberWork`）的客户端超时；`useRemoveTeamRunMember`（移除成员）走同一个
  `stopMemberWork`，服务端已有界（409），前端展示沿用既有错误分支，未单独加客户端超时。
- ✅ **已补**：`useStopSession`（`POST /sessions/:id/stop` → `stopSession`）此前只有**服务端** barrier 等待超时，
  进入临界区之后等待的 `SessionManager.stop → pendingFinalization`（进程树清理）本身没有超时，
  该路径可能长时间 pending。现已照 `useStopMemberWork` 的模式补上 **45s 客户端超时**
  （`STOP_SESSION_REQUEST_TIMEOUT_MS` + `AbortSignal.timeout`），超时映射为明确错误文案，
  经既有 `onError` 分支给出可见失败反馈，按钮不再无限 "Stopping…"。
  服务端语义未变（清理未确认就不能宣称停止成功），客户端只是不再无限等待。

### 7.6 回退记录：orphan 首扫恢复 `RUNNING` 单状态口径（2026-09-11）

P0-2 实施时曾把 `ORPHAN_RECOVERABLE_INVOCATION_STATUSES` 从 `['RUNNING']` 扩成
`['RUNNING', 'WAITING_ROOM_REPLY']`，让启动首扫顺带回收卡死的等待汇报记录。
**该扩展已回退**：`packages/server/src/services/team-reconciler.service.ts:41` 现在只含 `'RUNNING'`。

回退原因（`reconcileOrphanCandidate` → `claimStalledTerminalUnderAdmission`）：

- orphan 判定**不要求 session 已死亡**。它只要求"内存 pipeline 已丢失 + cleanup gate 确认"，
  而 cleanup gate 刻意忽略 `Session.status`；
- `WAITING_ROOM_REPLY` 同时是**健康会话的合法后续状态**（一轮跑完、正在等待汇报）；
- 因此宽口径会在服务重启时**误杀**那些"会话正常跑完、只是还没发汇报"的成员。
  实测证据：当时库里就存在另一个 TeamRun 的负责人成员处于该状态，重启即会被判 `FAILED`。

**不扩围也能回收**：卡死的 `WAITING_ROOM_REPLY` 走**到期补催路径**——
`nextRoomReplyReminderAt` 过期 → `reconcileDueRoomReplyReminders`（每 30s）→
`reconcileInvocation` → `isSessionRuntimeDead()`（`Session.status ∈ {FAILED, CANCELLED}`
且 cleanup gate 确认）→ `FAILED` → `afterInvocationTerminal` 收口 WorkRequest。

**代价**：首次回收窗口从"启动后 ~10s"变为"下一轮补催（≤30s）"，可接受。

**防回归**：`services/__tests__/team-reconciler.service.test.ts` 新增
`leaves a healthy WAITING_ROOM_REPLY invocation alone on the startup scan`；
原代码里也保留了说明为何这里只能包含 `RUNNING` 的注释。

### 7.7 暂缓清单（只登记，未实现；2026-09-14）

> 来源：ACP 断开排查（测试工程师 2/2）+ 负责人裁定（房间消息 `c52b2700`：两条硬化点"暂不实现…不会丢"）。
> **登记不等于排期**，只记录口径与依据位置。

1. **清理路径两处硬化**（同一路径的加固，**不是**本次观测到的致因；该路径影响所有会话停止）
   - **先落标记后校验**：进程行可能先被写成 `cleanupState=CONFIRMED`，之后才确认进程真正退出
     （排查记录：CONFIRMED 比进程实际退出早 1.9 秒）。硬化方向：确认清理后再落标记。
   - **无子进程时仍上报清理完成**：没有 child 记录时 `stop` 仍会宣称清理完成。
     硬化方向：无子进程不能等价于"已确认清理"。
   - 挂起理由（负责人）：两条都是同一路径的加固、非本次致因；当时优先级是先做 P0-2（会话进行中卡顿），之后单独派。
2. **队列串行用例在同毫秒入队时排序不稳的既有 flake**
   - 用例：`packages/server/src/services/__tests__/team-scheduler.service.test.ts:2593`
     `serializes direct TeamRun session stop against concurrent queue admission`。
   - 现状：多数查询已用 `[{ createdAt: 'asc' }, { id: 'asc' }]` 破平局，但
     `packages/server/src/services/team-run.service.ts:971`、`:1216`、`:1293` 仍只按 `createdAt` 排序，
     同一毫秒入队的记录顺序不稳定。
   - 本轮未改测试也未改排序（属 TeamRun 队列语义，需与队列口径一并确认）。

