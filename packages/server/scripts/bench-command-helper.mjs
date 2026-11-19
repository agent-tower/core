#!/usr/bin/env node
/**
 * How long does the calling thread stay blocked per command start, in a large
 * process, when it starts `git status` itself versus through the command
 * helper (packages/server/src/runtime/command-helper)?
 *
 * The process starts the helper while it is still small (as the server does at
 * boot), then grows to about --memory-mb of touched memory, then runs both
 * cases interleaved: "direct" forks in this process (runOwnedCommandInProcess),
 * "helper" sends the request to the helper (runOwnedCommand).
 *
 * The kind of memory matters. V8 marks its heap MADV_DONTFORK (VmFlags "dc"),
 * so fork() does not copy those page tables; memory allocated outside the V8
 * heap (Buffers, native libraries) is copied, and that is what makes forks of
 * the server slow. The default, --memory-kind buffers, allocates that kind;
 * --memory-kind heap shows the contrast.
 *
 * Blocked time is the synchronous part of the call, i.e. the time before the
 * caller's event loop can run anything else.
 *
 * Usage, after `pnpm --filter @agent-tower/server build`:
 *   timeout 600 node packages/server/scripts/bench-command-helper.mjs [--runs 40] [--memory-mb 700] [--memory-kind buffers|heap] [--repo <git work tree>]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(packageRoot, 'dist');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const runs = Number(option('runs', '40'));
const memoryMb = Number(option('memory-mb', '700'));
const memoryKind = option('memory-kind', 'buffers');
if (memoryKind !== 'buffers' && memoryKind !== 'heap') throw new Error('--memory-kind must be buffers or heap');
const repo = path.resolve(option('repo', path.resolve(packageRoot, '../..')));
const MB = 1024 * 1024;

const load = (relative) => import(pathToFileURL(path.join(dist, relative)).href);
const { runOwnedCommand, runOwnedCommandInProcess } = await load('utils/owned-child-process.js');
const helper = await load('runtime/command-helper/client.js');
const { readRuntimeCounters } = await load('runtime/runtime-metrics.js');

function residentMb(pid) {
  if (process.platform !== 'linux') return undefined;
  const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return match ? Number(match[1]) / 1024 : undefined;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted.at(-1),
  };
}

// 1. Start the helper while this process is small.
const smallRssMb = process.memoryUsage.rss() / MB;
const startClock = performance.now();
// Apply an allocator comparison to the helper alone. Server and command environments stay identical.
const previousArenas = process.env.MALLOC_ARENA_MAX;
if (process.env.HELPER_BENCH_ARENAS) process.env.MALLOC_ARENA_MAX = process.env.HELPER_BENCH_ARENAS;
const ready = helper.startCommandHelper({ mode: 'on', log: () => undefined });
if (previousArenas === undefined) delete process.env.MALLOC_ARENA_MAX;
else process.env.MALLOC_ARENA_MAX = previousArenas;
if (!await ready) {
  console.error('The command helper did not start');
  process.exit(1);
}
const helperReadyMs = performance.now() - startClock;
const helperPid = helper.getCommandHelperStatus().pid;
const helperRssAtReadyMb = residentMb(helperPid) ?? helper.getCommandHelperStatus().rssBytes / MB;

// 2. Grow to about memoryMb of touched memory: 16 MB filled Buffers (outside
//    the V8 heap) or 8 MB arrays of doubles (V8 heap).
const retained = [];
if (memoryKind === 'buffers') {
  for (let index = 0; index < Math.round(memoryMb / 16); index += 1) retained.push(Buffer.alloc(16 * MB, index + 1));
} else {
  for (let index = 0; index < Math.round(memoryMb / 8); index += 1) retained.push(new Array(MB).fill(index + 0.5));
}
const largeRssMb = process.memoryUsage.rss() / MB;

// 3. Interleave both cases.
const command = ['git', ['status', '--porcelain'], { cwd: repo, timeout: 60_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }];
const cases = {
  direct: { run: () => runOwnedCommandInProcess(...command), blocked: [], total: [] },
  helper: { run: () => runOwnedCommand(...command), blocked: [], total: [] },
};
async function measure(entry, record) {
  const started = performance.now();
  const pending = entry.run();
  const returned = performance.now();
  await pending;
  if (record) {
    entry.blocked.push(returned - started);
    entry.total.push(performance.now() - started);
  }
}
for (let index = 0; index < 3; index += 1) {
  await measure(cases.direct, false);
  await measure(cases.helper, false);
}
const countersBefore = readRuntimeCounters();
for (let index = 0; index < runs; index += 1) {
  await measure(cases.direct, true);
  await measure(cases.helper, true);
}
const countersAfter = readRuntimeCounters();
const helperRssAfterMb = residentMb(helperPid);
await helper.stopCommandHelper();

// 4. Report.
const format = (value) => (value < 1 ? value.toFixed(2) : value.toFixed(1)).padStart(7);
console.log(`git status --porcelain in ${repo}, ${runs} runs per case, interleaved`);
console.log(`calling process: ${smallRssMb.toFixed(0)} MB when the helper started, ${largeRssMb.toFixed(0)} MB during the runs (${memoryMb} MB of ${memoryKind === 'buffers' ? 'Buffers outside the V8 heap' : 'V8 heap'})`);
console.log(`helper: ready after ${helperReadyMs.toFixed(0)} ms, RSS ${helperRssAtReadyMb?.toFixed(1)} MB at ready, ${helperRssAfterMb?.toFixed(1) ?? 'n/a'} MB after the runs`);
console.log(`dispatch: helper=${countersAfter.commandsViaHelper - countersBefore.commandsViaHelper}`);
console.log('');
console.log('case                     blocked per start (ms)               time per command (ms)');
console.log('                         mean     p50     p95     max          mean     p50');
for (const [name, entry] of Object.entries(cases)) {
  const blocked = stats(entry.blocked);
  const total = stats(entry.total);
  const label = name === 'direct' ? 'direct (fork here)' : 'through the helper';
  console.log(`${label.padEnd(20)} ${format(blocked.mean)} ${format(blocked.p50)} ${format(blocked.p95)} ${format(blocked.max)}      ${format(total.mean)} ${format(total.p50)}`);
}
