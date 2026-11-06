# Claude Code session continuity: turn boundaries are not run boundaries (2026-11-05)

Status: **implemented on branch `at/acb97751` (2026-11-06), not released, not deployed.** Section 8
records what was built, where the implementation deviates from sections 4.1–4.5, and how it was
verified. The analysis in sections 1–3 is unchanged.
Scope: the Claude Code CLI runtime path (`claude-code-parser.ts`, `agent-pipeline.ts`, `cli-driver.ts`,
`session-manager.ts`), the workspace-service tools (`mcp/tools/workspace-services.ts`,
`workspace-background-service.service.ts`) and the policy prompt
(`prompts/workspace-background-service-policy.ts`). The ACP runtime is only referenced as a precedent.

## 1. Current status summary

A Claude Code session on the production server (Agent Tower 0.7.5-beta.2, Claude Code 2.1.318,
model `claude-opus-5-5`) was "interrupted" three times in a row while waiting for a 40-minute PCB
autorouter. The user had to type "继续工作" twice. All three interruptions come from one design
conflict:

- Agent Tower treats the first top-level `result` event of a `claude -p` process as the end of the
  session's turn **and** as the signal to reclaim the process (SIGTERM to the whole tree 10 s later).
- Claude Code 2.1.x treats `result` as the end of a *turn* only. A print-mode run may legitimately stay
  open after `result` to wait for background work it started (background Bash commands, background
  subagents, `Monitor`, scheduled wakeups) and then **take further turns on its own**, each with its own
  `result`. On SIGTERM it kills that background work.

The model is told by its own harness that background work will re-invoke it, so it ends turns expecting
continuation. Inside Agent Tower that continuation is killed, the orphaned tasks poison the next start,
and the user sees a dead promise followed by an empty turn.

Evidence (session `2997b0a5-6fd1-4be5-b1dd-ba5084a73330`, task `db48a348`, workspace `at/e450ae6e`,
Claude transcript `a223e91a-d2ce-429e-a70a-fce56fc0cbf5.jsonl`; all times UTC, host is PST):

| Turn | PID | Lifetime | `result` → process exit | Exit code | What happened |
|---|---|---|---|---|---|
| 1–4 | 489452 … 522098 | 4–16 min | 0.7 s, 1.3 s, 1.2 s, 1.9 s | 0 | CLI exited by itself after `result` |
| 5 | 536593 | 09:23:21 → 15:59:02 (6 h 35 m) | **12.4 s** | **1** | killed by Tower while waiting for 3 background watchers |
| 6 | 630351 | 23:21:14 → 23:21:32 (18 s) | **11.1 s** after a *startup* `result` | **1** | killed by Tower in the middle of the real turn |
| 7 | 635871 | 01:53:04 → running | – | – | routing restarted as workspace service `x1-route` |

Turn 5 in detail:

- 15:55:13, 15:55:15, 15:58:47: the model started three `until … sleep 30` watch loops with
  `run_in_background: true` (timeouts 60, 60 and 50 min). The Bash tool answered "You will be notified
  when it completes".
- 15:58:50.2: `stop_reason: end_turn`, text "Both router runs are still going. I'll pick this up when the
  12-pass checkpoint or either run's end fires." 15:58:50.6: the CLI emitted `result`.
- 15:58:55: Tower's logical-completion path had already marked the session COMPLETED and spawned the
  COMMIT_MSG session `be0f2e8e`.
- ~15:59:00.6: `DUPLEX_OUTPUT_GRACE_MS` (10 s, `cli-driver.ts:48`) expired →
  `requestProcessStop()` → PTY wrapper `killTree('SIGTERM')`.
- 15:59:01.016: Claude Code's SIGTERM handler killed the three watchers (`[killed]` written to their
  output files, three `status: killed` task notifications queued in the transcript). The Freerouting
  containers running under the same tree died too (the model's next turn: "The previous session ended
  and took both router containers with it").
- 15:59:02.955: wrapper reported exit code 1 (signal death is mapped to 1), server.log:
  `Claude Code exited with non-zero code 1 … outputLength 0`.

Turn 6 in detail (the "已处理 8s" turn with no visible output):

- 23:21:14: `claude -p --resume …` started for the user's "继续工作".
- 23:21:18.7: at startup the CLI found the three orphaned tasks and queued a transcript-only system
  prompt ("3 background shell command tasks didn't finish before the previous session ended …").
- 23:21:21.1: that system prompt was recorded; 23:21:21.3: the CLI emitted a `result` for it
  (`num_turns` 0; the parser wrote `Tokens: 0 / 1000000`). The real user message was dequeued only at
  23:21:21.5.
- Tower took the startup `result` as the end of the turn: session COMPLETED, snapshot flushed,
  MsgStore released, COMMIT_MSG session `534321c1` spawned at 23:21:24.5, cleanup timer armed.
- Meanwhile the model worked on the real message: thinking 23:21:23, Bash call 23:21:24, tool result
  23:21:27.1, next API request 23:21:27.4.
- ~23:21:31: SIGTERM; 23:21:32.2: exit 1. None of the model's output reached the UI because the store
  was already finalized. Turn 7 opened with the synthetic assistant message "No response requested.",
  which the CLI inserts to close a turn that was cut mid-flight.

Turn 7 is about to repeat the pattern: the model restarted routing as the workspace service `x1-route`
(correct per the policy prompt), then announced it will "set up waiting for routing to finish". Nothing in
Tower wakes a session when a workspace service exits, so its only options are a sleep loop inside the
turn, a background watcher (which Tower kills), or ending the turn and waiting for the user.

## 2. What the current mechanism is for

Commit `7503b04` (2026-10-10, "修复 Claude 会话自动结束及停止时进程树清理超时") documented the intent in
`packages/docs-site/docs/guide/sessions.md`:

> Claude Code CLI 在收到最终结果后结束当前回复，并自动回收本轮进程；回答完成后即可继续发送消息。工具调用或子 Agent 的中间结果不会提前结束整个回合。

Three requirements are behind it, and all three remain valid:

1. **Fast completion for the user.** The UI must show "answer delivered" when the model's final text is in,
   not when the process finally exits (MCP teardown, slow drains). Hence `result` → `session:turn-completed`
   → `startSessionFinalization(logicalCompletion)` (`session-manager.ts:356`) → status, `session:completed`,
   auto-commit, task auto-advance, commit-message generation.
2. **No leaked processes.** The one-process-per-turn model must reclaim the process so the next follow-up
   can be admitted (`docs/process-leak-audit-2026-09-08.md`). Hence `onCompleted` →
   `schedulePipelineCleanup` → `requestProcessStop()` after 10 s with duplex, 250 ms without
   (`cli-driver.ts:47-48, 619-630`). The code comment states the assumption explicitly: "the child may keep
   its stdin/app-server open after emitting turn.completed" — lingering is treated as a defect.
3. **Sub-agent results must not end the turn.** `parent_tool_use_id != null` results are ignored as
   terminal (`claude-code-parser.ts:617`).

The assumption "after the top-level `result` the CLI has nothing legitimate left to do" was true for
`claude -p` when the mechanism was written. It is false for Claude Code 2.1.x. The official headless
documentation (https://code.claude.com/docs/en/headless, section "Background tasks at exit") states:

- "After Claude finishes its turn and stdin has closed, a `claude -p` run can stay open to wait for
  background work that Claude started."
- Background commands: "the run waits until the command exits or reaches its time limit. Claude then takes
  one more turn with the outcome."
- Background subagents and workflows: "the run stays open until that work completes".
- `Monitor`: "the run waits until the watch times out or the 10-minute cap ends the wait".
- "Unless a background command that the main conversation started is still running, Claude Code stops
  whatever is still running after 10 minutes of continuous idle waiting by default … set
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, or set it to `0` to wait without one."
- "On SIGTERM, Claude Code terminates the process tree of any Bash command that is still running."
- "When background work starts another turn, the run prints each turn's result".

The installed binary (`@anthropic-ai/claude-code/bin/claude.exe`, 2.1.318) contains
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` and the string "=0 to wait indefinitely", so the build on the
server implements this. Turns 1–4 (exit within 2 s) and turn 5 (still alive 10 s later with three
background commands pending) are exactly this behavior.

### 2.1 Verified on the installed build (probe run 2026-11-06 03:30 UTC)

A one-shot `claude -p --model claude-haiku-5-5 --output-format stream-json --input-format stream-json
--replay-user-messages` run in `/tmp`, stdin closed after one message ("run `sleep 15; echo PROBE_DONE`
in the background, then end your turn"), produced the following; times are seconds after spawn:

| +s | Event on stdout |
|---|---|
| 13.7 | `system/init` |
| 16.7 | replayed `user` message (the delivered prompt), then `assistant` tool_use Bash `run_in_background: true` |
| 27.6 | `system/background_tasks_changed` with `tasks: [{task_id, run_id, task_type: "local_bash", description}]`; `system/task_started` with `{task_id, tool_use_id, is_backgrounded: true}` |
| 30.8 | `assistant` text "WAITING" |
| 31.1 | `result` with `result_index: 0`, `origin: null`, `num_turns: 2`, `queued_turn_count: 0`, `terminal_reason: "completed"`, `stop_reason: "end_turn"` |
| 54.8 | `system/task_updated` `{patch: {status: "completed"}}`; `system/task_notification` `{status: "completed", summary, output_file}`; `system/background_tasks_changed` with `tasks: []` |
| 54.9 | second `system/init` (new turn, same process, same `session_id`) |
| 56.4 | `assistant` text "FINISHED" |
| 56.5 | `result` with `result_index: 1`, `origin: {kind: "task-notification", producer: "session-task", runId}` |
| 57.2 | process exit, code 0 |

The stream therefore carries everything Tower needs without heuristics: the set of pending background
work (`background_tasks_changed.tasks`), the turn ordinal within the process (`result_index`), who started
the turn (`origin`: `null` for the delivered message, `task-notification` for a CLI-started continuation),
and whether more turns are queued (`queued_turn_count`). The process ended by itself 0.7 s after its last
result, as turns 1–4 did. Tower's parser today reads only `subtype`, `is_error`, `result`, `num_turns`,
`duration_api_ms` and usage from `result`, and ignores every `system` subtype except `init` and
`api_retry` (`claude-code-parser.ts:310-318`).

## 3. Root cause, in three layers

1. **Lifecycle contract mismatch (primary).** Tower: "first top-level `result` ⇒ run over ⇒ reclaim within
   10 s". Claude Code: "`result` ⇒ turn over; the run may continue with more turns driven by background
   work, each ending in its own `result`". Every Claude-native continuation mechanism (background Bash,
   background `Agent`, `Monitor`, `ScheduleWakeup`/`/loop`, `CronCreate`) is therefore dead inside Tower,
   while the model's system prompt promises all of them.
2. **No delivery correlation for `result` (secondary, caused by 1).** The parser latches on the first
   top-level `result` (`turnTerminal`). The CLI also emits `result` for its own startup system prompts
   (orphan-task notification, `num_turns` 0). Tower cannot tell "the result of my delivered message" from
   "the result of a CLI-internal pseudo-turn", so after any killed run the *next* turn is finalized and
   killed before the model has answered, and its output is lost. Auto-commit, commit-message generation
   and task auto-advance also fire on the wrong event.
3. **No completion signal for Tower-owned long-running work (structural).** The policy prompt forbids
   shell backgrounding and mandates `start_workspace_service`, which is right for process ownership, but
   `handleProcessExit` (`workspace-background-service.service.ts:549`) only updates the DB row. A model
   waiting on a 40-minute job can only poll `get_workspace_service_logs` inside a live turn (the 6 h 35 m
   turn was largely this), or end the turn and hope. Either way the user experiences an interruption.

## 4. Design

Principles:

- **P1. A turn boundary is an observation, never a reclamation trigger.** Process reclamation is
  triggered only by: process exit, explicit stop, a user follow-up that supersedes a waiting run, server
  shutdown, or a Tower-side absolute ceiling.
- **P2. One process may carry several turns.** Each top-level `result` is a turn event; a turn that the CLI
  started itself (background outcome) is shown as such, not as a user turn.
- **P3. A `result` closes a delivery only after that delivery was acknowledged.** `--replay-user-messages`
  echoes the delivered user message on stdout; results that arrive before the echo (startup pseudo-turns)
  are not boundaries of the delivery.
- **P4. Tower-owned asynchronous work can wake the session.** Finishing a turn while a workspace service
  runs, and being re-invoked with its outcome, becomes a documented and supported pattern for every agent
  type, not only Claude.

### 4.1 Parser: per-delivery turn state (`claude-code-parser.ts`)

Replace the `turnTerminal` latch with per-process turn tracking driven by fields the CLI already emits
(section 2.1):

- Every top-level `result` is a turn event carrying `ordinal = result_index`, `startedBy` derived from
  `origin` (`null` ⇒ the delivered message; `kind: "task-notification"` ⇒ a CLI-started continuation or a
  startup pseudo-turn), `numTurns`, `terminalReason` and `queuedTurnCount`. Sub-agent results
  (`parent_tool_use_id != null`) stay non-terminal.
- The delivery is closed by the first top-level `result` whose `origin` is `null` **and** that follows the
  replayed `user` echo of the delivered text (`--replay-user-messages`). The startup orphan-notification
  `result` of turn 6 has a `task-notification` origin and precedes the echo, so it is recorded (usage, any
  `result` text) but never closes the delivery.
- `system/background_tasks_changed` replaces guessing: its `tasks` array is the pending-work set the
  parser publishes to the driver and the UI; `system/task_started`, `task_updated` and
  `task_notification` give per-task status, and each new `system/init` marks a turn start.

### 4.2 Driver: completion no longer stops the process (`cli-driver.ts`)

`onCompleted`/`onFailed` settle the turn promise (so the UI fast path, auto-commit and commit-message
work keep their current latency) and move the `ActiveCliTurn` into `WAITING_BACKGROUND` instead of
scheduling `requestProcessStop`. The duplex reader stays attached. Leaving `WAITING_BACKGROUND`:

- process exit (the normal case: the CLI exits on its own when nothing is pending, 0.7–1.9 s today);
  a `background_tasks_changed` with `tasks: []` after the last `result` means exit is imminent, and a
  process that still has not exited some seconds after that is treated as hung and stopped;
- a continuation turn (parser event) → `RUNNING` again under the same `ExecutionProcess` row;
- explicit stop, server shutdown, or a superseding follow-up (4.4) → existing `requestProcessStop` path,
  unchanged wrapper semantics (SIGTERM, SIGKILL after 5 s, tree-cleanup confirmation);
- absolute ceiling, a provider setting with a default such as 2 h; the same value is exported as
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` so the CLI and Tower agree (`0` for unlimited).

stdin handling is unchanged: Tower already writes the message and closes stdin (`duplex.end()`), which is
exactly the state in which the CLI waits for background work.

### 4.3 Session state: turn state separate from process state (`session-manager.ts`)

`RuntimeStateDto.turnState` gains `WAITING_BACKGROUND`. On a closed turn: flush the snapshot, emit
`session:completed` (input enabled, "answer delivered"), run auto-commit and commit-message generation as
today. Task auto-advance to IN_REVIEW and MsgStore release move to **run end** (process exit without a
pending continuation); this alone fixes the lost output of turn 6 and the premature IN_REVIEW. A
continuation turn re-enters RUNNING with a UI marker ("background work resumed the agent") and the same
"已处理" timer semantics.

### 4.4 Follow-up while a run is waiting

If the user sends a message while the process is in `WAITING_BACKGROUND`, the waiting run is stopped
(SIGTERM; the CLI kills its background tasks and the next start reports them as orphans, which 4.1 now
handles correctly), then the follow-up starts with `--resume` as today. The UI should say how many
background tasks will be cancelled. Writing the message into the live process instead is the resident
runtime of section 4.6.

### 4.5 Tower-native wake-ups (independent of 4.1–4.4; all agent types)

- `start_workspace_service` gains `wake_on_exit` and optional `wake_on_log_pattern`; new tools
  `wait_for_workspace_service(service_name)` (returns immediately with a ticket) and
  `schedule_wakeup(delay_seconds, reason)`; both persisted in the DB so they survive a server restart.
- New `MessageDelivery.origin` value `SYSTEM_EVENT`. Payload wrapped like Claude's own notifications
  ("[SYSTEM NOTIFICATION - NOT USER INPUT] workspace service x1-route exited with code 0; last 50 log
  lines: …") so the model cannot read it as user consent. Rendered in the UI as a system event, not a user
  bubble, and excluded from TeamRun heartbeat accounting like other local messages.
- Admission: deliver only when the session has no live turn; otherwise queue and coalesce; drop if the
  session was explicitly stopped or the task left IN_PROGRESS; cap automatic wake-ups per task
  (configurable, e.g. 20/day) to bound unattended spend; any user message or stop cancels pending
  wake-ups.
- Policy prompt amendment: "Do not wait for a service with sleep loops. Call
  `wait_for_workspace_service` or start the service with `wake_on_exit`, finish your turn, and you will be
  re-invoked with the outcome." Until 4.2 ships, add: "Claude background tasks, Monitor and ScheduleWakeup
  do not survive the end of a turn here."

### 4.6 Direction, not part of this change: resident CLI runtime

One `claude -p --input-format stream-json` process per session with stdin kept open, deliveries written
as stream-json user messages, the same way the ACP runtime already keeps Codex/Hermes connections alive
between turns (sessions.md: "一轮回复完成后，ACP 会话可能保留连接以便继续对话"). It removes the `--resume`
replay cost (turn 7 needed ~16 s from spawn to the first API request on a 35 MB transcript), makes every
Claude-native continuation mechanism work without orphan handling, and allows 4.4 to deliver into the
live process. Cost: ~250 MB RSS per idle `claude` process (measured on pid 635879), so idle eviction
(e.g. 15 min idle with no pending background work) and a "turns per ExecutionProcess" notion in
`RuntimeCoordinator` are required. 4.1–4.5 are sufficient for the reported problem and keep
process-per-turn; 4.6 is the natural next step.

## 5. Verification plan

- Parser lifecycle tests (`claude-code-parser-lifecycle.test.ts`): startup `result` before the replay echo
  does not complete the turn; two results in one process produce two turn events with correct
  `startedBy`; sub-agent results remain ignored.
- Driver lifecycle tests (`cli-driver-lifecycle.test.ts`): completion leaves the process alive; process
  exit, explicit stop, superseding follow-up and ceiling each reclaim it through the existing stop owner.
- Real-CLI integration (bounded, small model), exactly the probe of section 2.1: expect `result`
  `result_index 0`, a `task-notification` turn after the command ends, `result` `result_index 1`, process
  exit 0, one COMPLETED session with two turns in the UI and "waiting on 1 background task" in between.
- Wake-up path: start a 5-second workspace service with `wake_on_exit`, end the turn, expect one
  `SYSTEM_EVENT` delivery and a new turn; verify the cap and the cancel-on-user-message rule.
- Production symptom replay: the turn-5 tail (three background watchers) must end with a continuation
  turn after the first watcher exits, never with a SIGTERM.

## 6. Impact, guarantees, what stays unsolved

- Fixes all three observed interruptions: the killed continuation (turn 5), the mid-turn kill with lost
  output and premature auto-commit/IN_REVIEW (turn 6), and the "wait 40 minutes or give up" dilemma
  (turn 7) through Tower wake-ups.
- Guarantee after 4.2: Tower never signals a Claude process that has not exited, except on explicit stop,
  a superseding follow-up, shutdown or the ceiling. Process reclamation keeps the exact same wrapper and
  tree-cleanup path; only the trigger moves.
- Costs: a waiting run holds a `claude` process (~250 MB) plus its MCP server until its background work
  ends or the ceiling hits; unattended continuation turns and wake-ups spend tokens without a human in the
  loop, bounded by the ceiling, the per-task cap and (print mode) `--max-budget-usd`.
- Unsolved: a server restart still kills waiting runs (the CLI's orphan report covers the transcript; a
  restart-time re-delivery of wake-ups for services still RUNNING is a follow-up); 4.1–4.4 are Claude
  specific, Codex/ACP keep their own turn semantics and get only 4.5; users and the UI must accept that
  "answer delivered" and "run finished" are different moments.

## 7. Decision requested

Approve 4.1–4.5 for implementation on a branch with a beta build (no changes on the server), or choose
4.6 as the primary path. Recommendation: 4.1–4.5 first; they are small, independently testable, and
remove the root cause for Claude while giving every agent type a correct way to wait.

## 8. Implementation status (2026-11-06)

Everything below is on branch `at/acb97751`, uncommitted at the time of writing. Nothing was changed on
the production server.

### 8.1 What was built

- **Parser** (`claude-code-parser.ts`): results are classified with the CLI's own fields. The first
  top-level `result` whose `origin` is `null` (or absent, for older CLIs) closes the delivered message
  and notifies completion once; a `task-notification`-origin result that arrives before it (the startup
  orphan notice of turn 6) is recorded but never ends the turn; later top-level results are continuation
  boundaries (`onTurnBoundary`). `system/background_tasks_changed`, `task_started`, `task_updated` and
  `task_notification` maintain the pending-work set (`onBackgroundTasksChanged`, `getBackgroundTasks`),
  each `system/init` or first output after a result marks a turn start (`onTurnStarted`), and a task
  notification is shown in the log as a system line. Duplicate frames are ignored by `uuid` /
  `result_index` / content identity.
- **Driver** (`cli-driver.ts`, new `claude-run-lifecycle.ts`): for Claude Code the top-level result no
  longer settles the turn or arms the 10 s `requestProcessStop`. The turn settles on process exit using the
  recorded logical outcome (success or failure), so the run is reclaimed through the unchanged wrapper
  path when the CLI exits by itself. Two safety nets: a process that reports no pending background work and
  does not exit within `AGENT_TOWER_CLAUDE_IDLE_EXIT_GRACE_MS` (default 30 s) is stopped as hung; a run
  still waiting `AGENT_TOWER_CLAUDE_BACKGROUND_WAIT_MS` (default 2 h, `0` = unlimited) after its first
  result is stopped. The same ceiling is exported to the CLI as `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`.
  Both stops write a warning entry and settle the turn from the delivered result. A duplex EOF after a
  recorded result is no longer a protocol failure; `close()` of a waiting run settles it from its result.
- **Coordinator / state** (`runtime-coordinator.ts`, `contracts.ts`, shared `RuntimeStateDto`): the
  driver publishes `background_tasks_changed`; `RuntimeStateDto.backgroundTasks` carries the pending work
  to the UI through the existing runtime-state socket event, and is cleared when the turn ends.
- **Web** (`LogStream.tsx`, i18n): while the process waits, the thinking indicator reads
  "等待后台任务 (N)" with the task descriptions in its tooltip. Wake-up messages are rendered as a collapsed
  "系统唤醒" row instead of a user bubble.
- **Wake-ups** (`session-wakeup.service.ts`, `routes/session-wakeups.ts`, Prisma `SessionWakeup`,
  migration `20261106000000_add_session_wakeups`, MCP tools): `wait_for_workspace_service`,
  `schedule_wakeup` (30 s–24 h) and `start_workspace_service { wake_on_exit }`. A wake-up is delivered
  as a `SYSTEM_EVENT` message through `MessageDeliveryService` (no translation), tagged on the user entry
  (`metadata.origin`), only when the session has no active turn, never for a session the user stopped
  (`session:stopped` cancels pending wake-ups), at most 8 pending per session and 24 fired per session per
  day (`AGENT_TOWER_MAX_WAKEUPS_PER_DAY`). Service exits reach the service through
  `WorkspaceBackgroundService.onServiceExit`, which also captures the last 40 log lines. The policy prompt
  tells agents to use these instead of sleep loops.

### 8.2 Deviations from sections 4.1–4.5

- **No `WAITING_BACKGROUND` turn state and no continuation turns in the coordinator.** The run is one
  turn from Tower's point of view: `turnState` stays `RUNNING` from the delivered message until the
  process exits, and the `backgroundTasks` field tells the UI that the agent is waiting rather than
  thinking. This keeps the generation, finalization and auto-commit machinery untouched; auto-commit,
  commit-message generation and task auto-advance therefore happen at run end (for a run without
  background work that is 0.7–1.9 s after the result, as measured in section 1).
- **Follow-up while waiting** uses the existing `abandonTurn` path (SIGTERM the waiting run, then
  resume), so section 4.4 needed no new code; the CLI's orphan notice at the next start is handled by the
  parser rule above.
- **User messages do not cancel pending wake-ups** (section 4.5 said they would). Only an explicit stop,
  session or task deletion, the daily cap, or an unavailable session cancels them; a wake-up that arrives
  during a user-driven turn simply waits for the turn to end.
- The replay echo of the delivered message is not used for correlation; `origin` is sufficient and
  simpler.

### 8.3 Verification

- `claude-code-parser-lifecycle.test.ts` (updated) and new `claude-code-parser-continuation.test.ts`:
  pseudo-turn result ignored, legacy result closes the delivery, background task tracking and task
  notification lines, continuation boundaries without a second completion, continuation failure shown
  without failing the delivered turn.
- New `claude-run-lifecycle.test.ts`: idle grace, pending work suppresses the grace, continuation turn
  cancels it, ceiling, zero ceiling, no action after exit, environment parsing.
- `claude-cli-driver.test.ts` (real wrapper + fixture process, new modes `background`,
  `background-hang`, `idle-hang`): the process survives its result, the continuation turn and task
  notification appear in the log, `backgroundTasks` is published and cleared, the run ends on the fixture's
  own exit with code 0; the ceiling and the idle grace stop hung runs and still complete the delivered turn;
  a follow-up supersedes a waiting run. `cli-driver-lifecycle.test.ts`: the former "finishes Claude before
  exit" case now asserts the new contract.
- `session-manager.lifecycle.test.ts`: a Claude session stays RUNNING with `backgroundTasks` after its
  result, completes with the continuation output persisted on exit; a follow-up stops a waiting run and
  wake-up entries carry `origin: SYSTEM_EVENT`; the former "automatically reclaims" cases now assert the
  idle-grace stop.
- New `session-wakeup.service.test.ts` (real SQLite): timer firing, service exit with log tail, immediate
  delivery for an already exited service, deferral during an active turn, queue-full retry, stopped
  sessions, daily cap, pending limit, cancellation on `session:stopped`, workspace-only rule, message
  wording.
- `workspace-services.test.ts` (MCP), the affected web tests, server and web type checks.

Test-host caveat (2026-11-06, production box under load): `session-manager.lifecycle.test.ts` and the
replacement-flow cases of `claude-cli-driver.test.ts` are timing-flaky here independent of this branch. A
pristine checkout of the base commit failed 16 of 65 lifecycle cases (5 s `waitForEvent` timeouts) and 1–2
replacement cases ("Permission request was cancelled during delivery") in 2 of 3 runs; the branch shows the
same pattern, while every Claude-related lifecycle case and the four new run-lifetime driver cases pass in
isolation. Run the suites serially with `--hookTimeout=180000 --testTimeout=30000` and on a quieter machine
before release. `message-delivery.integration.test.ts` run alone with a 180 s test timeout passes 38 of 42;
the three cross-directory git conflict cases time out in a subprocess under load, and "freezes the exact
submitted user body" fails identically on the pristine baseline (its expectation predates the task-handoff
block in the prompt).

