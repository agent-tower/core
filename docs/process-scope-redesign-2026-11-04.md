# Process scope redesign: kernel-anchored execution domains instead of process-table sampling (2026-11-04)

Status: **proposal only**. Nothing is implemented, built, deployed, or changed on the server.
Scope: the mechanism behind `terminal-manager.ts`, `unix-process-identity.ts`, `owned-child-process.ts`,
the PTY wrapper in `process-launch.ts`, `runtime/acp/process-manager.ts` and
`workspace-background-process-manager.ts`.

## 1. Current status summary

- Root cause of the main-process CPU on 192.204.56.110 (0.7.4-beta.2, PID 16118): every standalone
  terminal runs `refreshGroups` every 100 ms; one refresh performs three full `/proc` enumerations
  (`captureOwnedGroups` reads `stat` + `status` + `environ` for every process, then
  `captureDescendantGroups` enumerates twice more). Four idle terminals = roughly 120 enumerations
  per second, ~35,000 `/proc` file reads per second, for zero lifecycle events.
- A prior proposal suggested replacing this with an "execution domain" backed by cgroup v2 / systemd on
  Linux, Job Objects on Windows, and a compatibility mode elsewhere.
- This document agrees with the domain model but replaces the Linux backend: **a per-scope supervisor
  process that is a child subreaper**. It needs no privileges, works on the target server today, removes
  all runtime polling, and gives an event-driven "domain empty" signal. The claims below were verified
  with two one-shot, self-cleaning demos on the server itself (section 4.1).

## 2. What the current mechanism is for

The business requirement (commits `286c3010`, `23e262ac`, `c4cf4f26`, audit `docs/process-leak-audit-2026-09-08.md`):

1. Stopping a session, terminal, command, or background service must reclaim **every** process it started,
   including descendants that ignore SIGHUP, call `setsid`, clear their environment, or outlive their parent.
2. Never signal a process that is not ours (PID reuse, unrelated same-user processes).
3. Long-lived services must have an owner independent of a single Agent turn.
4. Cleanup failures stay retryable; "no evidence" must never be read as "domain empty".

Linux gives three natural lineage links: parent PID, process group, session. All three can be broken
by the child (exit of the parent, `setsid`, `setpgid`), and the environment marker can be scrubbed.
Once a link is broken the kernel keeps no record of where the process came from. The current code
therefore **samples the process table continuously** to record lineage before it disappears
(`ancestry` map in `DefaultUnixProcessIdentityAdapter`, `trackedGroupMembers` in the PTY wrapper).
The 100 ms interval is not an accident: `owned-child-process.test.ts` covers a parent that spawns a
detached, env-less child and exits 700 ms later. Slowing the sampling widens the window in which such
a child is lost; speeding it up costs CPU. **Polling is the wrong tool because the kernel can be asked
to keep the lineage instead.**

## 3. Assessment of the cgroup / Job Object proposal

What is right and should be kept:

- One `ProcessScope` abstraction with an explicit owner, scope id, and generation, used by terminals,
  commands, CLI/ACP sessions, and background services alike.
- The domain exists **before** the user command executes (no "start first, register later" window).
- Business completion, root exit, output drained, and domain empty remain separate signals.
- Compatibility mode is explicit and reported, never silently presented as a full guarantee.
- No cleanup by bare PID; retryable failure is distinct from "confirmed empty".

What does not hold up:

1. **The cgroup backend is unavailable where the problem exists.** Verified on the server: the service
   runs in `/sys/fs/cgroup/system.slice/agent-tower.service`, owned by root, not writable by `tower`,
   no `Delegate=`; there is no user systemd manager (`XDG_RUNTIME_DIR` unset, user not lingering), so
   `systemd-run --user --scope` cannot work either. The same is true of the common deployments:
   `npm i -g agent-tower` run from a user shell, the Electron desktop app, and most containers
   (`/sys/fs/cgroup` read-only). The proposal's own fallback for these cases is the scanning backend,
   so in practice the CPU problem would remain on this server unless someone also edits the systemd
   unit, which the user has ruled out for now and which should not be a design dependency.
2. **It does not address a server crash.** If the main process is SIGKILLed or OOM-killed, every tree
   leaks until the next start runs the persisted-identity recovery, which is itself a full scan.
3. **It adds a third mechanism next to two existing ones.** Agent sessions and background services already
   run under a per-launch Node wrapper (`PTY_WRAPPER_SCRIPT`) that runs `ps eww -A` with a 256 MiB buffer
   at 50/250/1000/5000 ms and on stop; terminals and `OwnedChildProcess` poll from the main process.
   The redesign should converge all of them onto one supervisor, not layer cgroups on top.
4. **Windows "create suspended, join, resume" is unnecessary.** The existing IPC wrapper
   (`WINDOWS_COMMAND_WRAPPER`) already waits for a `start` message; assigning the wrapper to a Job
   before sending `start` puts every descendant in the Job with no suspended-thread tricks.

## 4. Recommended design: scope supervisor (subreaper) + ProcessScope API

### 4.1 Facts verified on 192.204.56.110 (read-only, one-shot Python demos, all processes reaped)

Host: Ubuntu kernel 5.15.0-30, cgroup2, `CONFIG_PROC_CHILDREN=y`, Node 24.22.2, 195 processes total,
18 in the service cgroup, main PID 16118 (ppid 1). This session itself runs as
`16118 → node -e (PTY wrapper) → claude → bash`, i.e. inside the service.

| Claim | Result |
| --- | --- |
| `prctl(PR_SET_CHILD_SUBREAPER, 1)` as uid 1000 | rc = 0, no privilege needed |
| Grandchild started with `env={}` + new session, parent exits | grandchild's ppid became the subreaper (not 1); pgid = sid = itself; environ empty |
| `/proc/<pid>/task/<pid>/children` recursive walk | lists the orphan; O(tree) reads, no `/proc` scan |
| `wait()` after killing descendants | returns `ECHILD` = event-driven "domain empty" |
| Interactive `bash -i` under a subreaper wrapper on a PTY (`pty.fork`) | no "no job control" warning, `set -o monitor` on, bash became its own pgrp leader, `sleep 300 &` listed as job `[1]` |
| `nohup setsid sleep 300 &` then `exit` | wrapper stayed alive; walk listed both sleeps, one in its own session; after SIGKILL the wrapper exited with status 0 and nothing was left |

### 4.2 The supervisor ("scope root")

A tiny static native helper (C, roughly 150 lines; built and shipped per platform the same way the
`@shitiandmw/node-pty` fork ships `prebuilds/` for linux-x64, linux-arm64, darwin-x64, darwin-arm64,
win32-x64, win32-arm64). It is the process node-pty or `child_process.spawn` actually starts.

On Linux it:

1. Calls `prctl(PR_SET_CHILD_SUBREAPER, 1)`. From now on every orphaned descendant is re-parented to the
   helper, regardless of `setsid`, `setpgid`, scrubbed environment, or how many intermediate parents exit.
2. Optionally calls `prctl(PR_SET_PDEATHSIG, SIGTERM)` and re-checks `getppid()` (policy flag per scope).
   When the server dies for any reason, including SIGKILL, the kernel signals the helper, which stops
   its tree. Terminals and sessions enable it; a service that must survive a restart would not.
3. Forks and execs the real command as its child with inherited stdio (PTY or pipes untouched).
4. Reports the child's exit status to the server over a control channel (business event:
   "shell exited" / "command finished"), then **keeps running until `wait()` returns `ECHILD`**
   (domain event: "scope empty"). Its own exit is therefore the completion signal; the server receives
   it through node-pty `onExit` or `ChildProcess 'exit'` with no polling.
5. On a stop request (control message or SIGTERM/SIGHUP to the helper): walk
   `/proc/<self>/task/<self>/children` recursively, signal every member (`pidfd_open` +
   `pidfd_send_signal` on kernel ≥ 5.3 so a reused PID can never be hit; fallback `kill` guarded by
   `starttime`), repeat the walk until stable, escalate to SIGKILL after the grace period, exit when empty.
   If the `children` file is missing (`CONFIG_PROC_CHILDREN=n`), do one `/proc` scan at stop time only.
6. Takes the scope id and policy from `argv`, never from the environment. The environment token can stay
   as a human-readable label but is no longer a discovery mechanism, so reading `/proc/*/environ` of
   other processes, the EACCES special-casing, and `ps eww` disappear.

### 4.3 Server-side contract

```ts
interface ProcessScope {
  readonly id: string;           // scope id, persisted with owner + generation
  readonly rootPid: number;      // helper pid; the only pid the server ever stores
  onRootExit(cb: (status) => void): void;   // business event
  onEmpty(cb: () => void): void;            // domain event, from helper exit
  stop(opts: { signal: 'SIGHUP' | 'SIGTERM'; graceMs: number }): Promise<void>; // resolves on empty
  readonly capabilities: { lineageAnchored: boolean; crashCleanup: boolean; emptySignal: 'event' | 'poll' };
}
```

- `TerminalManager`, `OwnedChildProcess`/`runOwnedCommand`, `WorkspaceBackgroundProcessManager`,
  CLI sessions (`base.executor.ts`) and `AcpProcessManager` all start through `ProcessScope`.
  Their timers (`groupsCaptureTimer`, `captureTimer`, the wrapper's probe schedule) are deleted.
- `UnixProcessIdentityAdapter` shrinks to the compatibility backend (macOS, exotic kernels) and is no
  longer referenced on the hot path.
- Terminal UX: `terminal:exit` is emitted on the shell's exit (business event) instead of after the
  whole tree is gone; a separate `terminal:closed` (or the existing cleanup promise) fires on empty.

### 4.4 Crash and restart behavior

- Server SIGKILL/OOM: `PR_SET_PDEATHSIG` stops every scope that opted in. No scan on next start.
- Scopes meant to survive (future option for background services): persist `{scopeId, helperPid,
  starttime, generation}`; on start verify `/proc/<pid>/stat` starttime and re-adopt by sending the
  control signal and waiting on that single PID. One read per persisted scope instead of a table scan.
- Helper crash (unlikely for a static helper doing `wait`): orphans re-parent to the next subreaper.
  If the server also sets `PR_SET_CHILD_SUBREAPER` on itself (one addon call), they land on the server,
  which treats unknown children as leaked and stops them at shutdown. This is the only residual
  compatibility path on Linux.

### 4.5 Platform backends and capability detection

- **Linux (primary)**: subreaper helper as above, any kernel ≥ 3.4; pidfd on ≥ 5.3; optional hardening
  when a writable cgroup exists (`Delegate=yes` or a user manager): the helper additionally creates
  `<own cgroup>/scope-<id>` and uses `cgroup.freeze` + `cgroup.kill`. Optional, detected at start,
  never required. PID namespaces (`unshare --pid`) only where privileged or user-ns is acceptable.
- **Windows**: Job Object created by the server through a small addon (host it in the node-pty fork,
  whose prebuild pipeline already covers win32-x64/arm64): `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
  no breakaway, completion port for "job empty". Assign the existing IPC wrapper to the Job, then send
  `start`. For ConPTY terminals the same "wrapper waits for go" handshake closes the pre-assignment window.
- **macOS**: no subreaper, no cgroups. Keep the compatibility backend, but make it one shared process
  snapshot per tick for all scopes at ≥ 1 s (never per-scope at 100 ms), and evaluate a helper using
  `kqueue EVFILT_PROC` with `NOTE_TRACK`/`NOTE_CHILD` to learn forks at fork time. Report
  `lineageAnchored: false` honestly in logs/UI.

### 4.6 Boundaries

The scope is a lifecycle domain, not a sandbox. Processes created through other daemons (docker,
systemd-run, launchd, remote APIs) are not descendants and must be owned by the business layer that
requested them, exactly as today. A child inside the scope can still mutate files or network state.

## 5. Impact

- Main process: no periodic process-table work at all on Linux. Idle terminals cost nothing; stop costs
  O(tree). The ~35,000 reads/s and the associated async-fs, allocation and GC load disappear instead of
  being rate-limited.
- Correctness improves: the 700 ms "root exits early" scenario and the `env -i` background job become
  deterministic (kernel-maintained lineage) rather than sampling-dependent. Server crash leaves no
  orphans. No reading of other processes' environments.
- Costs: one native helper to build/sign for six targets; one extra tiny process per scope
  (~100 KB RSS, 1-2 ms spawn); a rewrite of the ownership tests around the new events; the terminal
  exit-event semantics change described in 4.3.
- Unchanged: host CPU steal (44-59 % observed), CadQuery/Python load in the Codex task, normal message
  handling. No fixed whole-machine percentage can be promised.

## 6. Migration order and verification (if implementation is requested)

1. Build the Linux helper and a `ProcessScope` wrapper; port `TerminalManager` first.
   Real-process tests to keep green: `terminal-manager.test.ts` (foreground / background /
   markerless-background), `owned-child-process.test.ts`. Add: parent-exits-early, `setsid` + `env -i`,
   SIGHUP-ignoring child, helper-under-PTY job control, server SIGKILL leaves no orphans.
2. Port `OwnedChildProcess` (git hooks, CLI installers), then `WorkspaceBackgroundProcessManager`
   and CLI sessions (delete the `ps eww` tracking from the PTY wrapper, keep its stdin/duplex plumbing
   or run it under the helper), then `AcpProcessManager` and the persisted-identity recovery.
3. Windows Job Object backend; macOS evaluation; capability reporting in logs/UI.
4. Local/test environments only. No changes on 192.204.56.110 until a beta is explicitly approved.

## 7. Open questions

- Where the helper lives: separate `@agent-tower/scope-helper` prebuilt package versus adding it to the
  node-pty fork's prebuild matrix. The fork already has the signing/publishing pipeline.
- Whether background services should ever survive a server restart (today they do not); this decides
  the default for `PR_SET_PDEATHSIG` on that scope type.
- macOS `NOTE_TRACK` reliability on current releases needs a prototype before it is promised.

## 8. Implementation status (2026-11-04, branch `at/e535787b`, uncommitted)

Implemented on the Linux host itself (192.204.56.110, read-only toward the running service):

| Piece | Location |
| --- | --- |
| Supervisor source (C, static, Linux) | `packages/server/native/scope-helper/agent-tower-scope.c` |
| Build script (zig cc → host cc → docker alpine) | `packages/server/scripts/build-scope-helper.mjs`, hooked into the server `build` script with `--if-possible` |
| Built binary (gitignored, 63 KB) | `packages/server/prebuilds/linux-x64/agent-tower-scope` |
| Probe + runtime | `packages/server/src/runtime/process-scope/scope-helper.ts`, `process-scope.ts` |
| Terminals on the supervisor | `packages/server/src/services/terminal-manager.ts` (`processScope` option; `null` = old backend) |
| Owned commands on the supervisor | `packages/server/src/utils/owned-child-process.ts` (`SupervisedChildProcess`, `scope` option) |
| Packaging | `scripts/build-publish.mjs` (requires both Linux arches, `AGENT_TOWER_SCOPE_HELPER_TARGETS`, `AGENT_TOWER_ALLOW_MISSING_SCOPE_HELPER=1`), `packages/server/scripts/postinstall.js` (exec bit), `packages/desktop/scripts/prepare-runtime.mjs` (ships + probes it on Linux) |
| Docs | `.agents/skills/publish/SKILL.md`, `.claude/skills/agent-tower-dev/references/backend-patterns.md` |

Runtime switches: `AGENT_TOWER_PROCESS_SCOPE=compat` forces the old backend; `AGENT_TOWER_SCOPE_HELPER_PATH`
points at another binary. Without a working binary the server logs nothing special and runs the old backend.

Supervisor protocol: `--grace`, `--root-exit-signal`, `--pdeathsig`, `--status-fd`; SIGHUP/SIGTERM/SIGINT to
the supervisor forward that signal; SIGUSR1 escalates to SIGKILL; the supervisor exits with the command's
status when `wait()` reports no children. Never SIGKILL the supervisor itself.

### Verification on this host

- `tsc --noEmit` for the server: clean.
- `process-scope.test.ts`: 9 tests (3 pure, 6 real-process: exit code/signal propagation, status lines,
  detached env-less grandchild after early parent exit, setsid member ignoring SIGTERM, immediate
  escalation, launcher SIGKILL → scope stopped via PDEATHSIG). All pass.
- `terminal-manager.test.ts`: 13 tests, the real `/bin/sh` cases on both backends; 3 consecutive clean runs
  after fixing a test race (reading `/proc/<pid>/cmdline` before the supervisor exec'd). Supervised cases
  take 0.3–0.5 s, the old backend 2.0–2.9 s.
- `owned-child-process.test.ts`: 10 tests pass on the supervisor path (git hooks, installers, cancellation).
- Idle CPU, 4 real terminals, 5 s, main process only: old backend 7,189 ms and 7,123 ms; supervisor 5 ms and 0 ms.
- Observed once under parallel test load: the old backend's `/proc/<pid>/environ` read hit EACCES on a
  same-user process mid-exec and failed a compat test; it does not reproduce when the file runs alone and
  is independent of this change (that scan no longer runs on the supervisor path).

### Not migrated yet (still the old mechanism)

1. PTY wrapper for CLI sessions and workspace background services (`process-launch.ts`, `base.executor.ts`,
   `workspace-background-process-manager.ts`): one-shot `ps eww -A` probes plus stop-time polling.
2. `AcpProcessManager` and `cleanupPersistedAcpProcessTree` (stop-time scans, restart recovery).
3. Windows Job Objects; macOS (compat backend, still 100 ms per-scope sampling there).

### Next steps, in order

1. Build a beta for the x64 server: `AGENT_TOWER_SCOPE_HELPER_TARGETS=linux-x64 pnpm build:publish` on a
   host with docker or zig, then the usual pack/smoke flow from the publish skill. For the general npm
   release both arches are required (zig cross-compiles both).
2. Move the PTY wrapper under the supervisor and delete its `ps` tracking; then `AcpProcessManager`.
3. CI: add zig (or `docker/setup-qemu-action` for arm64) to the workflow that produces the npm tarball.
4. Lower the compat backend's sampling to one shared snapshot per second for macOS.

### Handoff note (task-handoff MCP tools were unavailable in this session)

Status: supervisor backend implemented and tested for terminals and owned commands; nothing committed,
nothing deployed, the running service on 192.204.56.110 untouched. The worktree has `node_modules`
installed (`npm_config_manage_package_manager_versions=false` before pnpm) and the shared package built.
Constraints: do not restart or reconfigure `agent-tower.service`; any process-spawning test on this host
runs inside the production service's cgroup, so bound it and clean up. Open decisions: commit the Linux
prebuilds or build them in CI; whether background services should survive a server restart (PDEATHSIG
default for that scope type).
