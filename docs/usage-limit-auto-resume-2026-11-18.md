# Automatic resume after usage limits: research and proposal (2026-11-18)

Status: phase 1 (the generic layer and Claude Code) is implemented on branch `at/d679ecb0`. It is
not committed or deployed yet. Sections 1–7 are the research. Section 8 describes the design as
built, and section 10 lists the user's decisions of 2026-11-18. Section 11 lists the files and the
verification, and section 12 covers the Codex plan for a later phase.

## 1. Goal

When a Claude Code or Codex turn stops because the account reached its usage limit, the session
sits idle until a person types "继续" (continue) after the limit has reset. Agent Tower should
recognise the stop, schedule a wake-up for the reset time, and resume the session itself.

The question asked first: can this stop be recognised from fixed codes rather than from message text?

## 2. Short answer

Yes, for both CLIs, but not in every Tower code path:

- **Claude Code 2.1.322** (installed here) reports the stop with structured fields in the
  stream-json output that Tower already reads. The fields include a reset timestamp in Unix
  seconds. A public field says the turn ended on a 429 rate limit (`error: "rate_limit"`). A
  public event carries the limit status and reset time (`rate_limit_event`, `status: "rejected"`,
  `resetsAt`). An internal field names the cause exactly (`api_error: "usage_limit_reached"`).
- **Codex 0.169.0** (installed here) has a dedicated code, `usageLimitExceeded`, and rate-limit
  snapshots with `resetsAt`. Both exist only in its app-server protocol, which Tower uses for the
  ASK and AUTO_SANDBOX permission modes. In `codex exec --json`, Tower's mode for all other
  permission modes, a failed turn carries only a message text.
- Before phase 1, Tower discarded all of this. Its parsers kept only the text, and the turn-failure
  event carried no reason.

## 3. Evidence: Claude Code 2.1.322

### 3.1 History on this host

- Tower database (`Session.logSnapshot`): 86 usage-limit stops in 28 sessions between 2026-11-04
  and 2026-11-18, all from Claude Code:
  - 83 stops on the 5-hour limit, for example "You've hit your 5-hour limit · resets 1:20am (America/Los_Angeles)".
  - 2 stops on the weekly limit, for example "You've hit your weekly limit · resets Nov 9, 5pm (America/Los_Angeles)".
  - 1 stop on a per-model limit: "You've reached your Fable limit. Switch to another model, or manage usage credits at …". This text gives no reset time.
- Claude transcripts (`~/.claude/projects/*/*.jsonl`) store the same stops as internal messages
  with structured fields. 92 such messages:

  | `error` | `apiError` | status | `rate_limit_info.rateLimitType` | count |
  |---|---|---|---|---|
  | `rate_limit` | `usage_limit_reached` | 429 | `five_hour` | 89 |
  | `rate_limit` | `usage_limit_reached` | 429 | `seven_day` | 2 |
  | `rate_limit` | `model_requires_usage_credits` | 429 | `seven_day_overage_included` | 1 |

  Every one of them has `rate_limit_info.status: "rejected"` and a `resetsAt`, including the
  Fable stop, whose text gave no time.
- `resetsAt` is in Unix seconds. For example, 1794993600 is 2026-11-18 09:20 UTC, which is the
  "resets 1:20am (America/Los_Angeles)" of the matching text.

### 3.2 What the stream-json output carries

Sources: the schema embedded in the 2.1.322 binary, the public Agent SDK TypeScript reference,
and a one-prompt Haiku probe run on this host. The probe's files were deleted afterwards.

| Signal | Value on a usage-limit stop | Public contract? |
|---|---|---|
| `rate_limit_event.rate_limit_info` | `status: "rejected"`, `resetsAt` (Unix s), `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`) | Documented as `SDKRateLimitEvent` (status, `resetsAt`, utilization). `rateLimitType` is emitted but not documented. |
| `assistant.error` | `"rate_limit"` | Yes (`SDKAssistantMessageError`). The docs say a 429 quota error gives `rate_limit`. |
| `assistant.api_error` | `"usage_limit_reached"` or `"model_requires_usage_credits"` | No, marked `@internal`. |
| `assistant.api_error_params.rate_limit_info` | which limit, and `resetsAt` | No, marked `@internal`. |
| `result.is_error`, `result.api_error_status`, `result.terminal_reason` | `true` (observed: Tower turns it into the error entry), `429` and `api_error` (expected from the docs, not captured live) | Yes. |
| Message text | "You've hit your … limit · resets …" | No. The CLI's schema says "the text stays the fallback and may change". |

Notes:

- The probe received a `rate_limit_event` on an ordinary successful turn. It had
  `status: "allowed_warning"`, `rateLimitType: "seven_day"`, `utilization: 0.55`, `resetsAt` and
  per-window data (`unifiedWindows.five_hour` and `unifiedWindows.seven_day`). The event therefore
  reaches Tower today; Tower's parser has no case for it and drops it.
- `error: "rate_limit"` on its own is ambiguous. The CLI's description of `usage_limit_reached`
  says the other refusals that share `rate_limit` carry no reset time: an organization policy, a
  temporary server throttle, a capacity switch-off, an entitlement refusal, or a 429 on an API key
  or a third-party cloud provider. A reset time, or `usage_limit_reached`, is what separates a
  usage limit from these.
- Claude Code's `StopFailure` hook is documented. It fires when an API error ends the turn, with
  input `error`, `error_details` and `last_assistant_message`. Its output is ignored, and it
  carries no reset time.
- Claude Code also contains an undocumented in-process wait for usage-limit resets. Its settings
  are the `CLAUDE_CODE_RETRY_WATCHDOG*` environment variables, and its Workflow runner prints
  "Workflow paused; waiting agents re-run shortly after the reset."

## 4. Evidence: Codex 0.169.0

### 4.1 `codex exec --json` (permission modes other than ASK and AUTO_SANDBOX)

- A probe with a nonexistent model printed only `{"type":"error","message":…}` and
  `{"type":"turn.failed","error":{"message":…}}`: no code and no rate-limit data. The probe used
  `--ephemeral`, so it left no session file.
- The usage-limit texts in the binary all start with "You’ve hit your usage limit". Codex writes
  a curly apostrophe (U+2019), while Claude Code writes a straight one, so a text matcher must
  accept both.
- Depending on the plan, the rest is an upgrade hint, a link to buy credits, or "send a request to
  your admin". A per-model variant reads "You’ve hit your usage limit for <model>. Switch to another
  model now, …".
- When Codex knows the reset time, the text ends with "Try again at <local time>." or "… or try
  again at <local time>.". This is display text, not a contract.

### 4.2 `codex app-server` (ASK and AUTO_SANDBOX)

Types generated with `codex app-server generate-ts` from the installed binary:

- `ErrorNotification { error: TurnError, willRetry, threadId, turnId }`. `turn/completed` carries
  `turn.error: TurnError` as well.
- `TurnError { message, codexErrorInfo, additionalDetails, misalignment }`.
- `CodexErrorInfo` values include `"usageLimitExceeded"`, `"rateLimitExceeded"`,
  `"serverOverloaded"`, `"sessionBudgetExceeded"` and
  `{ responseTooManyFailedAttempts: { httpStatusCode } }`.
- `account/rateLimits/updated { rateLimits: RateLimitSnapshot }`. This notification has no `threadId`.
- `RateLimitSnapshot` has `primary` and `secondary` windows, each
  `{ usedPercent, windowDurationMins, resetsAt (Unix s) }`. It also has `credits`, `planType` and
  `rateLimitReachedType`, one of `rate_limit_reached`, `workspace_owner_usage_limit_reached`,
  `workspace_member_usage_limit_reached`, `workspace_owner_credits_depleted` or
  `workspace_member_credits_depleted`.
- `account/rateLimits/read` returns the same snapshot on request.
- The app-server protocol is marked experimental.

### 4.3 Session files (both modes)

`~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` records:

- `task_complete.error.codex_error_info` in snake_case. Values seen here: `model_not_found`, `other`,
  and `{ response_too_many_failed_attempts: { http_status_code: 429 } }`. The binary contains
  `usage_limit_exceeded`.
- A `token_count.rate_limits` snapshot (`primary.resets_at`, Unix s) after each model call. This
  host has 12,104 of them.

This file format is internal to Codex.

### 4.4 History on this host

- No Codex usage-limit stop has happened here. The rate-limit snapshots show a Pro plan with usage
  credits and a single weekly window (10,080 min); for example, it was 29 % used on 2026-11-16.
- Codex failures that did occur here:
  - 429 retry exhaustion and "Concurrency limit exceeded for account", both on a third-party relay provider.
  - 401 errors.
  - `model_not_found`.
- The Codex part of this proposal is therefore built from the binary and its protocol, not from
  an observed stop.

## 5. What Tower did before phase 1

| Place | Behaviour |
|---|---|
| `output/claude-code-parser.ts` | No case for `rate_limit_event`. Ignores `error` and `api_error*`. Shows the text twice, as an assistant entry and as an error entry. `is_error` leads to `onTurnFailed()`. |
| `output/codex-parser.ts` (exec) | Keeps `message` only. |
| `runtime/codex-cli-control.ts` (app-server) | Keeps `error.message` and `turn.error.message` only. Drops `codexErrorInfo`. Drops `account/rateLimits/updated` at the `threadId` check. |
| `pipeline/agent-pipeline.ts` | Emits `session:turn-failed { sessionId }` with no reason. |
| `services/session-manager.ts` | Marks the session FAILED (synthetic exit code 1). A failed run does not advance the task, so the task stays IN_PROGRESS. Nothing schedules a resume. |

## 6. Cost of the current behaviour (Tower database, 2026-11-04 to 2026-11-18)

- 57 of the 86 stops were ended by a person's message, almost always "继续". The time from the
  reset to that message:
  - median 30 min;
  - 25 % of resumes came within 9 min;
  - 75 % came within 177 min;
  - the longest wait was 1,057 min (17.6 h).
- Summed over sessions, that is about 142 session-hours of idle time after the limit had already
  reset. Sessions overlap in time, so this is not wall-clock time.
- 25 stops ended turns that a Tower wake-up had started (10 sessions). Such a wake-up is spent
  (FIRED) and nothing re-arms it. For example, on 2026-11-18 a coordinating session's wake-up turn
  ended this way, and its chain of scheduled checks stopped until a person wrote "continue".

## 7. Who should schedule the wake-up

| Option | Verdict |
|---|---|
| A. The agent schedules its own wake-up | Impossible: no model call can run while the limit is in force. |
| B. A CLI hook (Claude `StopFailure` runs a script that calls Tower) | Claude only, since Codex 0.169 has no failure hook. The hook input has no reset time. Tower would have to write the users' CLI configuration. |
| C. Let the CLI wait inside its own process (Claude's retry watchdog) | Undocumented and Claude only. It holds a process and a "running" turn for hours, which conflicts with Tower's turn, queue and task model. |
| D. Tower classifies the failure from the output it already parses, then schedules a Tower wake-up | **Chosen and built.** It works for both CLIs, has the reset time, and reuses the durable `SessionWakeup` mechanism: it survives restarts, has cancel rules and a UI, and keeps the task IN_PROGRESS. |

## 8. Design as built (phase 1: generic layer and Claude Code)

The idea in one sentence: a parser can describe why a turn failed with one shared type, and one
server policy decides which causes get a wake-up. Today only usage limits produce a cause, and only
the Claude Code parser produces it.

### 8.1 The cause type

```ts
// packages/server/src/output/turn-failure.ts
interface UsageLimitTurnFailure {
  kind: 'usage_limit';
  resetsAt: string | null;   // ISO; when the provider says the limit lifts
  limitType: string | null;  // five_hour, seven_day, …
  code: string | null;       // usage_limit_reached, rate_limit, …
  message: string | null;    // the CLI's text, for the UI and the resume note
}
type TurnFailureCause = UsageLimitTurnFailure; // later phases can add kinds
```

### 8.2 Claude Code classification

The parser keeps the latest `rate_limit_event`. It also keeps the API error of the current
top-level turn, taken from the assistant message's `error`, `api_error`, `api_error_status` and
`api_error_params.rate_limit_info`. Sub-agent messages are ignored. When a top-level turn result
fails, the first rule that matches wins:

1. `api_error` on the result or the assistant message is `usage_limit_reached` or
   `model_requires_usage_credits`. The reset time comes from the error's own `rate_limit_info` when
   it has one. Otherwise it comes from the latest rejected `rate_limit_event`.
2. The assistant error is `rate_limit`, or the result has `api_error_status: 429`, and the latest
   `rate_limit_event` has `status: "rejected"` with a `resetsAt`. This rule uses only public fields.
3. Otherwise there is no cause. A 429 without a rejected limit event is a server throttle and is
   ignored, like every other error.

No rule reads the message text, because the CLI's schema says the text may change.

The cause is reported for two kinds of turn: the delivered turn, and turns the CLI starts by itself
(continuation turns after background work). It is not reported for pseudo turns. It is reported
before `onTurnFailed`. The stored API error is cleared at every top-level result, so it does not
carry over to the next turn.

### 8.3 Event route

- `OutputParser.onTurnFailureCause?(listener)` is optional, and only the Claude parser implements it.
- `AgentPipeline` emits `session:turn-failure-cause { sessionId, cause }`.
- CLI runs use one local event bus per run (`runtime/cli-driver.ts`). The driver forwards the cause
  as the runtime stream event `turn_failure_cause`. `SessionManager.handleRuntimeTurnEvent` then
  emits it on the global bus.
- `session:turn-failed` and the run lifecycle are unchanged. The proposal added the cause to
  `onTurnFailed`. A separate event replaced that, so no existing listener had to change.

### 8.4 Policy

`services/usage-limit-resume.ts` (`UsageLimitResume`) listens to `session:turn-failure-cause`. It
starts after the wake-up service when the server is ready, and stops before it at shutdown. A cause
gets a resume only when all of these hold:

- It is a usage limit with a reset time, and the reset is at most 35 days away.
- The global switch is on (`AppSettings.autoResumeAfterUsageLimit`, default true).
- The session is a task session: it has a workspace, is not a conversation, and is not a
  commit-message session.
- The session is not a team-run member, meaning no `AgentInvocation` row points to it.

The wake-up fires at `max(reset time, now) + 2 min`. Its reason is the CLI's message, cut to 500
characters. Its payload keeps the reset time, the limit type, the code and the message. Errors go
to the error log with the source `usageLimitResume`.

### 8.5 Wake-up rules

- The new `SessionWakeup` kind is `USAGE_LIMIT`. `kind` is a string column, so the new kind needs no
  migration.
- A `USAGE_LIMIT` wake-up becomes due at its `fireAt`, like `TIMER`. A resume that came due while
  the server was down therefore fires after the restart.
- A session has at most one active `USAGE_LIMIT` wake-up. When a later stop brings a later reset
  time, a pending resume moves to that time. Otherwise the existing resume is kept.
- Everything else is the existing wake-up behaviour, unchanged by the user's decision:
  - A wake-up is delivered only when the session has no running turn.
  - A wake-up is cancelled when the person stops the session or clicks cancel. It is also
    cancelled when the task leaves IN_PROGRESS, which delivery checks again.
  - The existing limits apply: 8 active wake-ups per session, and 24 delivered wake-ups per session
    per day.
  - While a wake-up is pending, the task stays IN_PROGRESS, because `task-outstanding-work.ts`
    counts every active wake-up.
- A person's message before the reset does not cancel the resume. If that message also hits the
  limit, its stop keeps or moves the same resume.
- Agent wake-ups (TIMER, SERVICE_EXIT) that come due before the reset are delivered as before.
  Their turn fails on the limit, which is itself a usage-limit stop, so the resume covers it. Their
  text is not lost, which was verified in a Claude transcript:
  - the person's later "继续" has the API-error message as its parent;
  - the parent of that API-error message is the failed wake-up message.

### 8.6 Resume note

```
[SYSTEM NOTIFICATION - NOT USER INPUT]
…standard wake-up header…

<agent_tower_wakeup kind="usage_limit" limit="five_hour" resets_at="2026-11-18T09:20:00.000Z">
Your previous turn stopped because the usage limit was reached: You've hit your 5-hour limit · resets 1:20am (America/Los_Angeles)
The limit has reset. Continue the work that was interrupted.
Commands, services or subagents that were running when the turn stopped may have finished or been stopped; check their state before relying on them.
</agent_tower_wakeup>
```

This relies on the CLI's own resume (`claude --resume`), the same path a person's "继续" takes. The
message that started the stopped turn is therefore still in the agent's history.

### 8.7 Settings and UI

- The switch is the column `AppSettings.autoResumeAfterUsageLimit` (Boolean, default true), added
  by migration `20261118000000_add_usage_limit_auto_resume`. The startup `prisma db push` adds the
  column, and existing settings rows get `true`.
- `GET` and `PUT /api/app-settings` carry the field.
- The General settings page has the switch "额度用尽后自动唤醒" ("Resume after usage limits"), on by
  default. Turning it off affects only later stops. Resumes that already exist stay, and each can be
  cancelled.
- The pending wake-up list at the bottom of the log shows "额度用尽，重置后于 {time} 唤醒" ({time} is
  the wake time, reset + 2 min) with the CLI's message and a cancel button. When the resume is
  delivered, the log summarises it as
  "额度已重置，继续执行".
- Not built: a note on the error entry itself that says when the session resumes. The pending list
  shows that information instead.
- The documentation site describes the feature in `guide/sessions.md`.

## 9. Impact, guarantees and what stays unsolved

What changes:

- Claude task sessions resume about 2 minutes after the reset. Before, the median wait for a
  person's "继续" was 30 minutes, and the worst case was 17.6 hours.
- Tower's own wake-ups are no longer lost to the limit. A wake-up turn that fails on the limit gets
  a resume like any other turn.
- While a resume is pending, the task stays IN_PROGRESS, and the log shows why.

What it does not solve, and the risks:

- Each session discovers the limit on its own, through one failed turn that uses no tokens.
  Sharing the limit across an account would need a map from providers to accounts, and Tower has
  none. `claude-code-default` and `108c3966` hit their limits at the same moments, so they are
  probably one account.
- All sessions on an account resume at the same moment and compete for the new window, as they do
  when a person types "继续" in each of them.
- Codex and the other agents are not covered yet (section 12).
- Claude's internal fields can change. The classifier treats them as optional and falls back to
  the public `rate_limit_event`. If both disappear, nothing is scheduled and the session stays
  stopped, as before. There is deliberately no fallback to the text.
- A weekly or per-model limit leads to a resume days later, up to 35 days. The resume is visible
  and can be cancelled.
- The existing wake-up limits also apply to resumes. If the session already has 8 active wake-ups,
  or has used 24 in the last day, no resume is created, and the error log records it.
- Edge on continuation turns: the resume is created asynchronously, a few database queries after
  the failed result. Suppose a turn that the CLI started by itself fails, and the process then
  exits at once. The session can end COMPLETED, and the task can move to review before the resume
  exists. Delivery then cancels the resume because the task is no longer IN_PROGRESS, which is the
  behaviour from before phase 1. A stop on the delivered turn is not affected: that session ends
  FAILED, and a failed run leaves the task IN_PROGRESS.

## 10. Decisions

Decided by the user on 2026-11-18:

- Phase 1 covers the generic layer and Claude Code. Codex and the other agents come later.
- Only usage limits get wake-ups. Other errors get none.
- The feature is on by default and applies globally. One global switch turns it off.
- Long waits are fine, including weekly and per-model limits, because a pending wake-up can be
  cancelled.
- A message sent before the reset follows the existing wake-up behaviour, and the wake-up logic does
  not change.
- Other wake-ups keep their original rules.
- Team-run members are not included.
- The coordinating session implements the work itself, without a subtask.

These parts of the proposal were dropped as a result:

- the text rule and the other failure kinds (`rate_limited`, `overloaded`, `auth`, `other`);
- cancelling a resume when a person sends a message or a later turn succeeds;
- holding agent wake-ups until the reset;
- the 5-turn loop guard (the existing limits of 8 active and 24 per day remain);
- cancelling pending resumes when the switch is turned off.

These defaults were kept:

- a fixed buffer of 2 min after the reset;
- one resume per session;
- task sessions only;
- no new OS or Feishu notifications.

## 11. Implementation and verification (2026-11-18)

Files, all on branch `at/d679ecb0` and not committed:

- Parser and event route: `output/turn-failure.ts` (new), `output/claude-code-parser.ts`,
  `output/index.ts`, `pipeline/agent-pipeline.ts`, `core/event-bus.ts`, `runtime/contracts.ts`,
  `runtime/cli-driver.ts` and `services/session-manager.ts`.
- Policy and wake-ups: `services/usage-limit-resume.ts` (new), `services/session-wakeup.service.ts`,
  `core/container.ts` and `app.ts`.
- Switch: `prisma/schema.prisma`, the migration, `routes/app-settings.ts`, and the shared types
  (`SessionWakeupKind`, `AppSettings`).
- Web: `GeneralSettingsPage.tsx`, `use-app-settings.ts`, `LogStream.tsx` and `i18n/messages.ts`.
- Docs: `packages/docs-site/docs/guide/sessions.md`.

New tests:

- `output/__tests__/claude-code-parser-usage-limit.test.ts` (9 cases). They cover:
  - a 5-hour stop, with the cause reported before the turn failure;
  - a stop with public fields only;
  - the per-model (Fable) limit;
  - a 429 without a rejected limit event, which must not trigger;
  - other failures;
  - a stop on a continuation turn;
  - no carry-over between turns;
  - edge cases of the classifier.
- `services/__tests__/usage-limit-resume.test.ts` (5 cases). They cover:
  - the event-bus wiring, with the wake-up at the reset + 2 min;
  - a reset time that has already passed;
  - a weekly reset, and implausible or missing reset times;
  - the switch;
  - the excluded sessions.
- `session-wakeup.service.test.ts`: one resume per session, moved to a later reset and fired like a
  timer.
- `session-manager.lifecycle.test.ts`: an end-to-end run through a controlled PTY. A Claude
  usage-limit stop reaches the global bus with its reset time, and the session ends FAILED.
- `routes/__tests__/app-settings.test.ts`: the switch is on by default, can be turned off, and
  rejects an invalid value.
- `LogStream.wakeups.test.tsx`: the label of the new kind.
- `translation-settings.service.test.ts`, changed: its legacy fixture now writes the settings row
  with SQL, because the current client reads back columns the legacy table lacks. Its upgrade check
  now also asserts that an existing row gets the switch turned on.

Results:

- The server `tsc --noEmit` and the web `tsc -b` pass.
- All new tests pass. These regression files also ran:
  - the output parsers and the pipeline;
  - the Claude and Codex driver and coordinator tests;
  - the database schema and upgrade tests, including a real CLI startup from legacy databases;
  - session manager lifecycle and team run, wake-ups, workspace services, database maintenance and
    translation settings;
  - the web files that use wake-ups or settings.
- Two cases in `session-manager.team-run.test.ts` failed before this change. They expect a prompt
  without the `<task_handoff_context>` block. Commit 088e1b8 added that block on 2026-10-26, after
  the test was last updated.
- Some failures depended on the load of this busy host, and pass when run alone or with a longer
  timeout:
  - 3 cases in `claude-cli-driver.test.ts`;
  - 1 case in `database-team-foundation.test.ts`;
  - `DesignSystemPage.test.tsx`;
  - `TranslationSettingsPage.test.tsx`, which needs more than the default 5 s per test here.
- Web lint finds no new problems. `GeneralSettingsPage.tsx` has 2 errors and 1 warning in older
  effects, the same as at HEAD.
- No run against a real usage limit has happened yet. The parser tests use stream-json fixtures
  built from this host's transcripts.

## 12. Later phase: Codex, then the other agents

Codex is the next phase. Its classification would fill the same `TurnFailureCause`:

- **Codex app-server** (ASK and AUTO_SANDBOX): `codexErrorInfo === "usageLimitExceeded"` gives
  `usage_limit`. The reset time is the latest `resetsAt` among the windows at 100 % in the newest
  `account/rateLimits/updated` snapshot. Tower must accept that notification even though it carries
  no `threadId`.
- **Codex exec** (all other permission modes) reports only text. A message that starts with
  "You’ve hit your usage limit" means a usage limit, and the match must accept both apostrophes.
  There are two choices for the reset time:
  - Simple: parse "try again at <time>". Codex runs on the same host, in Tower's time zone.
  - Exact: call `account/rateLimits/read` through a short-lived `codex app-server`. This costs about
    one process start per stop.
