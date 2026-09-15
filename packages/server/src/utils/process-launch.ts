import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CommandInvocation {
  command: string;
  args: string[];
}

export function getNodeRuntimeCommand(): string {
  return process.env.AGENT_TOWER_NODE_RUNTIME || process.execPath;
}

/**
 * Electron packaged builds can use the Electron executable itself as a Node
 * fallback when a bundled Node runtime is unavailable. That executable needs
 * ELECTRON_RUN_AS_NODE; a real Node binary does not.
 */
function isStandaloneNodeRuntime(runtimeCommand: string): boolean {
  // `runtimeCommand` may be a Windows path even when this helper is exercised
  // from a POSIX test process, so do not rely on the host platform's separator.
  const executableName = runtimeCommand.replace(/^.*[\\/]/, '').toLowerCase();
  return executableName === 'node' || executableName === 'node.exe';
}

export const PTY_WRAPPER_ENV_KEYS = [
  'AGENT_TOWER_NODE_RUNTIME',
  'ELECTRON_RUN_AS_NODE',
  'AGENT_TOWER_TREE_CLEANUP_CHANNEL',
  'AGENT_TOWER_TREE_CLEANUP_SECRET',
  'AGENT_TOWER_PROCESS_IDENTITY',
  'AGENT_TOWER_PTY_IDENTITY_SEED',
] as const;

export function buildPtyWrapperEnv(
  agentEnv: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv = process.env,
  ownershipToken?: string,
  cleanupChannel?: Record<string, string>,
): Record<string, string> {
  const wrapperEnv = { ...agentEnv };
  // Process identity is launch ownership metadata. Never let a wrapper adopt
  // the marker of the process that happened to launch it (for example an ACP
  // Agent running a test suite). A missing token gets a fresh one so the
  // wrapper still owns and can clean up its descendants safely.
  delete wrapperEnv.AGENT_TOWER_PROCESS_IDENTITY;
  delete wrapperEnv.AGENT_TOWER_PTY_IDENTITY_SEED;
  const launchOwnershipToken = ownershipToken?.trim() || randomUUID();
  const runtimeCommand = parentEnv.AGENT_TOWER_NODE_RUNTIME || process.execPath;
  const preserveElectronNodeMode = !isStandaloneNodeRuntime(runtimeCommand);
  if (!preserveElectronNodeMode) {
    delete wrapperEnv.ELECTRON_RUN_AS_NODE;
  }
  for (const key of PTY_WRAPPER_ENV_KEYS) {
    if (key === 'AGENT_TOWER_TREE_CLEANUP_CHANNEL'
      || key === 'AGENT_TOWER_TREE_CLEANUP_SECRET'
      || key === 'AGENT_TOWER_PROCESS_IDENTITY'
      || key === 'AGENT_TOWER_PTY_IDENTITY_SEED'
      // Electron's bootstrap marker is a parent-runtime implementation detail.
      // It is only needed when the wrapper itself runs through Electron.
      || (key === 'ELECTRON_RUN_AS_NODE' && !preserveElectronNodeMode)) continue;
    const value = parentEnv[key];
    if (value !== undefined) {
      wrapperEnv[key] = value;
    }
  }
  wrapperEnv.AGENT_TOWER_PROCESS_IDENTITY = launchOwnershipToken;
  wrapperEnv.AGENT_TOWER_PTY_IDENTITY_SEED = launchOwnershipToken;
  // Completion is parent-owned and intentionally has no environment
  // representation. Keep this argument for API compatibility, but never copy
  // endpoint/secret material into a wrapper or Agent environment.
  void cleanupChannel;
  return wrapperEnv;
}

const PTY_WRAPPER_SCRIPT = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { createReadStream, unlinkSync } = require('node:fs');

const [mode, programPath, ...rest] = process.argv.slice(1);
const isWin = process.platform === 'win32';
const isCmdBat = isWin && /\.(cmd|bat)$/i.test(programPath);
const internalEnvKeys = ${JSON.stringify(PTY_WRAPPER_ENV_KEYS)};
const processIdentityEnvKey = 'AGENT_TOWER_PROCESS_IDENTITY';
const processIdentitySeedEnvKey = 'AGENT_TOWER_PTY_IDENTITY_SEED';
// A wrapper can be invoked directly by a test, shell, or third-party caller
// without going through buildPtyWrapperEnv. In that case the parent may carry
// its own identity marker (for example an ACP Agent). Treat that marker as
// inherited metadata, never as this launch's ownership. The explicit seed is
// the only marker accepted from the caller; otherwise create one here before
// any process-table probe runs.
const processIdentityToken = process.env[processIdentitySeedEnvKey]
  || require('node:crypto').randomUUID();
process.env[processIdentityEnvKey] = processIdentityToken;
process.env[processIdentitySeedEnvKey] = processIdentityToken;

let child;
let cleanupTarget = null;
let forceKillTimer = null;
let treeExitPoll = null;
let finishing = false;
let groupIdentityTimers = [];
const trackedGroupMembers = new Map();
const trackedWindowsMembers = new Map();
let identityIncomplete = false;
let childExited = false;

function getChildEnv() {
  const env = { ...process.env };
  for (const key of internalEnvKeys) {
    if (key === processIdentityEnvKey) continue;
    delete env[key];
  }
  delete env[processIdentitySeedEnvKey];
  // Keep the ownership marker in Agent descendants. It is only an ownership
  // label used for process discovery, never a completion capability.
  return env;
}

function cleanup() {
  for (const timer of groupIdentityTimers) clearTimeout(timer);
  groupIdentityTimers = [];
  if (!cleanupTarget) return;
  const target = cleanupTarget;
  cleanupTarget = null;
  try { unlinkSync(target); } catch {}
}

function parseProcessRows(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  const rows = stdout.split('\n').filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
    return match ? {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      birthIdentity: match[4],
      command: match[5],
    } : null;
  });
  return rows.length > 0 && !rows.some((row) => !row) ? rows : null;
}

function readProcessTable() {
  if (!child || isWin) return { status: 'IDENTITY_INCOMPLETE', rows: [], complete: false };
  const probeEnv = { ...process.env };
  delete probeEnv[processIdentityEnvKey];
  delete probeEnv[processIdentitySeedEnvKey];
  // 'lstart' is parsed below as a stable process birth identity. Force the
  // portable C layout even when the server inherits a localized user env.
  probeEnv.LC_ALL = 'C';
  probeEnv.LANG = 'C';
  const base = spawnSync('ps', ['eww', '-axo', 'pid=,ppid=,pgid=,lstart=,command='], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: probeEnv,
  });
  if (base.error || base.status !== 0 || typeof base.stdout !== 'string' || !base.stdout.trim()) {
    return { status: 'PROBE_UNAVAILABLE', rows: [], complete: false };
  }
  const rows = parseProcessRows(base.stdout);
  if (!rows) {
    return { status: 'IDENTITY_INCOMPLETE', rows: [], complete: false };
  }
  if (rows.length > 16_384) {
    return { status: 'IDENTITY_INCOMPLETE', rows: [], complete: false };
  }
  const owned = rows.filter((row) => (
    row.pid !== process.pid
      && row.command.includes(processIdentityEnvKey + '=' + processIdentityToken)
  ));
  // The complete flag distinguishes a valid system snapshot with no marker-bearing
  // rows from an empty/failed probe. Only the former can prove that an
  // already-observed child has no remaining owned descendants.
  // Keep the complete process table as well as the marker-bearing owner rows.
  // Native agent launchers are allowed to scrub this marker from descendants;
  // ownership is established by a marked root and then expanded through its
  // process group / parent-child edges below.
  return { status: 'ALIVE', rows, owned, complete: true };
}

function captureProcessGroupIdentity() {
  if (!child || isWin) return;
  const probe = readProcessTable();
  if (probe.status !== 'ALIVE') return;
  const trackedLeader = trackedGroupMembers.get(child.pid);
  const leader = probe.owned.find((row) => row.pid === child.pid);
  // A short-lived launcher can disappear before the first scheduled ps
  // snapshot. The launch token is unique to this wrapper, so visible marker
  // rows are still valid ownership evidence even when the direct leader row
  // has already exited. If the leader was observed before, reject a birth
  // identity change (PID reuse) rather than widening the owner set.
  if (trackedLeader && (!leader || trackedLeader.birthIdentity !== leader.birthIdentity)) return;
  const ownedPids = new Set(probe.owned.map((row) => row.pid));
  const ownedGroups = new Set(probe.owned.map((row) => row.pgid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of probe.rows) {
      if (ownedPids.has(row.pid) || !ownedPids.has(row.ppid)) continue;
      ownedPids.add(row.pid);
      changed = true;
    }
  }
  for (const row of probe.rows) {
    if (!ownedPids.has(row.pid) && !ownedGroups.has(row.pgid)) continue;
    const existing = trackedGroupMembers.get(row.pid);
    if (existing && existing.birthIdentity !== row.birthIdentity) {
      identityIncomplete = true;
      continue;
    }
    trackedGroupMembers.set(row.pid, { pgid: row.pgid, birthIdentity: row.birthIdentity });
  }
}

function scheduleProcessGroupIdentityCapture() {
  if (!child) return;
  if (isWin) {
    captureWindowsTree();
    for (const delay of [50, 250, 1000, 5000]) {
      const timer = setTimeout(captureWindowsTree, delay);
      if (timer.unref) timer.unref();
      groupIdentityTimers.push(timer);
    }
    return;
  }
  // Capture synchronously while the group leader is still our known child.
  // Fast commands may spawn a background process and exit before a zero-delay
  // timer runs, leaving no trustworthy identity from which to sweep the group.
  captureProcessGroupIdentity();
  for (const delay of [50, 250, 1000, 5000]) {
    const timer = setTimeout(captureProcessGroupIdentity, delay);
    if (timer.unref) timer.unref();
    groupIdentityTimers.push(timer);
  }
}

function captureRemainingProcessGroupIdentity() {
  if (!child || isWin) return;
  const probe = readProcessTable();
  if (probe.status !== 'ALIVE') return;
  // Seed from any marker-bearing rows that are still visible. This matters
  // when the direct launcher exits before the first capture but a native
  // descendant remains alive and carries the launch token.
  const trackedPids = new Set([
    ...trackedGroupMembers.keys(),
    ...probe.owned.map((row) => row.pid),
  ]);
  const trackedGroups = new Set([
    ...[...trackedGroupMembers.values()].map((member) => member.pgid),
    ...probe.owned.map((row) => row.pgid),
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of probe.rows) {
      if (trackedPids.has(row.pid) || !trackedPids.has(row.ppid)) continue;
      trackedPids.add(row.pid);
      trackedGroups.add(row.pgid);
      changed = true;
    }
  }
  for (const row of probe.rows) {
    if (!trackedPids.has(row.pid) && !trackedGroups.has(row.pgid)) continue;
    const existing = trackedGroupMembers.get(row.pid);
    if (existing && existing.birthIdentity !== row.birthIdentity) {
      identityIncomplete = true;
      continue;
    }
    if (!existing) trackedGroupMembers.set(row.pid, { pgid: row.pgid, birthIdentity: row.birthIdentity });
  }
}

function matchingTrackedGroupMembers() {
  if (!child || isWin || trackedGroupMembers.size === 0) return [];
  const probe = readProcessTable();
  if (probe.status !== 'ALIVE') return null;
  return probe.rows.filter((row) => (
    trackedGroupMembers.get(row.pid)?.pgid === row.pgid
      && trackedGroupMembers.get(row.pid)?.birthIdentity === row.birthIdentity
  ));
}

const unixIdentityAdapter = {
  captureGroup: captureProcessGroupIdentity,
  captureRemainingGroup: captureRemainingProcessGroupIdentity,
  matchingGroupMembers: matchingTrackedGroupMembers,
  signalGroup(signal) {
    const members = matchingTrackedGroupMembers();
    if (!members || members.length === 0) return false;
    let signalled = false;
    for (const pgid of new Set(members.map((row) => row.pgid))) {
      try {
        process.kill(-pgid, signal);
        signalled = true;
      } catch {}
    }
    return signalled;
  },
  isGroupAlive() {
    const members = matchingTrackedGroupMembers();
    return members !== null && members.length > 0;
  },
  groupState() {
    if (!child || isWin) return 'IDENTITY_INCOMPLETE';
    const probe = readProcessTable();
    if (probe.status !== 'ALIVE') return probe.status;
    if (identityIncomplete) return 'IDENTITY_INCOMPLETE';
    if (trackedGroupMembers.size === 0) {
      // A complete system snapshot after the direct child exit and with no
      // marker-bearing descendants is the only fast-exit exception. Empty or
      // malformed probes fail closed; there is no safe inference from an empty result.
      return childExited && probe.complete ? 'CLEAN_EMPTY' : 'IDENTITY_INCOMPLETE';
    }
    const matches = probe.rows.filter((row) => (
      trackedGroupMembers.get(row.pid)?.pgid === row.pgid
        && trackedGroupMembers.get(row.pid)?.birthIdentity === row.birthIdentity
    ));
    return matches.length > 0 ? 'ALIVE' : 'CLEAN_EMPTY';
  },
};

function terminateWindowsTree() {
  if (!child || !isWin || child.pid == null) return false;
  captureWindowsTree();
  let signalled = false;
  // A root exit does not remove its background descendants. Check the birth
  // identity of each previously observed member and target those still alive,
  // instead of repeatedly asking taskkill to traverse a vanished root PID.
  for (const [pid, birthMarker] of trackedWindowsMembers) {
    const probe = readWindowsProcessRows();
    if (probe.status !== 'ALIVE') return signalled;
    if (!probe.rows.some((row) => row.pid === pid && row.birthMarker === birthMarker)) continue;
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (result.status === 0) signalled = true;
    } catch {}
  }
  return signalled;
}

function readWindowsProcessRows() {
  if (!isWin) return { status: 'IDENTITY_INCOMPLETE', rows: [] };
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
      return { status: 'PROBE_UNAVAILABLE', rows: [] };
    }
    if (!result.stdout.trim()) return { status: 'IDENTITY_INCOMPLETE', rows: [] };
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    // The Windows System Idle Process has PID 0 and no creation date. It is
    // never an owned child and must not invalidate an otherwise complete CIM table.
    const normalized = rows.filter((row) => row.ProcessId !== 0 && row.ProcessId !== '0').map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      birthMarker: String(row.CreationDate || ''),
    }));
    if (normalized.length === 0 || normalized.some((row) => !Number.isInteger(row.pid)
      || row.pid <= 0 || !Number.isInteger(row.ppid) || row.ppid < 0 || !row.birthMarker)) {
      return { status: 'IDENTITY_INCOMPLETE', rows: [] };
    }
    return { status: 'ALIVE', rows: normalized };
  } catch {
    return { status: 'PROBE_UNAVAILABLE', rows: [] };
  }
}

function captureWindowsTree() {
  if (!child || !isWin || child.pid == null) return;
  const probe = readWindowsProcessRows();
  if (probe.status !== 'ALIVE') return;
  const rows = probe.rows;
  const descendants = new Set(rows.filter((row) => (
    trackedWindowsMembers.get(row.pid) === row.birthMarker
  )).map((row) => row.pid));
  const root = rows.find((row) => row.pid === child.pid);
  // The live ChildProcess handle establishes the first root observation. Once
  // it exits, neither a stale ParentProcessId nor a reused PID can seed a tree.
  if (root && !trackedWindowsMembers.has(child.pid)
    && child.exitCode === null && child.signalCode === null) descendants.add(child.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  for (const row of rows) {
    if (descendants.has(row.pid)) {
      const existing = trackedWindowsMembers.get(row.pid);
      if (!existing || existing === row.birthMarker) trackedWindowsMembers.set(row.pid, row.birthMarker);
    }
  }
}

function windowsTreeAlive() {
  if (!child || !isWin) return false;
  const probe = readWindowsProcessRows();
  if (probe.status !== 'ALIVE') return true;
  if (trackedWindowsMembers.size === 0) return false;
  const rows = probe.rows;
  return [...trackedWindowsMembers].some(([pid, birthMarker]) => rows.some((row) => (
    row.pid === pid && row.birthMarker === birthMarker
  )));
}

function windowsTreeState() {
  if (!child || !isWin) return 'IDENTITY_INCOMPLETE';
  const probe = readWindowsProcessRows();
  if (probe.status !== 'ALIVE') return probe.status;
  if (trackedWindowsMembers.size === 0) return 'IDENTITY_INCOMPLETE';
  const alive = [...trackedWindowsMembers].some(([pid, birthMarker]) => probe.rows.some((row) => (
    row.pid === pid && row.birthMarker === birthMarker
  )));
  return alive ? 'ALIVE' : 'CLEAN_EMPTY';
}

// 终止 child 及其整个进程组。
// Unix 下 child 以 detached 启动（pgid === child.pid），组播信号可覆盖
// child 派生的整棵子树（pnpm dev、tsc --watch 等），防止孙进程被 init
// 收养成为孤儿。同一信号只发送一次；每次组播前重新校验组成员的
// birth identity 与本次 launch token，身份不匹配时拒绝发送。
// Windows 使用 taskkill /T /F 处理整个 descendant tree。
function killTree(signal) {
  if (!child) return;
  if (isWin) {
    // Keep the wrapper alive until the child handle settles. A root exit by
    // itself is not tree-cleanup evidence; taskkill owns the descendant kill.
    if (!terminateWindowsTree() && !child.killed) {
      try { child.kill(signal); } catch {}
    }
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    unixIdentityAdapter.captureGroup();
  }
  unixIdentityAdapter.signalGroup(signal);
  // The direct child handle is still authoritative while Node reports it
  // alive. Detached Unix children have their own PGID equal to child.pid, so
  // this fallback reaches launchers that scrub the ownership marker before
  // the process-table capture observes them (for example Codex's native
  // launcher). It never targets a reused PID after the child has exited.
  if (child.exitCode === null && child.signalCode === null && child.pid != null) {
    try { process.kill(-child.pid, signal); } catch {}
    // Some launchers replace the detached process-group leader or report a
    // stale group while Node still owns the child handle. Signalling the
    // handle is race-safe (it cannot target a reused PID) and makes the
    // wrapper observe the child exit so its cleanup state machine can finish.
    try { child['kill'](signal); } catch {}
  }
}

// 收到终止信号后兜底：5 秒内进程组未退干净则升级为 SIGKILL。
function scheduleForceKill() {
  if (forceKillTimer) return;
  forceKillTimer = setTimeout(() => {
    killTree('SIGKILL');
  }, 5000);
  if (forceKillTimer.unref) forceKillTimer.unref();
}

function childProcessGroupExists() {
  if (!child || isWin) return false;
  return unixIdentityAdapter.isGroupAlive();
}

async function exitWithChildResult(code, signal) {
  if (finishing) return;
  finishing = true;
  childExited = true;
  // The group leader may already be reaped. Capture the remaining members with
  // birth identities once, then every poll/signal revalidates those identities
  // so a later PGID/PID reuse cannot be mistaken for this process tree.
  unixIdentityAdapter.captureRemainingGroup();
  captureWindowsTree();
  cleanup();
  // child 已退出：清扫其进程组内残留的后台孙进程（dev server、watch 等）。
  // SIGHUP 与 PTY 关闭语义一致。Unix wrapper 必须等到所有 marker-owned groups 消失后才能退出，
  // 否则 PTY owner 会把 wrapper exit 误判为进程树已清空。
  killTree('SIGHUP');
  const exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
  const initialState = isWin ? windowsTreeState() : unixIdentityAdapter.groupState();
  if (initialState === 'CLEAN_EMPTY') {
    process.exit(exitCode);
  }

  scheduleForceKill();
  const pollTree = async (attempt = 0) => {
    // Descendants may call setsid or fork after the root exit. Refresh the
    // marker-owned identity set before every state decision and signal every
    // known group, rather than freezing the initial PGID snapshot.
    unixIdentityAdapter.captureRemainingGroup();
    captureWindowsTree();
    const state = isWin ? windowsTreeState() : unixIdentityAdapter.groupState();
    if (state === 'CLEAN_EMPTY') {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = null;
      process.exit(exitCode);
      return;
    }
    killTree(attempt >= 5 ? 'SIGKILL' : 'SIGHUP');
    scheduleTreePoll(attempt + 1);
  };
  const scheduleTreePoll = (attempt) => {
    const delay = [50, 100, 250, 500, 1_000, 2_000, 5_000][Math.min(attempt, 6)];
    treeExitPoll = setTimeout(() => {
      treeExitPoll = null;
      void pollTree(attempt);
    }, delay);
  };
  scheduleTreePoll(0);
}

function exitWithError(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (child) {
    // Every post-spawn error shares the same tree cleanup state machine. A
    // direct process.exit here would strand detached descendants.
    void exitWithChildResult(1);
    return;
  }
  cleanup();
  process.exit(1);
}

function escapeArgForCmd(arg) {
  if (/[\s"&|<>^()!]/.test(arg) || arg === '') {
    return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return arg;
}

function spawnCmd(args, stdioOpt) {
  const cmdLine = [programPath, ...args].map(escapeArgForCmd).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + cmdLine + '"'], {
    stdio: stdioOpt,
    env: getChildEnv(),
    windowsVerbatimArguments: true,
    windowsHide: true,
  });
}

// Unix: detached 使 child 自成进程组组长，便于整组击杀。
// stdio 继承的 PTY fd 不受影响（isatty 仍为 true）；终止信号统一由
// 本 wrapper 经 killTree 显式转发。Windows 下 detached 会脱离 ConPTY，
// 保持默认行为。
function spawnChild(args, stdioOpt) {
  return spawn(programPath, args, {
    stdio: stdioOpt,
    detached: !isWin,
    env: getChildEnv(),
    windowsHide: true,
  });
}

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
  process.on(signal, () => {
    killTree(signal);
    scheduleForceKill();
  });
});

if (mode === 'pipe-file') {
  const [stdinFile, ...args] = rest;
  cleanupTarget = stdinFile;
  let stdinStream = null;
  let stdinStreamClosed = false;
  let finishingWithChildResult = false;

  function isBrokenPipeError(error) {
    const code = error && error.code;
    return code === 'EPIPE'
      || code === 'ECONNRESET'
      || code === 'ERR_STREAM_DESTROYED'
      || code === 'ERR_STREAM_WRITE_AFTER_END';
  }

  function closeInputPipe() {
    if (stdinStream && !stdinStream.destroyed) {
      stdinStream.destroy();
    }
    if (child && child.stdin && !child.stdin.destroyed) {
      child.stdin.destroy();
    }
  }

  function afterInputClosed(callback) {
    if (!stdinStream || stdinStreamClosed) {
      cleanup();
      callback();
      return;
    }

    stdinStream.once('close', () => {
      cleanup();
      callback();
    });
    closeInputPipe();
  }

  function finishWithChildResult(code, signal) {
    if (finishingWithChildResult) return;
    finishingWithChildResult = true;
    afterInputClosed(() => exitWithChildResult(code, signal));
  }

  function exitWithPipeError(error) {
    killTree('SIGTERM');
    afterInputClosed(() => exitWithChildResult(1));
  }

  child = isCmdBat
    ? spawnCmd(args, ['pipe', 'inherit', 'inherit'])
    : spawnChild(args, ['pipe', 'inherit', 'inherit']);
  scheduleProcessGroupIdentityCapture();

  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    afterInputClosed(() => exitWithChildResult(1));
  });
  child.on('exit', finishWithChildResult);

  stdinStream = createReadStream(stdinFile);
  stdinStream.on('close', () => {
    stdinStreamClosed = true;
    cleanup();
  });
  stdinStream.on('error', exitWithPipeError);

  if (child.stdin) {
    child.stdin.on('error', (error) => {
      if (isBrokenPipeError(error)) {
        afterInputClosed(() => {});
        return;
      }
      exitWithPipeError(error);
    });
    child.stdin.on('close', () => {
      if (stdinStream && !stdinStream.readableEnded && !stdinStream.destroyed) {
        stdinStream.destroy();
      }
    });
    stdinStream.pipe(child.stdin);
  } else {
    exitWithPipeError(new Error('Child stdin is not available'));
  }
} else {
  child = isCmdBat
    ? spawnCmd(rest, 'inherit')
    : spawnChild(rest, 'inherit');
  scheduleProcessGroupIdentityCapture();

  child.on('error', exitWithError);
  child.on('exit', exitWithChildResult);
}

`;

export function getBundledPrismaCommand(moduleDir: string): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: [path.resolve(moduleDir, '../node_modules/prisma/build/index.js')],
  };
}

export function buildPtyCommand(programPath: string, args: string[]): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: ['-e', PTY_WRAPPER_SCRIPT, 'spawn', programPath, ...args],
  };
}

export function buildPtyCommandWithStdin(
  programPath: string,
  args: string[],
  stdinFile: string
): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: ['-e', PTY_WRAPPER_SCRIPT, 'pipe-file', programPath, stdinFile, ...args],
  };
}

export function escapeArgForWindowsCmd(arg: string): string {
  if (/[\s"&|<>^()!]/.test(arg) || arg === '') {
    return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return arg;
}

export function buildWindowsCmdShimCommandLine(programPath: string, args: string[]): string {
  return [programPath, ...args].map(escapeArgForWindowsCmd).join(' ');
}

function appendPath(paths: string[], value: string | undefined): void {
  if (!value) return;
  const normalized = value.trim();
  if (!normalized || paths.some((item) => item.toLowerCase() === normalized.toLowerCase())) return;
  paths.push(normalized);
}

function getWindowsPathValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

export function buildWindowsPathWithUserBinFallbacks(env: NodeJS.ProcessEnv): string | undefined {
  const paths = (getWindowsPathValue(env) ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);

  const userProfile = env.USERPROFILE;
  const localAppData = env.LOCALAPPDATA;
  const appData = env.APPDATA;

  appendPath(paths, userProfile ? `${userProfile}\\.local\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\Programs\\OpenAI\\Codex\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\Programs\\codex\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\Programs\\Claude\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\Programs\\Cursor\\bin` : undefined);
  appendPath(paths, localAppData ? `${localAppData}\\cursor-agent` : undefined);
  appendPath(paths, appData ? `${appData}\\npm` : undefined);

  return paths.length > 0 ? paths.join(';') : undefined;
}

export function withWindowsUserPathFallbacks(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  const nextPath = buildWindowsPathWithUserBinFallbacks(env);
  if (nextPath) {
    next.PATH = nextPath;
    next.Path = nextPath;
  }
  return next;
}

function getUnixPathValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function getUnixHomeDirectory(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function appendNodeManagerPathFallbacks(paths: string[], home: string): void {
  // npm-installed CLIs under nvm/fnm are commonly invisible to GUI-launched
  // macOS applications because those managers are initialized by shell startup
  // files rather than the login environment inherited by Electron.
  const versionRoots = [
    { root: path.join(home, '.nvm', 'versions', 'node'), suffix: ['bin'] },
    { root: path.join(home, '.fnm', 'node-versions'), suffix: ['installation', 'bin'] },
    { root: path.join(home, '.local', 'share', 'fnm', 'node-versions'), suffix: ['installation', 'bin'] },
  ];

  for (const { root, suffix } of versionRoots) {
    let entries: string[];
    try {
      entries = readdirSync(root).sort().reverse();
    } catch {
      continue;
    }

    for (const entry of entries) {
      appendPath(paths, path.join(root, entry, ...suffix));
    }
  }
}

export function buildUnixPathWithUserBinFallbacks(
  env: NodeJS.ProcessEnv,
  platform: 'darwin' | 'linux' = process.platform === 'darwin' ? 'darwin' : 'linux',
): string | undefined {
  const paths = (getUnixPathValue(env) ?? '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
  const home = getUnixHomeDirectory(env);

  if (home) {
    appendPath(paths, path.join(home, '.local', 'bin'));
    appendPath(paths, path.join(home, '.volta', 'bin'));
    appendPath(paths, path.join(home, '.bun', 'bin'));
    appendPath(paths, path.join(home, '.cargo', 'bin'));
    appendPath(paths, path.join(home, '.asdf', 'shims'));
    appendPath(paths, path.join(home, '.npm-global', 'bin'));
    appendPath(paths, path.join(home, '.npm-packages', 'bin'));
    appendPath(paths, path.join(home, 'bin'));
    if (platform === 'darwin') {
      appendPath(paths, path.join(home, 'Library', 'pnpm'));
    } else {
      appendPath(paths, path.join(home, '.local', 'share', 'pnpm'));
    }
    appendNodeManagerPathFallbacks(paths, home);
  }

  if (platform === 'darwin') {
    appendPath(paths, '/opt/homebrew/bin');
    appendPath(paths, '/opt/homebrew/sbin');
    appendPath(paths, '/usr/local/bin');
    appendPath(paths, '/usr/local/sbin');
  } else {
    appendPath(paths, '/usr/local/bin');
  }

  return paths.length > 0 ? paths.join(':') : undefined;
}

export function withUnixUserPathFallbacks(
  env: NodeJS.ProcessEnv = process.env,
  platform: 'darwin' | 'linux' = process.platform === 'darwin' ? 'darwin' : 'linux',
): NodeJS.ProcessEnv {
  const next = { ...env };
  const nextPath = buildUnixPathWithUserBinFallbacks(env, platform);
  if (nextPath) {
    next.PATH = nextPath;
  }
  return next;
}

export function getDefaultTerminalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): CommandInvocation {
  if (platform === 'win32') {
    return {
      command: env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: [],
    };
  }

  return {
    command: env.SHELL || '/bin/zsh',
    args: [],
  };
}

export function getPtyLogFilePath(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, 'agent-tower-pty.log');
}

export function normalizeCommandLookupOutput(
  stdout: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  // On Windows, `where` may return multiple hits (e.g. `claude`, `claude.cmd`,
  // `claude.ps1`). The extensionless POSIX shim is not directly executable by
  // Node's child_process.spawn, so prefer .cmd/.bat/.exe. The PTY wrapper and
  // Agent CLI command runner execute .cmd/.bat through controlled cmd.exe argv.
  if (platform === 'win32' && lines.length > 1) {
    const preferred = lines.find((l) => /\.(cmd|bat|exe)$/i.test(l));
    if (preferred) return preferred;
  }

  return lines[0];
}
