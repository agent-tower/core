// Preloaded only in the benchmark helper. Time the synchronous spawn on its own
// thread, excluding IPC, the child's runtime, and writing the measurement.
import { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  if (options.args.at(-1) !== '/bin/true') return spawn.call(this, options);
  const memory = process.memoryUsage();
  const start = performance.now();
  const result = spawn.call(this, options);
  const spawnMs = performance.now() - start;
  appendFileSync(process.env.HELPER_BENCH_SAMPLES, JSON.stringify({ ...memory, spawnMs }) + '\n');
  return result;
};
