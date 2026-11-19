# Command helper memory and process starts

Measured on 18 November 2026 UTC with the built server from `d574d65`, Node 24.22.2, glibc 2.35 and Linux 5.15 x64. The large-output workloads settled in a **219–249 MiB** RSS band with the default allocator. Git state settled near **96–98 MiB**. A synchronous start in the helper took **1.87 ms** at fresh RSS, **3.69 ms** in the 160–192 MiB band, and **5.35 ms** at 224–256 MiB.

`AGENT_TOWER_COMMAND_HELPER_RECYCLE_RSS_MB` defaults to **384 MiB**, about 1.5 times the highest measured plateau, to reserve replacement for abnormal growth. Heavy diff and output workloads crossed 160 MiB within seconds, so that limit could trigger a replacement every ten minutes to save only 1.8–3.5 ms per start on the helper’s own thread. Each replacement costs one fork of the server process, and direct starts blocked the 757–758 MiB benchmark caller for an average of 51.5 ms in one run and 164.2 ms in another.

## Memory over time

Each row used a fresh helper and a scratch repository. The two-arena run set `MALLOC_ARENA_MAX=2` for the helper launch alone. State rounds visited 30 small linked worktrees in sequence, each with a tracked edit. Registered rounds invalidated each worktree before requesting its state. Ordinary diffs cycled through 24 settled 0.9375 MiB text files, with an immediate cache-hit check and misses on cycling past the 16 MiB cache. Forced diffs used a 7.875 MiB file. Command output cycled through 1, 5 and 10 MiB.

Samples continued after 30 state rounds, 96 ordinary diffs or output calls, and 20 forced diffs until four consecutive RSS checkpoints were within 8% of their minimum. Every run reached that criterion within its 600-second timeout. The ranges describe the observed load and sampling interval. Faster workloads reached the criterion sooner.

| Workload | Allocator | Samples over time, seconds / MiB RSS | Last four RSS samples, MiB | Final rounds or calls |
|---|---|---|---|---:|
| State reads | default | 1 / 51.5 → 7 / 71.0 → 23 / 80.6 → 34 / 95.2 → 44 / 95.7 | 89.3–95.7 | 40 |
| State reads | 2 arenas | 1 / 53.0 → 7 / 70.5 → 23 / 79.9 → 34 / 93.1 → 44 / 94.0 | 93.1–94.0 | 40 |
| Registered state | default | 1 / 52.9 → 41 / 79.5 → 241 / 75.6 → 505 / 97.8 | 97.3–97.8 | 60 |
| Registered state | 2 arenas | 1 / 53.0 → 41 / 78.4 → 123 / 93.8 → 254 / 97.8 | 93.8–97.8 | 30 |
| 0.94 MiB diffs | default | 1 / 53.1 → 2 / 93.8 → 10 / 181.9 → 13 / 214.9 → 25 / 224.7 | 224.7–241.9 | 240 |
| 0.94 MiB diffs | 2 arenas | 1 / 53.0 → 2 / 92.9 → 9 / 180.3 → 29 / 235.8 → 59 / 242.6 | 229.8–247.7 | 588 |
| 7.88 MiB forced diffs | default | 1 / 53.0 → 5 / 127.7 → 18 / 201.9 → 35 / 204.0 → 64 / 218.6 | 218.6–233.9 | 76 |
| 7.88 MiB forced diffs | 2 arenas | 1 / 53.0 → 4 / 127.4 → 15 / 204.4 → 19 / 247.7 → 29 / 239.3 | 232.2–247.7 | 32 |
| 1–10 MiB output | default | 1 / 53.3 → 3 / 149.6 → 8 / 229.6 → 15 / 249.0 | 231.0–249.0 | 96 |
| 1–10 MiB output | 2 arenas | 1 / 53.0 → 3 / 144.9 → 8 / 236.5 → 16 / 231.0 | 228.5–232.1 | 96 |

## Memory accounting

All sizes below are MiB at the final checkpoint. Node includes array buffers in external memory. The residual is RSS minus used V8 heap minus external memory. It includes unused resident heap capacity, mapped code and native allocations. Node's allocation counters and Linux's resident pages measure different things. The benchmark reads Node's counters before the first probe and the helper's own `smaps_rollup` after the fifteenth, so garbage collection can also move RSS between those readings.

| Workload | Allocator | RSS | Heap used / total | External | Array buffers | Residual | smaps RSS / anonymous / private dirty |
|---|---|---:|---:|---:|---:|---:|---:|
| State reads | default | 95.7 | 18.1 / 46.1 | 2.6 | 0.3 | 75.1 | 95.8 / 49.5 / 49.5 |
| State reads | 2 arenas | 94.0 | 15.7 / 46.6 | 2.5 | 0.2 | 75.8 | 94.2 / 47.8 / 47.8 |
| Registered state | default | 97.8 | 12.9 / 16.3 | 2.5 | 0.2 | 82.5 | 97.8 / 51.6 / 51.6 |
| Registered state | 2 arenas | 97.8 | 16.8 / 33.3 | 2.6 | 0.3 | 78.4 | 97.8 / 51.4 / 51.4 |
| 0.94 MiB diffs | default | 224.7 | 27.9 / 156.4 | 7.5 | 2.3 | 189.4 | 224.8 / 178.4 / 178.4 |
| 0.94 MiB diffs | 2 arenas | 242.6 | 57.0 / 168.3 | 32.4 | 14.9 | 153.2 | 225.7 / 179.3 / 179.3 |
| 7.88 MiB forced diffs | default | 218.6 | 31.2 / 151.8 | 26.5 | 8.2 | 160.9 | 202.6 / 156.2 / 156.2 |
| 7.88 MiB forced diffs | 2 arenas | 239.3 | 22.1 / 152.6 | 10.5 | 0.2 | 206.7 | 240.1 / 193.7 / 193.7 |
| 1–10 MiB output | default | 249.0 | 25.7 / 156.8 | 12.8 | 0.6 | 210.4 | 249.0 / 202.9 / 202.9 |
| 1–10 MiB output | 2 arenas | 231.0 | 40.0 / 151.3 | 33.7 | 15.4 | 157.3 | 231.0 / 185.0 / 185.0 |

With the default allocator, private dirty anonymous memory reached 156–203 MiB after diffs and large output. V8 also retained 152–157 MiB of heap capacity at these checkpoints even though it used only 26–31 MiB. The two-arena setting produced almost the same state plateaus. It improved the large-output endpoint by 18 MiB and raised the ordinary and forced diff endpoints by 18 and 21 MiB. These results leave the allocator at its operator default. The residual cannot be attributed to glibc arenas from these measurements.

## Synchronous process starts inside the helper

Each checkpoint timed 15 real `/bin/true` scope-supervisor starts on the helper's thread. Timing surrounds `ChildProcess.prototype.spawn` in a benchmark-only preload. IPC, completion and writing the sample happen outside the timed section. Each cell gives the median of the per-checkpoint p50s, followed by the number of checkpoints.

| RSS, MiB | Default p50, ms (batches) | Two arenas p50, ms (batches) |
|---|---:|---:|
| 0–<64 | 1.87 (5) | 1.67 (5) |
| 64–<100 | 1.83 (21) | 1.76 (15) |
| 100–<128 | 2.77 (2) | 2.67 (3) |
| 128–<160 | 3.07 (3) | 3.00 (2) |
| 160–<192 | 3.69 (6) | 3.68 (6) |
| 192–<224 | 4.48 (15) | 5.09 (14) |
| 224–<256 | 5.35 (20) | 5.55 (39) |

## Dispatch from a large server process

The existing benchmark interleaved 40 direct and 40 helper-dispatched `git status` calls in a clean scratch repository after touching 700 MiB of buffers. The caller's RSS was 757–758 MiB. Both allocator runs dispatched all 40 helper calls. The varying direct results show how much host load affected timings.

| Helper allocator | Route | Caller blocked mean / p50 / p95, ms | End-to-end mean / p50, ms |
|---|---|---:|---:|
| Default | Direct | 51.5 / 57.3 / 80.7 | 54.8 / 60.3 |
| Default | Helper | 0.19 / 0.19 / 0.30 | 8.6 / 7.1 |
| 2 arenas | Direct | 86.5 / 92.3 / 112.1 | 96.8 / 95.1 |
| 2 arenas | Helper | 0.21 / 0.18 / 0.46 | 8.0 / 6.2 |

## Built-server replacement

The shipped client repeated the 40-call benchmark with a 757 MiB caller. Helper dispatch blocked for 0.28 ms mean, 0.17 ms p50 and 1.60 ms p95. Direct starts in that run blocked for 164.2 ms mean and 186.7 ms p50. Median end-to-end time through the helper was 6.4 ms.

The socket acceptance run used a 1 MiB trigger on port 39429 and the normal 30-second stats cadence. The active helper switched from **60.6 MiB to 53.2 MiB in 375 ms**, measured from the replacement attempt to ready. A subscribed socket received version 1 of the new epoch, then version 2 for an external commit in **901 ms**. The minute metric recorded one recycle and zero restarts. All 59 service log lines, including shutdown, were free of errors. The server and both helper PIDs had exited after stopping the service.

## Reproduction

Use a private scratch home, temporary directory and Agent Tower data directory. Build the shared and server packages and provide the Linux scope supervisor. Run one workload at a time. Each memory checkpoint is written as a JSON line with elapsed time, memory and spawn percentiles.

```sh
for workload in state registered diff forced output; do
  timeout 600 node packages/server/scripts/bench-command-helper-memory.mjs "$workload"
  timeout 600 node packages/server/scripts/bench-command-helper-memory.mjs "$workload" --helper-arenas=2
done
timeout 150 node packages/server/scripts/bench-command-helper.mjs --runs 40 --memory-mb 700 --repo "$BENCH_REPO"
HELPER_BENCH_ARENAS=2 timeout 150 node packages/server/scripts/bench-command-helper.mjs --runs 40 --memory-mb 700 --repo "$BENCH_REPO"
```

`BENCH_REPO` is the path of a clean scratch repository. The memory benchmark disables planned replacement for its measurement process.
