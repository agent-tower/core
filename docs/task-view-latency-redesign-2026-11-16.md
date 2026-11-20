# Task view latency redesign (2026-11-16)

**Git work deployed; first log changes implemented on 2026-11-19, not yet deployed.** The command
helper, pushed git state and versioned file diffs are in `at/67407e89` at `3065a3e` and run in
production as 0.7.5-beta.7. On 2026-11-19 the owner asked for the slow task opening to be fixed.
The light log view, the translation read and the patch and read fixes in 5.C–5.D are implemented
in `at/7dd18ece`, with immutable caching of web assets and batched delivery reads (5.E). In an
A/B over HTTP/2 on copies of production sessions and a slow link, the first log row appears 8–30%
sooner on a first visit, 16–54% sooner with the app open and 43–59% sooner on a returning visit,
whose board also appears about 2 s sooner. Translated text appeared in the same frame as the log
in 57 of 60 opens of the branch; on the base build it followed a median 0.5–7.5 s later (6.1).
Storage changes and tail-first loading remain open (5.C.3–5.C.4, 10).
[Completed steps and commits](#71-completed-steps)

## 1. Summary

Opening or switching tasks used to start a burst of git commands. The old web client polled for the
change list and status and polled again for each open diff. Each request repeated work for the same
directory. On this Linux host starting a child blocked the server's JavaScript thread, so even requests
that only read the database queued behind git. Large logs added a separate cost. Section 2 gives the
production baseline before these changes.

By default on Linux, a small helper starts git commands and reads the state of each viewed checkout,
or *worktree*. All viewers of that directory share the result. The browser subscribes and asks for an
open file's diff again when that file's version changes. In the browser acceptance run an idle task
with settled edits made **zero git HTTP requests in 130 s**. Its server ran **one `git status` per
30 s safety check**. [Measured results](#61-measurements-of-the-implementation) · [After deployment](#after-deployment-what-to-check)

| Workstream | Result on this branch |
|---|---|
| A. Process starts | Done. Buffered commands, including git, can start in the command helper. Interactive processes keep their existing owners (5.A). |
| B. Git state and diffs | Done. State is pushed over Socket.IO. Desktop and mobile use REST on first load or if the subscription fails. A file's version identifies its diff (5.B). |
| C. Log loading | Partly done, not deployed. The task view opens with a light log view and loads long tool outputs on expansion. The metadata patch no longer reloads the log, and a finished session is downloaded once (5.C.2, 5.C.6). Storage and tail-first loading are open. |
| D. Translation overlays | Partly done, not deployed. One bounded read starts with the log read, and the server reuses each transcript's block index. Polling slows to 60 s when nothing is in progress (5.D). |
| E. Other requests | File-diff cancellation is implemented. Since 2026-11-19, hashed web assets are cached as immutable, and a log view reads its messages' deliveries in batches (not deployed). Provider lookup, the delivery idle poll and server-side cancellation for logs and translations are open (5.E). |
| F. Measurement | The server logs event-loop delay, command dispatch, git activity and memory. The journal script reports HTTP latency. Production comparison follows deployment (5.F). |

Related work includes the [session UI latency study](perf-session-ui-lag.md),
the [conversation patch contract](perf-p0-2-conversation-patch-contract.md) and
the [Linux process-scope design](process-scope-redesign-2026-11-04.md).

## 2. Evidence before deployment

### 2.1 Production request latency

The original latency study and coordinator review used Fastify request logs from the systemd journal.
The table covers 23,022 requests from 2026-11-15 22:53 to 2026-11-16 04:26 PST on the old server.
The percentiles p50, p90 and p99 are the times within which 50%, 90% and 99% of requests completed.
Route names below omit the `/api` prefix.

| Route | Requests | p50 | p90 | p99 | Max |
|---|---:|---:|---:|---:|---:|
| `GET /git/changes` | 1,277 | 1.5 s | 11.0 s | 19.4 s | 54 s |
| `GET /workspaces/:id/git-status` | 1,264 | 1.8 s | 5.9 s | 15.6 s | 77 s |
| `GET /git/diff` (committed) | 725 | 4.8 s | 23.8 s | 28.3 s | 32 s |
| `GET /sessions/:id/logs` | 247 | 0.29 s | 1.3 s | 4.2 s | 10.6 s |
| `GET /sessions/:id/translations` (first page) | 3,432 | 0.13 s | 1.0 s | 3.4 s | 43 s |
| `GET /message-deliveries` (session, pending + sent) | 7,933 | 0.10 s | 1.0 s | 3.9 s | 51 s |
| `GET /providers` | 56 | 6.0 s | 16.1 s | – | 68 s |
| `GET /system/slash-command-catalog` | 209 | 0.12 s | 6.3 s | 13.5 s | 25 s |

| Other baseline measurement | Conditions | Result |
|---|---|---|
| Task open to log response | 156 opens paired from the first task body request to completion of the following log request. The pairing window for request starts was 3 s. | 0.91 s p50, 1.9 s p75, 2.5 s p90, 11.6 s maximum, before network transfer and rendering |
| Plain requests overlapping other work | Coordinator's journal re-check, 2026-11-16 | 9 ms p90 with nothing heavy in flight, 110 ms with git, 490 ms with git and large-log work |
| Message-delivery polling | All scopes in the original journal window | 43% of requests |

### 2.2 Where the main thread spent its time

The old view polled changes every 1.5 s and git-status every 2 s. A full pair of reads started six
and eight git commands respectively. Review diff cards had their own 1.5 s timers. Unrelated requests
could queue behind the synchronous part of each process start.

| Original study or coordinator observation | Conditions | Result |
|---|---|---|
| Child starts and main-thread CPU | 20 s with task `at/cf836fc2` open, 926 MB server resident set size (RSS) | 2.8 starts/s, almost all git. The main thread used 12% user and 27% kernel CPU, about 97 ms of kernel time per start. |
| Health endpoint in the same sample | No-op HTTP handler | 6 ms p50, 190 ms p90, 293 ms maximum |
| Child starts without a viewer | 20 s observation | 0 |
| Kernel share of main-thread CPU | Coordinator's 84 min re-check | 48% |
| Starts by kind | Coordinator's pre-change rate derived from journal requests with one open task | About 6,500 git starts, 7 agent turns and 17 terminal starts per hour |

### 2.3 Cost of starting one child process

On this host Node 24.22.2 (libuv 1.52.1) and node-pty both used `fork` to start children. The caller
blocks while the operating system creates the child and sets up its address space. V8, Node's
JavaScript engine, marks its heap mappings `MADV_DONTFORK`. Linux skips those mappings and their page
tables for the child. It duplicates the page tables of inherited mappings and shares the underlying
pages copy-on-write. Only memory outside the V8 heap contributes to this size-dependent fork cost.
Buffers and native heaps are examples.

| Memory used to grow the test process | Caller blocked per direct start |
|---|---:|
| 863 MB of V8 heap arrays | 1.5 ms |
| 739 MB of Buffers outside the V8 heap | 99 ms |

The step 1 handoff records this Linux memory comparison. The original latency study had grouped
processes by total resident memory. Its Node `spawn('/bin/true')` results below varied with host
load. The memory mix in those samples was unspecified.

| Caller RSS in the original Node experiment | Median of 8 starts, host idle | Median of 8 starts, host busy |
|---|---:|---:|
| 64 MB | 5 ms | 14 ms |
| 400 MB | 17 ms | 120 ms |
| 900 MB | 105 ms | 290 ms |

The original glibc experiment also found that `posix_spawn` avoided the fork cost. Section 5.A.5
records the decision on a native implementation. Section 6.1 gives the measured cost of dispatching
real git commands through the helper.

### 2.4 Where the production server's memory was resident

The original study read `/proc/1560837/smaps` at 926 MB of resident set size (RSS), the memory
resident in RAM for a process.

| Region in the original Linux sample | Resident |
|---|---:|
| 8 glibc allocator arenas | ~480 MB |
| Small mappings attributed to V8 heap pages | ~191 MB |
| Main native heap (`brk`) | ~99 MB |
| Other regions | ~150 MB |

The eight arenas matched the count of Prisma query-engine worker threads. The study suggested that
multi-MB log rows passing through those threads could account for the arenas. It did not establish
their owner. Only inherited, non-V8 mappings contribute to the fork cost in section 2.3. The separate
measurements of the command helper in section 6.1 include both used and retained memory.

### 2.5 Logs and translations

These figures are from the original study's read-only database and journal sample. The git work
leaves full-log serialization and the translation overlay reads as possible contributors to task
latency after deployment.

| What was measured | Conditions and result |
|---|---|
| Stored logs | 400 sessions held 72.5 MB in `Session.logSnapshot`. The largest log was 5.17 MB (2,866 entries). |
| JSON cost | Parsing the largest log took 98 ms and serializing it took 202 ms on the idle host, excluding Prisma's row decoding. |
| Translation reads | The three largest logs had 504, 414 and 346 translated segments. Pages of 100 each reread the log. |
| Repeated log reads | The 247 log requests in 2.1 went to 22 sessions. The 5.1 MB session `441e96ab` alone was fetched 22 times in that window. |

Section 5.C.1 describes the metadata patch rejection and terminal revalidation that cause full reads.

### 2.6 Sources and measurement conditions

Sections 2.1–2.5 describe the **pre-deployment baseline**. The original study used read-only journal,
`/proc` and SQLite observations on the production host, plus isolated process-start and JSON
benchmarks. The VM shares CPU with other tenants, so host load matters. The task-open timings end on
the server. Browser checks in section 6.1 concern git traffic, diff rendering and cancellation.

The following Agent Tower handoffs identify the measurement records and implementation decisions.
The original analysis and the journal script handoff also preserve the context of the earlier design.

| Source named in this document | Task ID |
|---|---|
| Original latency study (detailed baseline tables at `220cc2c`) | `cd0993d4-3312-44ae-8bcb-4aa34c599484` |
| Coordinator review and decisions | `c49b5e1c-b644-48a7-97e5-ce91e52a036c` |
| Journal script and baseline comparison | `cdcb8427-c97e-4054-98b0-242241bed3c5` |
| Step 1, helper benchmark and deadlines | `6aafa6e3-0857-4427-a030-1d24e3701791` |
| Step 2, state computation and parity | `fae37ced-d436-46a8-ab09-48b1fc02c352` |
| Step 3a, socket contract and built-server check | `59be9e7e-89d6-475c-bced-bfb75f6c1c24` |
| Step 3b, browser subscription implementation | `34f93a44-444d-4794-9c31-da0ee51d9215` |
| Step 4, real-browser checks for steps 3b and 4 | `cd989de3-16a0-4b8a-afb1-a5b12ea9a08c` |
| Hardening, memory, helper replacement and rebase detection | `6852c719-8134-4acc-b5cf-6c6ae5865eaf` |

The [helper memory benchmark report](../packages/server/scripts/bench-command-helper-memory.md)
contains the workloads, time series, allocator comparison and synchronous timings behind section 6.1.

## 3. Background

### 3.1 Starting child processes

An *owned command* is a command for which Tower collects the output and waits for the process tree
to finish. The application calls `runOwnedCommand()` in `packages/server/src/utils/owned-child-process.ts`.
On Linux with process scopes enabled, the existing `agent-tower-scope` binary supervises one such
tree. Starting that binary used to fork the large server. The command helper moves that start to its
own Node process (5.A). Terminals and agent sessions use separate streaming or pseudo-terminal paths.

### 3.2 Git freshness in the task view

The change list, ahead/behind counts and operation state let a viewer follow work in the checkout.
The original watcher in `7a3c378` watched every active worktree from server startup, with a watch per
working folder and additional recursive git-directory watches. Shared refs could wake many workspaces.
`29f6424` reduced the number of watches. After file-descriptor exhaustion, `93981c9` removed the
watcher and introduced the web timers measured in section 2.

The July timers ran for each viewer. The merged implementation watches git metadata only for
registered directories. Views of the same directory share that work. The existing
`workspace:git_changed` event still signals changes such as a new base branch. The versioned
subscription in 5.B.6 carries the state itself.

### 3.3 The session log snapshot

- **What it is.** `Session.logSnapshot` holds the whole conversation (`NormalizedConversation` JSON).
- **Who reads it.** The REST route serves the snapshot to clients, which reconcile it with live
  patches by sequence number. The server also uses it to restore a new in-memory store for a later
  turn, register translations at checkpoints and extract token usage.
- **The 15 s checkpoint** (`SNAPSHOT_CHECKPOINT_MS`) keeps SQLite off the per-patch hot path while
  bounding loss on a crash. Terminal states force a final flush.
- **Earlier proposals.** `docs/perf-session-ui-lag.md` measured these costs in September (P2-1, P2-2) but
  deferred the fixes.

### 3.4 Translation overlays

- The server registers session translation sources from saved checkpoints. On a read,
  `matchesSnapshot` compares a source with the current log. This hides earlier translations of
  blocks revised by Agent Client Protocol (ACP) history reload, as well as cancelled paragraphs
  whose source rows still exist (`translation.service.ts`).
- The client polls every 5 s (`use-session-translations.ts`, introduced in `0f4485f`). Polling
  covers lost read access, an expired cookie, a server-side disconnect and an event missed while
  joining the room. The hook has no `disconnect` handler.

### 3.5 Other timers

- **Message deliveries.** Polled every 5 s, or every 1 s while one is pending. This is on top of the
  `message-delivery:invalidated` event and a refresh on reconnect, which already exist. The polling also
  came in with `0f4485f`.
- **Provider availability.** `GET /providers` probes executables. CLI providers of the same agent
  and runtime type share a result within that request. ACP providers can resolve provider-specific
  executables. PATH lookup uses `execFile` with `which` on Unix or
  `where` on Windows (`executors/index.ts`, `utils/index.ts`).

### 3.6 How other projects do it

The coordinator's review recorded the following behaviour from the source of three comparable tools
on 2026-11-16.

- **VS Code git extension** (`extensions/git/src/repository.ts`).
  - File-change events from the working tree and `.git` trigger a refresh.
  - It waits 1 s for quiet, and runs `git status` only when the window is focused and no git operation
    is running. Then it pauses 5 s.
  - It skips huge repositories.
- **vibe-kanban** (`crates/services/src/services/diff_stream.rs`, `filesystem_watcher.rs`). This is the
  closest comparable product.
  - While someone views a diff, the server watches that worktree and the git files `HEAD` and
    `logs/HEAD`, and pushes changes to the browser.
  - Timers only do cheap checks: a database value every 1 s, the HEAD commit every 5 s.
  - The watcher is released when the viewer leaves.
  - On Linux it adds one watch per directory and skips ignored directories.
- **Codex** (`codex-rs/core/src/turn_diff_tracker.rs`, `codex-rs/git-utils/src/status.rs`).
  - It records the changes its own patch tool makes instead of asking git.
  - `git status` and diffs run on demand with timeouts.
  - Simultaneous status requests for one repository share one run.

These examples informed the choice in 5.B to watch a viewed directory's git metadata, group change
signals and share the result. A periodic safety read covers edits that leave no metadata signal.

## 4. Goals and constraints

The git work aimed to keep command starts off the server's request thread, share computations across
viewers and stop repeated work for idle views. It had to preserve process ownership, REST access,
conflict authorization and the ability to run Tower without a command helper. A safety check gives
users a way to see edits by external tools that emit no Tower event.

Reducing the cost of opening a long log is a separate goal. Any future change must preserve snapshot
and patch ordering, translation staleness checks and access revocation. The original study describes
an oversubscribed Linux VM with 8 vCPUs, 8 GB of RAM and no swap. The production service was only
observed. Implementation acceptance used isolated processes. The application also has to run on
macOS and Windows and in the desktop app.

## 5. Design

### 5.A Process starts in the command helper

#### 5.A.1 Which process starts a command

| Work | Owner on this branch |
|---|---|
| Buffered `runOwnedCommand()` calls | The active command helper starts them. These include git CLI calls, agent CLI detection and install checks, and the Codex CLI capability service's version probe. |
| Git state, line counts and working/branch file diffs | The active git state service runs the commands locally. With a helper, the server sends one state or diff request to it (5.B). |
| Streaming `spawnOwnedProcess()` callers, including installer tasks | The server starts and owns the process. |
| Terminals, interactive agent CLIs and workspace services | Their existing pseudo-terminal (PTY) owners start them. ACP adapters also keep their server-side process owner. |
| `which`, direct `execFile` capability probes, setup scripts, editor launches, notifications and cloudflared | Their existing server-side call sites start them. Prisma schema sync also runs from the server entry. |

#### 5.A.2 Dispatch, failure and shutdown

Both server entries, `packages/server/src/cli.ts` and `index.ts`, start the small Node **command helper**
at boot, before database sync and application startup. Its entry is `runtime/command-helper/helper-main.ts`.
It loads the owned-command runtime and git state modules. The database, HTTP service and sockets stay
in the server. The **scope supervisor** is the separate Linux binary that owns each individual command
tree. When supervision is available its parent-death signal follows the process that started it.

The server sends the command, arguments, current working directory, effective environment, timeout and
output limit with a request ID over Node's inter-process communication (IPC) channel. The helper uses
`runOwnedCommandInProcess()` and replies with collected stdout and stderr or the error. The caller's
environment is captured at dispatch. Each cancel message names the request and goes to its owner.
A closed server channel or SIGTERM starts cleanup in the helper. Application shutdown stops every
helper the server owns.

| Condition | Result |
|---|---|
| Command exits unsuccessfully, times out, is cancelled or exceeds its output limit | The command's exit code and signal, or `ETIMEDOUT`, `ABORT_ERR` or `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, reach the caller with captured output where available. Argument validation inside the helper can arrive as a rejected promise. |
| Helper exits or the request cannot reach it | Outstanding requests without a result fail with `ERR_COMMAND_HELPER_EXITED`. The client allows up to 1 s for queued replies if the process has exited with the channel still connected. New calls use the local path. Owned commands are never replayed, since a write may already have taken effect. |
| A helper cannot serialize its reply | It reports `ERR_COMMAND_HELPER_PROTOCOL`. |
| A helper misses the result deadline | The client rejects that request with `ERR_COMMAND_HELPER_UNRESPONSIVE`. During normal operation it stops dispatching to that helper, sends SIGTERM, then SIGKILL after 4 s if necessary. Other outstanding requests follow the exit path. |
| Application requests a stop | Concurrent stops share a wait. At 20 s a supervised helper is killed and its exit is awaited. For a running helper without supervision the wait rejects with cleanup pending, leaves the helper alive and can be tried again. The 20 s bound is on the wait **before escalation**. |

A positive command timeout `T` gives the client a result deadline of `T + 10 s`. The grace allows
6 s for tree cleanup and 4 s for returning the result. An abort arms a deadline 10 s from
cancellation, and the earlier deadline wins. A zero timeout has no result deadline until cancellation.
The state/register deadline is 70 s (60 s computation plus grace). The file-diff deadline is 110 s,
including up to 40 s for the patch and its size probe after the state lookup. These defaults are in
`runtime/command-helper/client.ts` and `git/state/git-state-limits.ts` under `packages/server/src/`.
Only the read-only git state, registration and diff calls retry once on
`ERR_COMMAND_HELPER_EXITED` when the caller still wants the result.

The client gives a new helper 15 s to report ready. The crash backoff table lists 1, 2, 5, 10 and
30 s. With the default limit, failures one through four schedule the first four delays. The **fifth
consecutive failure** logs the give-up decision once and leaves the server running locally. The 30 s
entry is therefore unreachable with that limit. Serving for at least 60 s resets the failure streak
when counting the next failure. See the step 1 handoff and `runtime/command-helper/client.ts`.

#### 5.A.3 Memory and planned replacement

RSS is sampled in the helper every 30 s. By default, three consecutive reports **strictly above
384 MiB** trigger a planned replacement. Set `AGENT_TOWER_COMMAND_HELPER_RECYCLE_RSS_MB` to a
positive number of MiB to change the threshold, or to `0` to disable replacement. The minimum interval
between attempts is ten minutes, including after a failed startup. Only one replacement can warm up
or drain at a time.

1. The server starts a second helper. The current helper continues serving. If startup fails or the
   candidate misses its ready deadline, the current helper keeps serving.
2. Once the candidate is ready, the server directs new requests to it and announces one placement
   change. The socket registry registers its directories in the new service and publishes a new
   epoch (5.B.1). The old helper retires its watches and timers.
3. Outstanding commands, state reads and diffs keep their original helper, cancellation and deadline.
   When its requests finish, the retiring helper follows the bounded stop in 5.A.2. A planned switch
   increments `helper_recycles_total`. Crash restarts have their own counter.

The first threshold of 160 MiB was below the normal plateau for diff and output workloads. The final
default is about 1.5 times the upper end of the measured 219–249 MiB band. A replacement costs one fork from the **large server**,
while starting afresh saves only a few milliseconds on the **helper's** thread. Section 6.1 gives the
measurements behind that decision. The allocator keeps its operator default.

#### 5.A.4 Switch and fallback

The helper is a performance measure and is never a functional requirement.
`AGENT_TOWER_COMMAND_HELPER=auto` (the default) enables it on Linux. `on` enables it on every
platform. `off` keeps execution in the server. A process that never started a helper, or a server
whose helper is starting, down or has given up, can run owned commands, the git state service and the
diff cache locally. An individual command never starts a helper on demand.

With `on` outside Linux there is no scope supervisor. A helper crash or forced termination after a
missed deadline can **orphan running commands**. This is also why a normal stop on the compatibility
backend reports pending cleanup if it cannot confirm exit.

#### 5.A.5 Alternatives considered

The owner chose a small helper over the proposed native `posix_spawn` module because buffered git
commands dominated process starts and already shared an execution path. A native path for PTYs and
ACP adapters remains deferred. A generic streaming broker would also have to own PTY resizing,
backpressure and interactive process lifetimes. The review demonstrated that Node can pass a pipe
handle over IPC, but that alone does not provide these behaviours.

#### 5.A.6 Other findings from the original inventory

The original review also identified direct executable lookups, synchronous PTY logging and editor
launches without a child error listener. The open request-hygiene work in 5.E and 7.2 covers the
relevant follow-ups. The owner has only approved the process-start and git changes described here.

### 5.B Git state per viewed directory

#### 5.B.1 Model, placement and REST reads

A worktree has its own working files and git index. The server resolves the workspace, repository,
working directory and comparison branch from the database. It owns socket subscriptions,
authorization and conflict recovery tokens. A directory registration keeps state current for the
workspaces viewing it. `WorkspaceGitStateService` owns the snapshots, watches,
line counts and diff cache. The facade in `packages/server/src/git/state/git-state-facade.ts` sends
requests to the helper while it is available. Otherwise the same service runs in the server.

Each service instance has a random **epoch**. Within it, each directory has a **version** that
increases when computed content changes. A computation on its own does not advance the version.
The service remembers recent evicted versions in a bounded cache. A placement change, including a
planned helper switch, creates a new epoch. The server registers each subscribed directory again and
delivers the new epoch's snapshot once to each existing subscriber on a successful handover.
The client accepts it even if the version starts over.

| Reader | How it gets state |
|---|---|
| First subscription | Compute the current snapshot or join an in-flight computation for the same directory and base. A first registration checks the working files even if a REST read was cached. |
| Registered directory | Return the cached snapshot while clean. Reads share the scheduled or running computation when a change is pending. Different bases are handled in sequence for the same directory. |
| REST without a registration | Reuse a snapshot for up to 1 s from the **start** of its computation if its git metadata fingerprint still matches. Otherwise compute on demand. Such entries have no watches. Idle entries can be evicted after 10 min. The size target of 64 entries allows active registrations and computations to finish. |

`GET /api/git/changes` returns `{ uncommitted, committed }`. Each change entry has a path, status,
version token and optional line counts. `GET /api/workspaces/:id/git-status` keeps its operation,
conflict and ahead/behind fields. A git-backed `MAIN_DIRECTORY` workspace can subscribe. Its changes
use the same comparison as the REST route, which selects the most recently updated workspace for
that directory. Its status keeps the main-directory convention of idle, zero counts and no conflict.
Several workspace IDs can share one directory registration. A non-git project has no such subscription.

Checks before a git mutation still inspect the repository directly. The server also observes live
conflicts and binds any recovery token to the authorized owner before sending it. A cached status
does not authorize an operation. The state and REST views are in `packages/server/src/git/state/`.

#### 5.B.2 One snapshot, few git processes

All state commands set `GIT_OPTIONAL_LOCKS=0`. Diffs run in the C locale. The process counts below
are for a normal repository with local refs. They exclude separate conflict-token checks and
requests for file patches.

| Work | Command or file read | When it starts a git process |
|---|---|---|
| Locate the checkout and detect an operation | Read `.git`, `commondir`, HEAD, loose or packed refs, and the `rebase-merge`, `rebase-apply` and `MERGE_HEAD` markers | No process for ordinary file-backed refs. Unusual revision names, loose tags or reftable can require `git rev-parse --verify --quiet`. |
| Read branch, HEAD, tracked and untracked changes | `git status --porcelain=v2 -z --branch --no-ahead-behind --untracked-files=all` | Once per computation. Git 2.17 or later is needed for `--no-ahead-behind`. |
| Get entries and line counts for changed tracked files | `git -c core.bigFileThreshold=1048576 diff --raw --numstat --stat=300,200 -z --no-abbrev --no-color HEAD -- <paths>` | One batch for eligible records that changed or are still recent. Before the first commit it omits `HEAD` and compares the index with the working tree. |
| Compare the branch to its base | The same diff flags with `<base-commit>...<head-commit>`. Try `origin/<base>` if the local comparison is unavailable. | Once per uncached commit pair. |
| Count commits ahead and behind | `git rev-list --left-right --count <base-commit>...<head-commit>` | Once per uncached pair when HEAD is on a branch and the local base exists. Otherwise the counts default to zero. |

The diff command uses `--no-abbrev` because the proposed `--full-index` still abbreviates IDs in
raw records. It gets names, modes,
blob IDs, line counts and binary sizes together. This avoids the proposed separate batch size probe.
`lstat` excludes oversized working files before git tries to hash them. The blob threshold and the
sizes git prints in `--stat` distinguish ordinary binary files (zero additions and deletions) from
oversized files (counts omitted). Section 9.1 records the forced-text attribute exception.

The service saves entries and line counts per settled status record, including both sides of a rename.
It reuses them when all the token inputs match. A settled, unchanged tracked edit therefore costs
the same as a clean worktree. Previously the service repeated the uncommitted counts at every check.

| Case | Git processes for one computation |
|---|---:|
| First read with local HEAD and base, clean / with tracked edits to count (step 2 fixtures) | 3 / 4 |
| Idle viewed worktree, clean or with settled edits, cached commit pair | 1 per 30 s safety check |
| Changed eligible tracked record, cached commit pair | 2 (status and one diff) |

A moved HEAD or base can require the two branch comparisons again. Ref fallbacks can take the
count above four. On status output overflow the service retries with `--untracked-files=normal`.
If status fails it probes the directory with `git rev-parse --is-inside-work-tree`.
Command selection is in `git-state-compute.ts` and limits are in
`git-state-limits.ts` under `packages/server/src/git/state/`.

#### 5.B.3 What triggers a computation

The active service records that a directory needs a refresh. It groups ordinary triggers after 300 ms
of quiet and spaces registered computation starts at least 1 s apart. A trigger during a computation
can schedule one follow-up. The safety check skips the quiet wait. Only changed content is pushed.

| Source | Action |
|---|---|
| Git metadata | Nonrecursive directory watches cover the worktree's own git directory and the parents of `packed-refs`, the current HEAD ref and the local and remote base refs. This survives git replacing a file by rename. The watches ignore names ending in `.lock` and filter shared directories by filename. |
| Base movement | A change found by watch or safety check also invalidates registered worktrees with the same repository and base branch. |
| Agent activity | A completed tool in `session:patch`, or `session:turn-completed`, `session:completed` or `session:exit` invalidates the workspace. Streamed content alone does not trigger a git read. |
| Terminals and workspace services | After terminal input, output followed by 1 s of quiet invalidates worktrees containing the terminal's creation directory. Service output uses the same quiet period for its workspace. Service exit invalidates immediately. |
| Tower git operations | Session and hibernation auto-commits, merge, rebase, abort, reset and worktree recreation notify the affected directories. Base-branch and workspace metadata changes reload the comparison target, including shared main-directory aliases. |
| Browser | A focused window or newly visible tab requests a refresh under the rule in 5.B.6. |
| Safety check | Each registered directory gets a computation every 30 s. This interval is set in `git-state-limits.ts`. It rereads status and the base ref even if a watch failed. |

A *fingerprint* records the stat identity of HEAD, the index, packed refs and relevant branch refs.
With optional locks disabled `git diff` can still refresh the index. Watches therefore compare events
with the fingerprint recorded **after** computation. An index write made by that computation does
not start another one. A concurrent HEAD or ref move does schedule a follow-up.

Working folders have no watches. An external edit that touches only working files is picked up on
the next focus refresh or safety check. Git operations that change watched metadata can be seen
sooner. These are detection intervals. Command runtime and host load also affect delivery. See
`git/state/git-state-watches.ts` and `git/workspace-git-signals.ts` under `packages/server/src/`.

#### 5.B.4 File version tokens, diff cache and size guards

A **file version token** is an opaque hash. The client compares it only for equality. A settled
file keeps its diff when another file changes. The server derives the token from the inputs to that
file's comparison. A blob ID identifies a file's stored content in git.

| Change entry | Inputs to the token |
|---|---|
| Committed | Both file modes and both blob IDs in the merge-base-to-HEAD comparison. |
| Tracked, uncommitted | The HEAD-side mode and blob ID, plus the working file's size, modification time and change time in nanoseconds, and inode from `lstat`. Before the first commit the index supplies the base. Rename sources and conflict stages are included where relevant. |
| Deleted / untracked | A deletion marker replaces the working stat for a deleted path. An untracked file uses its working stat. |

A file modified within **3 s** of the computation start is *racy*. Its timestamps may fail to
distinguish two edits. The content comparison uses a provisional token, so rereading identical racy
content alone does not advance the state version. Once the service knows the version, it includes
the epoch and that version in the racy token. A new state version can thus change any still-racy
token. At the first later computation that finds the file settled, the token changes once more.
The server pushes the state and the browser refetches that file if its diff is open. Settling uses
the next ordinary computation. Submodules and unmerged entries are treated as volatile.

`GET /api/git/diff` takes `workingDir`, `path`, `type=uncommitted|committed` and optional `force`.
The token is in the browser query key. On the wire the server resolves the current state, takes a
fresh `lstat` for a working file and returns the token it actually read. A path with no entry in
the state yields empty text with a state-bound token. For an uncommitted rename, the change list
shows only the new path, and a request for the old path returns its deletion patch because the state
keeps an entry for it. A tracked uncommitted diff compares HEAD with the working tree,
including staged edits. Before the first commit it compares the index. An untracked file is shown
as an addition with `git diff --no-index`. A committed diff uses the resolved base and HEAD commits
from its change list, including the remote-base fallback.

One service-wide **16 MiB** cache evicts the least recently used answers first. Its key includes the
directory, change kind, path, token and per-side size limit. Concurrent requests for a key share one
computation. Removing a directory from the state service drops its cached diffs. Replacing the service starts a
fresh cache. Text above **1 MiB of output** is returned without caching. A live working-file result
is also skipped if the file is volatile, was modified within 3 s of the diff start, or its stat changed
during the read. A forced diff with large text is therefore recomputed on each request that reaches
the service. A small patch to a large file can still fit the cache.

| Successful response | What the caller sees |
|---|---|
| `{ kind: 'text', token, diff }` | The patch text. |
| `{ kind: 'binary', token, oldSize, newSize }` | A binary notice with sizes in bytes where known. A missing or unknown size is `null`. |
| `{ kind: 'too_large', token, oldSize, newSize, limit, canForce }` | The ordinary limit is **1 MiB per side**. Desktop and mobile show **Load anyway** only when `canForce` is true. It sends `force=1` and raises the limit to **8 MiB per side**. A larger side receives no further override. |

The service checks working size before passing a file to git. An oversized untracked file needs no
diff process. An oversized tracked working file may need only `git cat-file -s <old-oid>` to size the
other side. For an ordinary miss one `git diff --no-color --no-ext-diff --stat=300,200 --patch` with
`core.bigFileThreshold` set to the active limit supplies the patch and binary sizes. A missing old
blob size may require a second process. Sizes belong to the diff response. The change list adds only
the token. See `git-file-versions.ts` and `git-file-diff.ts` under `packages/server/src/git/state/`.

#### 5.B.5 Cancellation and error answers

For `/api/git/diff`, TanStack Query passes its `AbortSignal` through `apiClient` to `fetch`. When the
last card waiting for the request leaves, the fetch aborts. The route watches for a response socket
closing before the reply finishes. It passes cancellation to the service, across IPC when needed.
A shared diff stops its git process tree when its last request leaves. A shared **state computation**
continues while it has either a registered viewer or a waiting request.

| HTTP response on the file-diff route | Meaning |
|---|---|
| 400 `VALIDATION_ERROR` | Invalid query, such as an unsupported type or path traversal. |
| 400 `GIT_UNAVAILABLE` | The requested working directory is unavailable as a git worktree. |
| 499 `CLIENT_CLOSED_REQUEST` | The caller already closed the response. |
| 500 `GIT_DIFF_FAILED` | The patch command failed, including a command timeout or output overflow. |
| 500 `INTERNAL_ERROR` | Other unhandled failures follow the git route's error handler. |

History's `/api/git/commit-diff` also receives a browser fetch signal, but its server route still runs
the existing `git show` path and returns `{ diff }`. End-to-end process cancellation and the size
responses above apply to `/api/git/diff`. The HTTP handlers are in `packages/server/src/routes/git.ts`.

#### 5.B.6 Socket subscription and recovery

These are dedicated messages on the `/events` Socket.IO namespace. The initial acknowledgement
carries a snapshot so the browser can start at a known epoch and version. The contract is in
`packages/shared/src/socket/events.ts`.

| Direction | Message | Payload and rule |
|---|---|---|
| Client → server | `workspace-git:subscribe` | `{ workspaceId }`. Success acknowledges `{ ok: true, workspaceId, epoch, version, state }`. Failure acknowledges `{ ok: false, code, message }`. |
| Client → server | `workspace-git:unsubscribe` | `{ workspaceId }`. Revokes intent and leaves the room. No acknowledgement. |
| Client → server | `workspace-git:refresh` | `{ workspaceId }`. No acknowledgement. The server checks current subscription intent and authorization and accepts at most one per second per socket/workspace, including across unsubscribe/resubscribe. An obsolete refresh does not consume that allowance. Lost authorization disconnects the socket. |
| Server → client | `workspace:git_state` | `{ workspaceId, epoch, version, state }` to current authorized subscribers in `workspace-git:<workspaceId>`. |
| Server → client | `workspace:git_subscription_ended` | `{ workspaceId, code, message }`. An acknowledged subscription ended because its workspace disappeared (`NOT_FOUND`) or git state is unavailable (`WORKSPACE_GIT_UNAVAILABLE`). |

`state` contains `{ changes, status, headOid, baseBranch }`. Changes and status match their REST
views. Subscribe errors are `INVALID_PAYLOAD`, `NOT_FOUND`, `WORKSPACE_GIT_UNAVAILABLE` and
`WORKSPACE_GIT_SUBSCRIPTION_DENIED`. A disconnect also revokes intent. The last subscriber leaving a
workspace starts a **10 s grace period**. Reopening can reuse the registration. Releasing the last
workspace that owns the directory removes the watches, safety timer, state and cached diffs.

Delivery and registration have independent retry rules in
`packages/server/src/git/workspace-git-subscriptions.ts`.

| Failure | Recovery |
|---|---|
| A changed state cannot be prepared or sent to a current subscriber | Retry delivery from 250 ms, doubling up to 5 s, while the snapshot is current. A newer version supersedes the old one. These retries use the computed state. |
| Re-registering an existing subscription fails transiently | Retry after **1, 2, 5, 10 and 30 s** while a viewer remains. Workspace lookup retries per workspace. State registration retries once per shared directory on each attempt. A valid snapshot from a surviving watch or safety check cancels the directory retry. |
| A lookup reports the workspace missing or git unavailable, the state is unavailable, or retries run out | Send the ended event to acknowledged subscribers, revoke their intent and room membership, and release the directory under the usual grace rule. A pending initial subscriber gets its own failure acknowledgement. |

#### 5.B.7 Web client

Desktop `TaskDetail` and `MobileTaskDetail` call `useWorkspaceGitSubscription` in
`packages/web/src/lib/socket/hooks/` for the selected git-capable workspace while its project
repository exists. This covers every panel tab.
`packages/web/src/lib/socket/workspace-git-subscriptions.ts` owns one manager per TanStack
`QueryClient`. It counts references per workspace, subscribes while connected and visible, and
releases the last reference on the next tick. Hiding the tab unsubscribes. Becoming visible or
reconnecting subscribes again. A focus during registration, including a return to a visible tab,
requests refresh after acknowledgement. A plain window focus is throttled to one action per second.

The manager accepts a new epoch or a strictly higher version in the current epoch. It writes changes
and status into the existing query caches, then cancels outstanding REST queries for those keys so
older results cannot overwrite the push. History reloads when `headOid` changes. Desktop and mobile
history and the Review timeline share `useGitLogPages`. The aggregate workspace diff can still be
invalidated. Individual file diffs follow their tokens.

REST also serves the first load. A negative acknowledgement, a 15 s acknowledgement timeout, or
`workspace:git_subscription_ended` makes the manager reload the open changes, status and history
views once. After a timeout on a connected socket it also sends unsubscribe to revoke the pending
request. Uncovered queries refetch on focus and reconnect. A plain window focus can reload REST
once per second. Reopening the task, returning to a visible tab or reconnecting can try the
subscription again. There is no periodic subscribe retry in the browser.

The git polling timers and their visibility policy were removed. In `packages/web/src/hooks/use-git.ts`,
`useGitDiff` keys a file by directory, change kind, path, version token and force choice. It keeps
the previous diff visible while the new key loads. A cached answer is fresh indefinitely under its
key. Focus and reconnect do not refetch it, and a failed fetch has no automatic retry loop. History
diffs use directory, commit hash and path as an immutable key. These keys sit outside the general
git invalidation prefix, so a change to one file leaves other cached file queries alone.

### 5.C Incremental log storage and loading

The owner deferred the following proposals until after the git deployment and measurement.
The suggested sizes and intervals in 5.C–5.E come from the original latency study in 2.6.
On 2026-11-19, with the git work deployed, the owner asked for the slow task opening to be
fixed. The parts of step 1 marked done below and the light log view in 5.C.6 are implemented
in `at/7dd18ece` and not yet deployed. Storage changes and tail-first loading remain proposals.

#### 5.C.1 Facts that shape the design

**Server.** Session finalization releases the in-memory `MsgStore` if it still belongs to the
finishing runtime. When a later turn needs a new store, the server parses the full `logSnapshot`
to restore it. Parsers address entries by array index. Entry IDs can repeat or change, and ACP
history reload can replace the whole array (`session-manager.ts`, `startRuntimeTurn` and
`appendUserMessageEntry`).

During streaming, `dropStaleReplaces` often clears the store's snapshot cache. A later
`getSnapshot()` then clones the base JSON and replays patches. Checkpoints, live log reads and
translation checks can each do this work. The gateway broadcasts `session:patch` to every
authenticated socket. Several other paths load the whole Session row even though they need only a
few fields. These include session-scoped message deliveries, translation access checks, socket
subscriptions, team-run routes, conversation lists and workspace archive responses.

**Browser.** When a text block is sealed, the tracker can emit `add /entries/{i}/metadata`.
The browser's `applyAdd` rejects this nested operation. `useNormalizedLogs` then discards its local
state and fetches the full log. Sealing happens at assistant-to-tool switches, completed blocks and
turn end, including with translation disabled. Opening a finished session also fetches the log on
attach and again at the terminal revalidation 1.5 s later.

| Original journal observation | Conditions and result |
|---|---|
| Repeated reads | In the 5.5 h sample from 2.1, 247 log requests went to 22 sessions. The 5.1 MB session `441e96ab` was read 22 times. |
| Time between reads | Of 134 gaps between reads of the most frequently fetched sessions, 66 were under 2 minutes. |

#### 5.C.2 Step 1. Avoid repeated full loads with the current storage

1. Extend the shared patch contract and browser applier to accept `add /entries/{i}/metadata` as
   an object-member upsert on an existing entry. The alternative within the current contract is
   `replace /entries/{i}`, which resends that entry's text. The existing differential tests in
   `perf-p0-2-conversation-patch-contract.md` describe the required semantics.
2. Revalidate on a live-to-terminal transition. Use the validator in item 4 so an unchanged log
   can receive a `304`.
3. Have the log hook join `session:<id>` and send that session's patches to its viewers.
   Section 10.2 gives the history of per-session rooms.
4. Persist the sequence number (`seq`) in the log JSON so the server can send the stored bytes
   directly. For a live log, reuse one serialization per sequence number for reads and checkpoints.
   The proposed ETag includes the session, sequence and storage version. A returning client with a
   cached log can send `If-None-Match`.
5. Keep the incremental snapshot cache valid across streamed replacements. When a later patch
   replaces the same path, update the cached value and compact the message list.
6. Select only the fields needed by the callers in 5.C.1. Section 10.1 records the review's
   alternative of excluding the log from default Session reads.

| Item | Status on 2026-11-19 |
|---|---|
| 1. Metadata upsert | Done. The browser applies `add /entries/{i}/metadata` (contract §2.8), so sealing a text block no longer reloads the log. |
| 2. Revalidation at the end | Partly done. A snapshot requested after the session had already ended is final, so the second download 1.5 s after opening is skipped. A live-to-terminal transition still re-reads once. There is no validator or `304`. |
| 3. Per-session patch room | Open. |
| 4. Stored sequence and ETag | Open. |
| 5. Snapshot cache across replacements | Done. `dropStaleReplaces` keeps the cache and shifts its message index. Property tests compare it with a full replay, including whole-entry and whole-array replacements. |
| 6. Narrow Session reads | Partly done. Message-delivery access (`assertSession`), translation access (`readableSession`), the log routes and the checkpoint write no longer read the log column. The other callers in 5.C.1 are open. |

#### 5.C.3 Step 2. Store logs as entry chunks

The original proposal groups 200 entries per `SessionLogChunk`. Each chunk holds the session and
chunk IDs, entry count, JSON, hash and update time. The Session row carries the sequence, entry count,
version, byte size and the summary fields in 5.C.4.

- Track changed entry indices. An insert marks that chunk and every later chunk dirty. Replacing
  all entries marks every chunk dirty. Write changed chunks and the Session sequence and version
  in one transaction. Translation sync would read just the changed chunks.
- Retain recently used stores across turns to avoid restoring the log on each follow-up. The study
  suggested a 200 MB total budget with least-recently-used eviction and a 10-minute idle timeout.
  The memory budget needs measurement because some processes still start in the server (2.3).
- Back up the database before migration. A background job could split old logs a few sessions at a
  time. Readers would fall back to the old column for unmigrated sessions. Retain that column through
  the rollback window before clearing it in a later release.
- The study also considered files under the data directory, similar to content-addressed artifacts.
  Files could stream directly and keep the database small. They would need their own backup, deletion
  and crash-recovery rules, and would lose atomic updates with Session status. The study favoured
  trying a table first. The review proposed one row per entry (10.1). The owner has yet to choose.

#### 5.C.4 Step 3. Load the tail first and older pages on demand

The proposed first response, `GET /sessions/:id/logs?tailTurns=3`, would return
`{ entries, offset, total, seq, etag, hasMore, summary }`. Starting at a user message preserves
turn grouping, keys and durations. The client could fetch an older page with
`?before=<offset>&turns=5` and preserve scroll position as it prepends entries.

Patches would keep absolute indices. Within the window the client would apply `index - offset`.
A change below the window marks the older page stale until the user scrolls there. Replacing all
entries reloads the window. The full-log route would remain available to existing consumers.

The summary would supply the latest todos, current token usage from the live store, last user and
output timestamps, and the window's first timestamp. The delivery view needs that last value to
avoid inserting user messages for deliveries older than the window.

#### 5.C.5 Sequence numbers across restarts

After a crash the server restores the checkpoint's sequence. A client that has already seen a
higher sequence can ignore the restored snapshot and subsequent patches. The proposal adds a
`logEpoch` on store restoration so the client can accept the new sequence.

#### 5.C.6 Light log view (implemented 2026-11-19)

Tool outputs are 85–90% of the bytes of production logs, and the log view shows a tool's output
only after the user expands its item. The task view therefore opens with a light view of the same
document. `GET /sessions/:id/logs?view=light` keeps every entry at its index, so live patches still
apply. It shortens a `tool_use` output longer than 1,024 characters to its first paragraph (the
title line, the command or an ACP `Input` block, at most 600 characters). `contentOmitted` records
the full length. `metadata.toolContent` and `metadata.fileChanges`, which the web client never
reads, are dropped. The default view stays complete for other consumers.

The client loads a shortened output when its item is expanded, through
`GET /sessions/:id/logs/entries?entries=<id>:<length>,...`. Each ID is URL-encoded on its own, and
the answer echoes the requested length, because entry IDs repeat in long logs (151 of 7,652 entries
in the seeded production sample). Opening a tool group prefetches its shortened outputs, up to 50
per request, when they total at most 200,000 characters; larger outputs load on their own expansion.
A later `replace` of the entry's content carries the full text and makes the entry complete
(contract §2.9). Only views that can load the rest ask for the light view: the hook option is
`logView: 'light'`, used by the desktop and mobile task views and the agent session panel.

The server caches the light view of a persisted snapshot per `Session.updatedAt`, within a shared
budget of 24 × 2²⁰ characters. A snapshot is written only while the session's store exists, and
the store is released after its final write. The persisted cache is used only without a store, so
a cached version always holds the last write of a turn. Entry reads reuse the parsed snapshots of
the two most recently read sessions until they are idle for 60 s, so expanding several items parses
the log once.

### 5.D Translation overlays without full-log parses

These options preserve the access and staleness checks in 3.4. The owner deferred them with the
log work. The status after the 2026-11-19 change follows the list.

1. Select the fields needed for authorization in `readableSession` and `assertReadableSession`.
   This would avoid loading the log for translation events, subscriptions, job claims and retries.
2. At each checkpoint, index current blocks by turn and block ID with their revision, hash, state
   and parent entry. Mark source rows current only when they match. Overlay reads could then filter
   those rows in SQL.
3. Expose the live text-block tracker's index for source checks and overlay reads. It can be ahead
   of the last checkpoint. Keep the client's original-text check for that interval.
4. Return the overlays in one bounded response. The study suggested a cap of 2,000. The current
   client reads pages of 100 raw rows, and each page checks the log separately.
5. Use the source and revision IDs already present on events to fetch and merge one changed row.
   A cancellation or deletion would remove it. A full read on mount or reconnect would still
   reconcile missing rows.
6. Cover the cases handled by the 5 s poll with disconnect, access-revoked and cookie-expiry
   handling, plus a refresh after the join acknowledgement. The original proposal keeps a 60 s
   safety read until these paths are verified.
7. Skip overlay reads when translation is off or the session has no translation epochs. Today the
   hook selects candidate assistant message blocks other than thinking, plus certain system messages.
   The message-delivery hook would need its own subscription first. It depends on the overlay hook's
   `session:<id>` room to receive `message-delivery:invalidated`.

| Item | Status on 2026-11-19 |
|---|---|
| 1. Narrow access reads | Done for `readableSession` and `assertReadableSession`. |
| 2–3. Current blocks without a parse per read | Done differently. The server caches each transcript's block index, per stored version for a persisted snapshot and per sequence number for a live store. Overlay reads and source checks use it. Rows are still filtered in JavaScript, not SQL. |
| 4. One bounded response | Done. `limit` accepts 1–1,000 (default 100 for other clients), and the web client asks for 1,000. Its read now starts with the log read instead of after the log has rendered. The views unmount the log stream while the first snapshot loads, so that read gets no abort signal and survives the unmount. The remount shows its result at once. If the read has already finished, the remount reads again, because room events are missed while the stream is unmounted. In the A/B in 6.1 every first open made these two reads. |
| 5. Merge single changed rows | Open. |
| 6. Safety read | Done as proposed. The client polls every 5 s while output is active or an overlay is unsettled, otherwise every 60 s. |
| 7. Skip reads when translation is off | Open. |

### 5.E Request hygiene

- **Provider availability is open.** The proposal would resolve executables by checking `PATH` with
  `fs.access(X_OK)` and the existing Unix path fallbacks. It would cache availability until a
  configuration change, manual refresh or 60 s expiry.
- **Message deliveries: the per-message reads are batched; the idle poll is open.** A user message
  in the log shows its delivery's feedback. The session lists carry only pending deliveries and the
  latest 100 sent ones from session origins. Team inputs, cancelled operations and older sent ones
  were each read with `GET /message-deliveries/:id`: 21 requests in a median cold open of
  `90d922fc` (6.1). Since 2026-11-19, rows that render together share one
  `GET /message-deliveries/by-ids` request (1–100 IDs), and that open makes 4. Each row gets the
  same checks as the single read, which stays for other callers. The
  proposal for polling remains open: keep the invalidation event and reconnect refresh, poll while a
  delivery is pending, and remove the 5 s idle poll. Delivery polling across scopes accounted for 43%
  of the requests in 2.1.
- **Static assets are cached (2026-11-19).** The server sent every file of the web client with
  `Cache-Control: public, max-age=0`, so each page load asked again about every chunk it needed,
  and so did the first open of the lazily loaded task view. Vite names the files under `assets/`
  after their content, so these now carry `public, max-age=31536000, immutable` (`web-static.ts`).
  `index.html` keeps `max-age=0`, so a deployment is picked up on the next load. The first visit
  after a deployment still downloads the new chunks.
- **Cancellation on task switch.** The log client passes abort signals to its fetches. Since
  2026-11-19 the overlay read deliberately does not (5.D, item 4): it is one bounded request that
  finishes after a switch and stays cached. Extending cancellation through server-side work
  remains open. Working and branch file-diff requests carry the signal all the way to git (5.B.5).

### 5.F Runtime measurements

The server entries log one `[runtime-metrics]` line per minute. HTTP latency comes from the Fastify
request journal. The original suggestions for an authenticated diagnostics endpoint, timings of every
kind of process start and log-serving byte counters are still proposals.

#### After deployment: what to check

From the repository root, run the journal analysis for comparable before and after windows. Choose
windows with similar viewer activity. Use `--pid PID` to isolate one server process if a window spans
a restart.

```sh
timeout 120 journalctl -u agent-tower -o cat --since "-2 hours" --no-pager \
  | python3 -I scripts/journal-latency.py --markdown
journalctl -u agent-tower -o cat --since "-2 hours" --no-pager --grep='\[runtime-metrics\]'
```

The script joins requests by process and request ID. Compare the counts of changes, git-status and
diff requests, per-route p50/p90/p99, and the p90 of plain requests grouped by overlap with git/provider
or log-heavy routes. This shows whether the old git request traffic and the associated queueing fell.
Compare log and translation latency before choosing the next work. Once the log changes in
5.C.6 are deployed, opening a finished session should cost one `/logs` request and about two
`/translations` requests, as in the A/B in 6.1. Production results are pending.

| Fields on the minute line | Expected reading and conditions |
|---|---|
| `event_loop_delay_ms p50=… p99=… max=…` | Delay above the 20 ms sampling period. Look for fewer long pauses during git activity under comparable load. There is no measured post-deployment percentile target. |
| `helper`, `commands_helper`, `commands_in_process` | On Linux with a healthy default helper, expect `helper=running` and zero local dispatches. Buffered command requests count in `commands_helper`. Git started **inside** the helper's state service counts in `git_state_git_processes`, so a safety check need not increment `commands_helper`. |
| `helper_rss_mb`, `server_rss_mb`, `helper_restarts_total`, `helper_recycles_total` | RSS fields use MiB. Compare helper RSS with the workload bands in 6.1. Both totals should stay flat in ordinary use. A successful planned switch adds one recycle and zero crash restarts. |
| `git_state_registered_worktrees`, `git_state_computations_safety`, `git_state_git_processes`, `git_state_pushes`, `git_diff_requests` | In a fully idle minute with one registered directory and settled changes, the browser run saw **2 safety computations, 2 git processes, 0 pushes and 0 diff requests**. Each additional viewer of that directory shares the registration. After the last owner leaves and its grace expires, expect zero registrations and no safety work for it. |
| `git_state_requests`, `git_state_computations`, `git_state_cache_answers` | Repeated views of clean registered state should increase cache answers without new git processes. A diff lookup also counts as a state request. Pushes count socket deliveries and exclude the initial acknowledgement. |
| `git_state_computations_watch`, `git_state_computations_agent`, `git_state_computations_terminal`, `git_state_computations_service`, `git_state_computations_operation`, `git_state_computations_refresh` | Look for computations that match the activity in 5.B.3. A watch counter that rises repeatedly on an idle checkout merits a look at the git metadata. |
| `git_diff_requests`, `git_diff_computations`, `git_diff_cache_answers` | A browser hit under the same file token sends no HTTP request. A service cache hit answers without starting a patch process. A file edit should generate diff work only for affected open files, including the settling read. |

Activity counts cover the reporting interval. Registered worktrees and RSS are current values.
The restart and recycle totals are cumulative for the server process. Field names and units come
from [runtime-metrics.ts](../packages/server/src/runtime/runtime-metrics.ts).

## 6. Impact and measured results

### 6.1 Measurements of the implementation

These checks used isolated processes and repositories. None measures production latency after
deployment. Section 2 gives the corresponding pre-deployment production evidence.

**Time blocked on the caller's thread.** Each benchmark ran `git status` 40 times directly and
40 times through the helper. The table reports synchronous dispatch time unless labelled end-to-end.
For the V8 heap and Buffer controls, see 2.3.

| Run and conditions | Direct from the caller | Through the helper |
|---|---|---|
| Coordinator's prototype, 755 MB Node process, host load 11–14 | 82 ms mean, 210 ms max | 0.09 ms mean, 0.7 ms max |
| Step 1 implementation, 758 MB caller, 700 MB of touched Buffers, host load about 2 | 31.3 ms mean, 89.9 ms p95, 101.4 ms max | 0.15 ms mean, 0.42 ms max |
| Hardening benchmark, clean scratch repo, 757–758 MiB caller, 700 MiB of Buffers, default allocator | 51.5 ms mean, 57.3 ms p50, 80.7 ms p95 | 0.19 ms mean, 0.19 ms p50, 0.30 ms p95 |
| Same workload, two glibc arenas in helper only | 86.5 ms mean, 92.3 ms p50, 112.1 ms p95 | 0.21 ms mean, 0.18 ms p50, 0.46 ms p95 |
| Built replacement client, repeated benchmark with 757 MiB caller | 164.2 ms mean, 186.7 ms p50 | 0.28 ms mean, 0.17 ms p50, 1.60 ms p95. Median end-to-end command time was 6.4 ms. |

The coordinator and step 1 handoffs give the first two runs. Step 1's built helper measured
52.9 MB at ready and 57.1 MB after the calls. Its isolated CLI run recorded 18 helper commands,
zero in-process commands and 55.6 MiB helper RSS. The later timings and memory tables are from the
[helper benchmark report](../packages/server/scripts/bench-command-helper-memory.md).

**Helper memory under sustained load.** The hardening benchmark used the built server from
`d574d65`, Node 24.22.2, glibc 2.35 and Linux 5.15 x64. Each workload used a fresh helper and
scratch repository. Sampling continued until four consecutive RSS checkpoints were within 8% of
their minimum after the required workload. The table gives **final sampled RSS**.

| Workload | Default allocator | `MALLOC_ARENA_MAX=2` for helper only |
|---|---:|---:|
| State reads across 30 small linked worktrees with tracked edits | 95.7 MiB | 94.0 MiB |
| Same worktrees registered, invalidated before each read | 97.8 MiB | 97.8 MiB |
| Ordinary diffs cycling through 24 settled 0.9375 MiB text files, with hits and misses | 224.7 MiB | 242.6 MiB |
| Forced diffs of a 7.875 MiB file | 218.6 MiB | 239.3 MiB |
| Commands cycling through 1, 5 and 10 MiB of output | 249.0 MiB | 231.0 MiB |

In step 2, 30 rounds across 30 worktrees brought the helper to 165 MB with the state service and
224 MB with the old 14-command path. Forced collection across 60 rounds showed about 7.5 MB of
used V8 heap for the service. The longer workload-specific measurements above put
that observation in context. With default allocation the heavy runs retained 152–157 MiB of V8 heap
capacity with only 26–31 MiB used. The measurements do not attribute the remaining RSS to a specific
allocator. Two arenas helped the command-output case but raised both diff endpoints.

| Helper RSS band (default allocator) | Synchronous process start on the helper thread |
|---|---:|
| Fresh, below 64 MiB | 1.87 ms |
| 160–192 MiB | 3.69 ms |
| 224–256 MiB | 5.35 ms |

Each checkpoint timed 15 real scope-supervised `/bin/true` starts. The table shows the median of
the checkpoint medians. Refreshing a helper in the two higher bands would save 1.8–3.5 ms per start
on its thread. Direct starts from the large caller in the same benchmark series cost 51.5 and
164.2 ms on average in different runs. That trade-off led to the 384 MiB default in 5.A.3.

**Built server and browser checks.** Step 3a used an isolated built server and a real socket on port
18483. For steps 3b and 4, the step 4 task exercised both sets of behaviours in **one real-browser
run** using production builds on port 39272 and Chromium in Docker. The scratch task had two small
edited files, two large edited files (1.4 and 1.5 MB), and one committed change. One large file used
a text conversion driver that slept for 120 s. Tab visibility was emulated in headless Chromium.

| Check | Observation |
|---|---|
| Step 3a, server push | An external commit reached the socket in 843 ms. Registered clean REST reads started zero git processes. Two main-directory workspace IDs shared one registration. Built-helper RSS while subscribed was 62.4 MiB. |
| Step 3b, subscription and idle traffic | Opening sent one subscribe. The visible view initially fetched changes, history and git-status once each, and fetched five file diffs. Across **130 s idle** there were zero git REST requests and zero git socket frames. A full idle minute recorded two safety computations, two git processes, zero pushes and zero diff requests despite the tracked edits. |
| Step 3b, visibility and focus | Hiding the tab sent one unsubscribe. Showing it again subscribed and refreshed with no further git REST request. Focusing after an edit sent one refresh. |
| Step 4, selective diff fetch | Editing `src/a.txt` and focusing produced one push and one request for that file. Only its token changed. The next safety check about 10–15 s later found it settled and fetched that file once more. |
| Step 4, size override and history | A large file showed its sizes (6 B → 1.4 MB). **Load anyway** sent `force=1` and rendered the patch in about 150 ms. A history diff was fetched once across three focus events and an online event. |
| Step 4, task switch during a forced diff | The browser aborted the request 0.37 s after leaving. Both git and its text conversion child were gone at 0.5 s. The registered-directory gauge returned to zero. |

**Built-server replacement check.** The hardening task used an isolated server on port 39429.
It set a deliberately low **1 MiB** recycle threshold and kept the normal **30 s** reporting period.
The intervals below start at the replacement attempt or at the external commit respectively.

| Observation | Result |
|---|---|
| Active helper RSS before and after switch, time until ready | 60.6 → 53.2 MiB in 375 ms |
| State after handover and after an external commit | Version 1 in the new epoch, then version 2 in 901 ms from the commit |
| Minute counters | 1 planned recycle, 0 crash restarts |
| Shutdown | 59 service log lines including shutdown, zero errors. The server and both helpers exited. |

Sources for these acceptance checks are the step 3a, step 4 and hardening handoffs in 2.6. The
[benchmark report](../packages/server/scripts/bench-command-helper-memory.md) also records the
built-server replacement run.

**Task opening with the light log view, first A/B (2026-11-19).** Two built servers ran side by
side on copies of the same five production sessions: the branch `at/7dd18ece` after step 1 and its
base `77447b6`. Each sat behind a small proxy that compresses responses with zstd. That proxy
spoke HTTP/1.1, while production speaks HTTP/2; the second A/B below corrects this. Headless
Chromium in Docker emulated 450 ms latency, 375 KB/s down and 128 KB/s up. Each open was timed
from the click in the task list to the first log row and to the first translated paragraph. A
cold open used a fresh browser context. A warm open followed the opening of another task, so the
task view's code was already loaded. Four rounds alternated which build went first (ABBA). The
host also ran other work; its load average was 2.3–6.8 between rounds.

Each cell is the median of four opens, base → branch, sorted by log size.

| Session | Cold: first log row | Cold: first translation | Warm: first log row | Warm: first translation |
|---|---:|---:|---:|---:|
| `6017fb8b` | 8.8 → 6.7 s | 13.4 → 6.7 s | 5.2 → 3.4 s | 10.0 → 3.4 s |
| `07f8a026` | 6.9 → 5.7 s | 8.1 → 5.7 s | 4.0 → 2.6 s | 5.0 → 2.6 s |
| `94a8967f` | 6.5 → 5.8 s | 9.1 → 5.8 s | 3.3 → 2.4 s | 5.8 → 2.4 s |
| `a74f2b1d` | 6.0 → 5.2 s | 7.1 → 5.2 s | 2.7 → 2.2 s | 4.1 → 2.2 s |
| `90d922fc` | 5.6 → 4.9 s | 5.8 → 4.9 s | 2.2 → 1.9 s | 2.7 → 1.9 s |

For the first log row, the four-run ranges of the two builds overlapped in three of the ten cells
(cold `94a8967f`, cold and warm `90d922fc`). For the first translation they never overlapped. On
the branch the first translated paragraph appeared in the same frame as the first log row in every
run. On the base build the paged overlay reads started after the log had rendered.

| Session, cold open | Log transfer | Log requests | Overlay requests | Overlay transfer | All API transfer |
|---|---:|---:|---:|---:|---:|
| `6017fb8b` | 889 → 398 KB | 1 → 1 | 11 → 2 | 230 → 301 KB | 1,130 → 710 KB |
| `07f8a026` | 474 → 135 KB | 1 → 1 | 4 → 2 | 117 → 108 KB | 602 → 254 KB |
| `94a8967f` | 451 → 185 KB | 1 → 1 | 7 → 2 | 127 → 136 KB | 589 → 331 KB |
| `a74f2b1d` | 329 → 118 KB | 1 → 1 | 4 → 2 | 89 → 81 KB | 426 → 207 KB |
| `90d922fc` | 276 → 30 KB | 2 → 1 | 2 → 2 | 30 → 30 KB | 320 → 74 KB |

Transfers are compressed sizes. Warm opens differed by at most one overlay request and 15 KB. The
base build downloaded the finished session `90d922fc` twice; the second download is the terminal
revalidation in 5.C.1. Per download, the light view was 2.2–4.6 times smaller than the full log.
The branch's two overlay reads are the ones described in 5.D (item 4); for `6017fb8b` they moved
71 KB more than the base build's paged reads. Cold opens took about 3 s longer than warm opens on
both builds, mostly for loading the task view's code.

A functional run on the branch build expanded every collapsed item of a long session over four
rounds. It showed 11 complete outputs, and all 4 entry requests answered 200. No output stayed
loading or failed, and the page reported no errors.

**Task opening, second A/B over HTTP/2 (2026-11-19).** Production serves the app through Caddy
over HTTPS, so browsers use HTTP/2 there. Over the first A/B's HTTP/1.1 proxy, Chromium opens at
most six connections per host, so fan-outs of many small requests queued. This run put a separate
Caddy instance with production's `encode zstd gzip` and `reverse_proxy` in front of each build,
over TLS with HTTP/2. The branch build includes 5.C.6, 5.D and the caching and delivery changes in
5.E; the base is again `77447b6`. The five sessions were copied again. They had grown since the
first run (`94a8967f` to a 4.6 MB log), so the two runs differ cell by cell. Link emulation and
ABBA order were as before, with four rounds.

A returning visit opens the app in a new tab of a browser that had visited it and opened another
task. It is throttled from navigation on and is the usual case for daily use. Host load reached
13–17 in the last two rounds. Each cell is the median of four opens, base → branch, in seconds.

| Session | Log transfer | First visit: log, translation | App open: log, translation | Returning: log, translation |
|---|---:|---:|---:|---:|
| `94a8967f` | 1,262 → 339 KB | 8.6, 12.4 → 6.0, 6.0 | 6.8, 12.3 → 3.1, 3.1 | 10.1, 16.1 → 4.2, 4.2 |
| `6017fb8b` | 1,245 → 421 KB | 8.9, 14.0 → 6.5, 6.9 | 7.0, 13.1 → 3.7, 3.7 | 10.5, 18.0 → 4.6, 4.6 |
| `07f8a026` | 631 → 139 KB | 7.3, 8.8 → 5.2, 5.2 | 4.0, 5.3 → 2.7, 2.7 | 7.9, 9.8 → 3.5, 3.5 |
| `a74f2b1d` | 388 → 119 KB | 5.4, 7.0 → 4.3, 4.3 | 2.7, 4.4 → 2.1, 2.1 | 5.7, 7.3 → 3.0, 3.0 |
| `90d922fc` | 299 → 30 KB | 4.4, 4.9 → 4.1, 4.1 | 1.9, 2.7 → 1.6, 1.6 | 4.4, 5.4 → 2.5, 2.5 |

The first log row appeared 8–30% sooner on a first visit, 16–54% sooner with the app open and
43–59% sooner on a returning visit. Every round favoured the branch: per round, the five first-row
times summed to 31.8–49.0 → 23.8–30.8 s on first visits, 21.8–32.2 → 12.4–16.3 s with the app open
and 27.8–51.4 → 17.3–27.4 s on returning visits. The four-run ranges overlapped in 15 of the 35
time cells, mostly through single slow runs in the loaded rounds. On the branch the first
translated paragraph appeared in the same frame as the first log row in 57 of 60 opens and at most
1.3 s later in the other three. On the base build it followed 0.2–13.1 s later.

| Returning visit | Board appears | Chunks revalidated: load, open | API requests on open | Delivery requests on open |
|---|---:|---:|---:|---:|
| `94a8967f` | 5.5 → 3.5 s | 37, 22 → 0, 0 | 42 → 25 | 7 → 3 |
| `6017fb8b` | 5.4 → 3.3 s | 37, 22 → 0, 0 | 44 → 26 | 7 → 3 |
| `07f8a026` | 5.8 → 3.6 s | 37, 22 → 0, 0 | 41 → 25 | 14 → 2 |
| `a74f2b1d` | 5.0 → 3.3 s | 37, 22 → 0, 0 | 31 → 26 | 6 → 3 |
| `90d922fc` | 5.4 → 3.4 s | 37, 22 → 0, 0 | 48 → 28 | 23 → 4 |

On the base build, a returning visit revalidated all 37 chunks of the board and the 22 of the task
view; each answer was a 304, so the cost is the round trips. The branch took every chunk from the
browser cache. A first visit downloads the same chunks on both builds. The base build read each
historical delivery on its own. The branch read them in batches, one per tick in which rows
rendered; while the list measured its rows, that came to 2–4 requests.

A functional run on this build expanded every collapsed item of `07f8a026` over four rounds. The
light log came in one request, and three batched entry reads answered 200. Nothing stayed loading
or failed, and the page reported no errors.

### 6.2 Guarantees kept

Viewers share work without sharing access credentials. A valid subscription receives a complete
snapshot after a placement change. The two REST views remain available, with the additive file token
on change entries. Mutation checks use live git state. Owned commands retain process-tree cleanup on
the Linux supervisor path (5.A.2). An unsupported or unavailable helper leaves Tower functional.

### 6.3 Remaining sources of latency

PTYs, ACP launches and direct executable probes still start from the server. The cost on Linux
depends on inherited non-V8 memory and host load. Git still scans a worktree when state is computed.
External working-file edits wait for a signal or safety check. Section 8 lists the accepted diff
and cache limits.

Opening a session still loads every entry. The light view only shortens long tool outputs, so
`6017fb8b` still transfers 421 KB in the second A/B (398 KB, 1.5 MB uncompressed, in the first),
mostly entry fields and short entries.
Loading the tail first (5.C.4) is the next step for long sessions.

The task view's own requests, the log among them, start only after its code has loaded: 20
files, 362 KB with zstd. Two chunks carry most of it. One holds the log renderer with its Markdown
pipeline (164 KB; Rollup named it after a Mermaid module inside, but Mermaid itself loads only for
a diagram). The other holds the components the desktop and mobile views share (153 KB, named after
the handoff panel). Both are needed for the first paint. Since the caching change in 5.E, a
returning visit takes this code from the browser cache; the first visit after a deployment still
downloads it. The board has loaded the view only on demand since `22b48fa`, because evaluating it
early used memory that made iOS reload the page. A prefetch that only downloads after the board
has rendered (`rel=prefetch`, which Safari ignores) would keep that guarantee; it is not
implemented.

A first open makes two overlay reads (5.D, item 4). The views replace the log stream with a
spinner while the first snapshot loads, so the stream mounts twice. Mounting it once, with the view
rather than the stream starting the overlay read, would remove both the second read and the remount.
The second read starts after the log is shown, so it costs transfer but not display time. The
delivery lists are still polled every 5 s when nothing is pending (5.E). Checkpoints still
serialize the whole log (5.C.3). Production open time has not been measured with the log changes,
which are not deployed.

## 7. Implementation and follow-up

### 7.1 Completed steps

The following commits are in the base branch `at/67407e89` at `3065a3e`. The coordinator reviewed
the steps in dependency order. Section 6.1 reports results from isolated acceptance runs.

| Step | Status | Commits | Delivered |
|---|---|---|---|
| 1. Command helper | Done | `997f00d`, `f99b093` (merge `36f8017`) | Buffered commands in a helper, fallback, bounded waits and event-loop metrics. |
| 2. Git state service | Done | `c82d275` | Shared computations, commit-pair cache and REST views in either process. |
| 3a. Server push | Done | `74d264d`, `b11b8c8` | Authorized subscriptions, change signals, directory watches and delivery recovery. |
| 3b. Web subscription | Done | `dba8813`, `4a0af91` | Desktop/mobile subscription manager, focus refresh and removal of git polling. An obsolete refresh preserves the socket and its terminals. |
| 4. File diffs | Done | `9c38193`, `d574d65` | File tokens, line-count reuse, bounded diff caching, size notices, cancellation and token-keyed web queries. |
| Hardening | Done | `dfb5826`, `e88c0ab` | Helper memory and process-start measurements, including the allocator comparison. |
| Hardening | Done | `3aeaa2b` | Registration retries and visible subscription termination with REST recovery. |
| Hardening | Done | `0cf5311`, `580e7d3` | Planned helper replacement and the final 384 MiB default. |
| Hardening | Done | `933ad35` | Main-worktree rebase detection in the authoritative operation path. |
| Log loading, step 1 | Implemented in `at/7dd18ece`, not deployed | `ee855c2`, `8fca025` (Agent Tower's automatic commits) | Light log view and entry reads, single translation read, metadata patch, single download on open, snapshot cache, narrow Session reads (5.C.2, 5.C.6, 5.D). |
| Task opening, follow-up | Implemented in `at/7dd18ece`, not deployed | `ab6d738` (Agent Tower's automatic commit) | Immutable caching of hashed web assets and batched delivery reads for log views (5.E, 6.1). |

### 7.2 Follow-up work

The review panel's continuous changes list was virtualized separately in `08ea3c7` and `75eaa69`.
That work addresses jumps and rendering in long lists and is outside this git state design.

On 2026-11-18 the owner chose to deploy the merged git work, collect the measurements in 5.F, and
then decide whether to proceed with logs. The original phase numbers below identify options for
that later review.

| Original phase | Pending proposal |
|---|---|
| 0 | Add per-caller spawn timings and log-serving counters if the existing measurements leave questions open. |
| 1 | The metadata patch, the double fetch on open and the polled whole-row reads are fixed on `at/7dd18ece`. Still open: the other whole-row reads in 5.C.1, cached executable lookup, log and translation cancellation, and handling editor launch errors. |
| 4 | Translation overlays no longer parse the log per read (5.D), and log views read message deliveries in batches (5.E). Still open: mounting the log stream once so a first open reads overlays once (6.3), merging single changed rows, skipping reads when translation is off, and event-driven delivery lists without the 5 s idle poll. |
| 5 | Change log storage and load the tail first. The original chunked-storage design and the review's per-entry alternative are still open. |

## 8. Known limits

The coordinator accepted the following behaviours in step 4.

| Case | User-visible or operational consequence |
|---|---|
| An edit burst on a file with an open diff | A racy token can fetch that file once during the edit and once more after it settles. A continuously written untracked file can change token and cause a small state push at each computation. |
| A forced patch with more than 1 MiB of text | Each request reaching the service recomputes it. The server cache admission limit is on patch text, even when the input file qualified for **Load anyway**. |
| `git rm --cached` leaves a working file on disk | The change list contains a deletion and an untracked addition for the same path. Both cards resolve to the tracked deletion diff. Previously both showed an addition. |
| A subdirectory is the requested working directory | Tracked paths are repository-relative, while untracked paths are relative to that directory. If the displayed paths collide, the tracked entry wins the diff lookup. |
| Memory during diffs | The 16 MiB cache accounts for UTF-8 text and bookkeeping. JavaScript strings can take about twice the text budget in memory. A forced diff allows up to 33 MiB of command output to pass through the helper. These are bounds on particular data, separate from measured process RSS in 6.1. |

A direct helper replacement or restart has the cost of starting a process from the large server.
Backoff and the planned-replacement interval limit how often that happens. With supervision
unavailable a forced helper exit can leave descendants (5.A.4). A failed watch or an edit outside
Tower can delay detection until focus or the safety check (5.B.3).

The remaining log proposals have their own risks. A storage migration would have to preserve
existing sessions and support recovery. Tail-first loading would have to preserve grouping, scroll
position, delivery ordering, todos and token usage. These are constraints on the open decision.

## 9. Decisions

### 9.1 Accepted implementation and changes from the old behaviour

On 2026-11-16 the owner approved optional command dispatch and change-driven git state. The
following decisions were settled during implementation and review.

| Question | Decision and reason |
|---|---|
| Where to compute | Use one implementation in the active helper or the server so git works with the helper disabled or unavailable. Keep the database, authorization and socket ownership in the server. Re-register directories on every placement change. |
| Which directories to watch | Share a registration among viewers of a directory, including git-backed main-directory workspaces. Watch git metadata and use Tower signals, focus and a 30 s safety check. The owner accepted this window for external working-file edits to avoid the old per-folder watch cost. |
| How to refresh a view | A dedicated subscription acknowledges the current state. Dropping a refresh made obsolete by unsubscribe/resubscribe preserves the socket's other work. Registration failure now has a visible end and a REST fallback, because a silent drop left a stale view marked live. |
| Which paths and counts to return | Count individual untracked files, including when repository config would hide them. Return unquoted paths. Invalid UTF-8 is decoded lossily. Normally files over 1 MiB on either side omit line counts. Binary files within the limit keep zero counts. |
| What git can override | A `.gitattributes` rule that forces text can override git's large-blob binary heuristic. Such a blob can get line counts. The patch path also relies on git's binary classification for blob sides. Working files have a separate size check before git reads them. |
| How to identify operations and commits | The state service tests for the presence of `MERGE_HEAD`, which can differ from git verifying a corrupt ref. Ahead/behind uses HEAD's commit ID, avoiding a tag shadowing the current branch name. The status flags require git 2.17 or newer. |
| What to show when only part of the read fails | In a valid worktree a failed status can leave uncommitted data empty. A failed uncommitted diff leaves paths without counts. On status output overflow (10 MiB), retry with collapsed untracked directories, count them and omit their individual entries. The service records degradation internally. |
| Which diff to show | Use HEAD against the working tree so staged-only edits show their actual patch. The old route could show the entire file as an addition. Committed file diffs use the resolved range from the change list. |
| How much diff data to retain | The rough cache budget became a 16 MiB limit across directories. Use git's diff stats and a single-object size probe only when needed. This bounds retained text and avoids a separate batch probe for each snapshot. |
| When to change tokens and line counts | Use the provisional racy token so an unchanged observation cannot manufacture a new state version. Pay one extra update when a file settles. Reuse the counts of settled records to meet the idle process budget. |
| When to replace a helper | Keep the operator's allocator settings and set the replacement threshold above normal diff-heavy use. Warm a second helper and drain the first so outstanding requests keep their owner (5.A.3, 6.1). |

**Rebase detection in a main worktree.** The state service already checked rebase markers in the
right git directory. The authoritative `WorktreeManager.isRebaseInProgress()` used to resolve git's
relative `.git/rebase-merge` or `.git/rebase-apply` against the server's current directory and could
miss a stopped rebase. With the owner's approval on 2026-11-18, `933ad35` resolves both paths
against the inspected worktree. Conflict recovery and abort now find the markers in main and linked
worktrees. This also lets a session in a clean linked worktree recover a project-directory conflict.
The special REST status for `MAIN_DIRECTORY` in 5.B.1 is a separate display convention.

### 9.2 Still open

The git work is deployed. On 2026-11-19 the owner asked for slow task opening to be fixed, and
the targeted log and translation fixes above were implemented. Still open are chunked versus
per-entry or file storage, tail-first loading, the remaining translation updates and message
deliveries. Section 10 preserves the review's alternatives. Native
process starts for terminals, agents and ACP adapters are also deferred.

## 10. Review recommendations pending decision

The 2026-11-16 review supported measuring first, a consolidated git snapshot, file diff keys and
size guards. It also supported exploring executable lookup in the server, tail-first log loading
and preserving translation correctness. Its alternatives for logs and the remaining timers are
below. On 2026-11-18 the owner deferred these choices until after the git deployment and measurement.

### 10.1 Recommendations

| Topic | This document (proposal) | Review recommendation |
|---|---|---|
| Session rows | Add `select` at each call site that loads a whole `Session` row (5.C.2 item 6, 5.D item 1) | Exclude `logSnapshot` from default `Session` reads at the schema level, so that only code that asks for the log loads it. The installed Prisma client (5.22.0) supports this through the `omitApi` preview feature, which the schema does not enable yet. A global omit of `logSnapshot` has not been tried. |
| Patch contract | Extend the browser's applier with `add /entries/{i}/metadata`, and keep the server's incremental snapshot cache valid while streaming (5.C.2 items 1 and 5) | One shared patch applier for the server and the browser, and a server store that keeps applied entries instead of replaying patches |
| Log storage | Chunks of 200 entries in a new table (5.C.3) | One row per log entry |
| Remaining polling timers | Separate fixes for translations (5.D item 6) and message deliveries (5.E) | One subscription mechanism with a version handshake for all of them, with git state (step 3) as its first user |

### 10.2 Additional findings

The review found these in addition to the plan. They were checked against the code on 2026-11-16.

- **`GET /sessions/:id/logs` loads the whole `Session` row**, including the log column, even when it then
  answers from the live in-memory store (`routes/sessions.ts`).
- **A checkpoint that writes a changed log reads it back.** At the 15 s checkpoint,
  `persistSnapshot` skips the database update when neither the snapshot nor status needs writing.
  When it writes, `prisma.session.update` has no `select`, so Prisma returns the whole updated row
  including the log (`services/session-manager.ts`).
- **The in-memory store keeps raw output that only tests read.**
  - `pushStdout` stores every agent output chunk in the store's message list, counted against its
    100 MB budget (`pipeline/agent-pipeline.ts`, `output/msg-store.ts`).
  - Snapshot rebuilds skip these messages. Only tests read them back, through `getMessages()`.
- **Parsers rebuild the snapshot once per tool result.** The Claude Code, Codex and Cursor Agent parsers
  call `getSnapshot()` in `appendToolResultContent` to read one entry. While streaming keeps the snapshot
  cache cleared (5.C.1), each call is a full rebuild.
- **The patch shape the browser rejects is newer than the browser's contract.** The browser's patch
  applier and contract came with `60e9e01` (2026-09-14). The text-block tracker, which emits
  `add /entries/{i}/metadata`, came with `0f4485f` (2026-10-20).
- **Per-session socket rooms were removed on purpose.**
  - `f632d93` (2026-04-30) removed room-based routing and let clients filter events by session and
    task id.
  - `0f4485f` (2026-10-20) added access-checked `session:<id>`, `task:<id>` and `team-run:<id>` rooms
    for translations and message deliveries.
  - `session:patch` still goes to every current socket.
  - Item 3 of 5.C.2 (send patches only to sockets that show the session) brings per-session routing
    back without discussing why `f632d93` removed it.

### 10.3 How the git changes affect the pending recommendations

- **Memory.** Owned git commands normally start in the helper. PTYs, ACP adapters and direct probes
  can still fork the server. When comparing log storage options, measure inherited non-V8 memory as
  well as total RSS (2.3–2.4).
- **Cancellation.** Working and branch file diffs have end-to-end cancellation (5.B.5). Log and
  translation requests would need their own changes.
- **Executable lookup.** Provider availability and CLI lookup can still launch `which` directly.
  The in-process lookup proposal is open.
- **Subscriptions.** Git now has an implemented subscription and version handshake. Extending that
  mechanism to translations or message deliveries remains a separate decision after deployment.
