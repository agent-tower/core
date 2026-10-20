import { spawn, execFileSync } from 'node:child_process';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Finite acceptance workers only. The separate POSIX process group is an ownership
// boundary, not a background service. No worker may escape it (setsid/breakaway).
export async function runOwned(command, args, { cwd, env = process.env, timeout = 120_000,
  maxOutput = 1024 * 1024, input = '', grace = 250, cleanup = 3000 } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 180_000) throw new Error('INVALID_TIMEOUT');
  if (process.platform === 'win32') throw new Error('POSIX_PRODUCTION_PATH_ONLY');
  return runPosix(command, args, { cwd, env, timeout, maxOutput, input, grace, cleanup });
}

function launch(command, args, options) {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, exited: false, closed: false, code: null, error: false, size: 0, overflow: false };
  child.on('error', () => { state.error = true; state.exited = true; });
  child.on('exit', code => { state.code = code; state.exited = true; });
  child.on('close', () => { state.closed = true; });
  const consume = chunk => { state.size += chunk.length; state.overflow ||= state.size > options.maxOutput; };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  child.stdin.on('error', () => {}); // An early exit/EPIPE never bypasses tree cleanup.
  return state;
}

function livingGroup(pgid, deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error('CLEANUP_DEADLINE');
  try { process.kill(-pgid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  // A zombie has already exited; kill(0) alone cannot distinguish it. Never infer
  // exit from a failed enumeration. This bounded observation is outside DB work.
  const rows = execFileSync('/bin/ps', ['-eo', 'pgid=,stat='], { encoding: 'utf8', timeout: Math.min(500, remaining), maxBuffer: 2 * 1024 * 1024 });
  const parsed = rows.trim().split('\n').map(line => /^\s*(\d+)\s+(\S+)\s*$/.exec(line));
  if (!parsed.length || parsed.some(row => !row)) throw new Error('INVALID_PROCESS_OBSERVATION');
  return parsed.some(row => Number(row[1]) === pgid && !row[2].startsWith('Z'));
}
function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function runPosix(command, args, options) {
  const started = performance.now();
  const s = launch(command, args, { ...options, detached: true });
  s.child.stdin.end(options.input);
  const interrupt = () => { s.interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let confirmed = false, timedOut = false, cleanupError = false, stopReason;
  try {
    for (;;) {
      if (s.exited) { stopReason = 'ROOT_EXIT'; break; }
      if (s.overflow) { stopReason = 'OUTPUT_LIMIT'; break; }
      if (s.interrupted) { stopReason = 'INTERRUPT'; break; }
      if (performance.now() - started >= options.timeout) { stopReason = 'TIMEOUT'; timedOut = true; break; }
      await pause(10);
    }
    if (!s.child.pid) confirmed = s.error; // spawn failed: no owned worker existed.
    else {
      const deadline = performance.now() + options.cleanup;
      signalGroup(s.child.pid, 'SIGTERM'); // Also terminate descendants after a normal root exit.
      const gentleEnd = Math.min(deadline, performance.now() + options.grace);
      while (performance.now() < gentleEnd && livingGroup(s.child.pid, deadline)) await pause(10);
      if (livingGroup(s.child.pid, deadline)) signalGroup(s.child.pid, 'SIGKILL');
      while (performance.now() < deadline) {
        if (s.exited && !livingGroup(s.child.pid, deadline)) { confirmed = true; break; }
        await pause(20);
      }
    }
  } catch {
    cleanupError = true;
    // Enumeration failure is not exit evidence; still make a bounded best effort
    // to stop the owned group, then quarantine its fixture.
    if (s.child.pid) { try { signalGroup(s.child.pid, 'SIGKILL'); } catch { /* unconfirmed */ } }
  }
  finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    // Do not wait for `close`: inherited pipes are not an exit oracle.
    s.child.stdout.destroy(); s.child.stderr.destroy(); s.child.stdin.destroy();
  }
  return { code: confirmed && !timedOut && !s.overflow && !s.interrupted && !s.error && !cleanupError ? s.code ?? 1 : 1,
    cleanupConfirmed: confirmed, timedOut, overflow: s.overflow, interrupted: !!s.interrupted,
    reason: !confirmed ? 'TREE_EXIT_UNCONFIRMED' : s.error ? 'SPAWN_FAILED' : undefined,
    elapsedMs: Math.round(performance.now() - started), rootExitCode: s.code, stopReason, ownership: 'POSIX_PROCESS_GROUP' };
}
