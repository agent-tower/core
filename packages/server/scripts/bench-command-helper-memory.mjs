// Linux, after the server build. Run one workload at a time, e.g.
// timeout 600 node packages/server/scripts/bench-command-helper-memory.mjs registered
// Repeat with --helper-arenas=2. HOME, TMPDIR and the data directory must be scratch paths.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CommandHelperClient, resolveCommandHelperEntry } from '../dist/runtime/command-helper/client.js';

const workload = process.argv[2];
assert(['state', 'registered', 'diff', 'forced', 'output'].includes(workload), 'Choose state, registered, diff, forced or output');
const MiB = 1024 * 1024;
const mb = (bytes) => Number((bytes / MiB).toFixed(1));
const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'helper-memory-'));
const repo = path.join(root, 'repo');
process.env.HELPER_BENCH_SAMPLES = path.join(root, 'samples.jsonl');
process.env.AGENT_TOWER_COMMAND_HELPER_RECYCLE_RSS_MB = '0';
const entry = resolveCommandHelperEntry();
entry.execArgv.push('--import', new URL('./bench-command-helper-probe.mjs', import.meta.url).href);
const helper = new CommandHelperClient({ entry });
const git = (...args) => execFileSync('git', args, { cwd: repo, timeout: 10_000, stdio: 'pipe' });
const started = performance.now();
let gitProcesses = 0;
let computations = 0;

async function sample(round) {
  const pid = helper.status().pid;
  fs.writeFileSync(process.env.HELPER_BENCH_SAMPLES, '');
  for (let n = 0; n < 15; n++) await helper.run('/bin/true', [], { cwd: repo, timeout: 5_000 });
  const probes = fs.readFileSync(process.env.HELPER_BENCH_SAMPLES, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const times = probes.map(probe => probe.spawnMs).sort((a, b) => a - b);
  const { rss, heapUsed, heapTotal, external, arrayBuffers } = probes[0];
  const smaps = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  const kib = (name) => Number(new RegExp(`^${name}: +([0-9]+)`, 'm').exec(smaps)[1]) * 1024;
  console.log(JSON.stringify({
    workload, round, elapsedSec: Math.round((performance.now() - started) / 1000),
    rss: mb(rss), heapUsed: mb(heapUsed), heapTotal: mb(heapTotal), external: mb(external), arrayBuffers: mb(arrayBuffers),
    rest: mb(rss - heapUsed - external), smapsRss: mb(kib('Rss')), anon: mb(kib('Anonymous')), privateDirty: mb(kib('Private_Dirty')),
    spawnP50Ms: +times[7].toFixed(3), spawnP95Ms: +times[14].toFixed(3), gitProcesses, computations,
  }));
  return mb(rss);
}

try {
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'tracked'), 'base\n');
  git('add', '.');
  git('-c', 'user.name=Benchmark', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base');
  const stateWorkload = workload === 'state' || workload === 'registered';
  const requests = [];
  if (stateWorkload) {
    for (let i = 0; i < 30; i++) {
      const worktreePath = path.join(root, 'wt-' + i);
      git('worktree', 'add', '-q', '--detach', worktreePath);
      fs.appendFileSync(path.join(worktreePath, 'tracked'), 'changed\n');
      requests.push({ worktreePath, repositoryPath: repo, baseBranch: 'main' });
    }
  }
  const files = [];
  if (workload === 'diff' || workload === 'forced') {
    // 24 cycling patches below the 1 MiB per-entry cap overflow the 16 MiB LRU.
    // Forced patches exceed the entry cap. Reuse one file to keep the repo small.
    const lines = (workload === 'forced' ? 7.875 : 0.9375) * MiB / 64;
    const contents = ('x'.repeat(63) + '\n').repeat(lines);
    for (let i = 0; i < (workload === 'diff' ? 24 : 1); i++) {
      files.push('file-' + i);
      const file = path.join(repo, files[i]);
      fs.writeFileSync(file, contents);
      fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    }
  }
  const arenaOption = process.argv.find(arg => arg.startsWith('--helper-arenas='));
  const previousArenas = process.env.MALLOC_ARENA_MAX;
  if (arenaOption) process.env.MALLOC_ARENA_MAX = arenaOption.slice('--helper-arenas='.length);
  try { assert(await helper.start()); } finally {
    if (previousArenas === undefined) delete process.env.MALLOC_ARENA_MAX;
    else process.env.MALLOC_ARENA_MAX = previousArenas;
  }
  await sample(0);
  const step = stateWorkload ? 5 : workload === 'forced' ? 4 : 12;
  const minimum = stateWorkload ? 30 : workload === 'forced' ? 20 : 96;
  const recent = [];
  for (let round = 1; performance.now() - started < 575_000; round++) {
    if (stateWorkload) {
      const roundStart = performance.now();
      for (const request of requests) {
        if (workload === 'registered' && round > 1) helper.invalidateGitState(request.worktreePath, 'refresh');
        const result = await (workload === 'registered' ? helper.registerGitState(request) : helper.requestGitState(request));
        assert(result.snapshot.available && result.snapshot.uncommitted.length === 1);
        ({ gitProcesses, computations } = result.counters);
      }
      // Cross the 1 s freshness window on every turn.
      await delay(Math.max(0, 1050 - (performance.now() - roundStart)));
    } else if (workload === 'output') {
      const bytes = [1, 5, 10][(round - 1) % 3] * MiB;
      const { stdout } = await helper.run('head', ['-c', String(bytes), '/dev/zero'], { timeout: 30_000, maxBuffer: 10 * MiB });
      assert.equal(stdout.length, bytes);
    } else {
      const request = {
        worktreePath: repo, repositoryPath: repo, baseBranch: 'main', path: files[(round - 1) % files.length],
        kind: 'uncommitted', force: workload === 'forced',
      };
      const result = await helper.requestGitDiff(request);
      assert.equal(result.diff?.kind, 'text');
      assert.equal(result.source, 'computation');
      if (workload === 'diff' && round === 1) {
        assert(Buffer.byteLength(result.diff.diff) <= MiB);
        assert.equal((await helper.requestGitDiff(request)).source, 'cache');
      }
      gitProcesses = result.counters.gitProcesses;
      computations = result.counters.diffComputations;
    }
    if (round % step !== 0) continue;
    recent.push(await sample(round));
    if (recent.length > 4) recent.shift();
    // Report a plateau only after four samples within 8% of one another.
    if (round >= minimum && Math.max(...recent) <= Math.min(...recent) * 1.08) break;
  }
} finally {
  try { await helper.stop(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
