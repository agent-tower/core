/**
 * One file's diff, computed by the git state service wherever it runs
 * (design: docs/task-view-latency-redesign-2026-11-16.md, sections 5.B.4 and
 * 5.B.5).
 *
 * - Uncommitted: HEAD against the working tree (`git diff HEAD -- <file>`),
 *   the comparison of the change list. Before the first commit the change
 *   list compares the index, and so does this. An untracked file is shown
 *   whole, as added (`git diff --no-index /dev/null <file>`).
 * - Committed: the comparison of the committed list (`<base>...<head>`, with
 *   the base the state resolved, the remote branch when the local one is
 *   missing).
 *
 * Size guard: the answer is a text diff, `binary`, or `too_large`. A working
 * file above the limit is never handed to git (git would hash it through
 * deflate); `core.bigFileThreshold` makes git report a larger blob as binary
 * without reading it, and the `--stat` line printed with the patch carries
 * both sides' sizes. A miss therefore starts one git process, and a second
 * one (`git cat-file -s`) only when a size is still unknown.
 */
import { GIT_DIFF_CACHE_ENTRY_LIMIT_BYTES, GIT_DIFF_CACHE_LIMIT_BYTES, GIT_FILE_DIFF_FORCED_LIMIT_BYTES, GIT_PROBE_TIMEOUT_MS } from './git-state-limits.js';
import type { GitCommandRunner } from './git-state-compute.js';
import type { UncommittedFileBasis, WorkingFileStat } from './git-file-versions.js';
import { isNullOid } from './git-file-versions.js';
import type { GitFileDiff } from './git-state-types.js';

export type FileDiffTarget =
  | { kind: 'uncommitted'; basis: UncommittedFileBasis; stat: WorkingFileStat | null }
  | { kind: 'committed'; file: string; base: string; head: string; srcOid: string | null; dstOid: string | null };

export interface ComputeFileDiffOptions {
  target: FileDiffTarget;
  token: string;
  /** Per-side size limit of this request. */
  limit: number;
  forced: boolean;
  /** The requested directory: git runs there. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  run: GitCommandRunner;
  signal: AbortSignal;
  /** No command starts after this time (ms since the Unix epoch); running ones get only what is left. */
  deadline: number;
  now: () => number;
  onGitProcess?: () => void;
}

export function gitDiffFailure(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code: 'GIT_DIFF_FAILED', cause });
}

function abortError(): Error {
  return Object.assign(new Error('The git diff was cancelled'), { code: 'ABORT_ERR' });
}

interface GitError { code?: unknown; message?: string; stdout?: unknown }
type Run = { ok: true; stdout: string } | { ok: false; error: GitError };

async function git(options: ComputeFileDiffOptions, args: string[], timeout: number): Promise<Run> {
  if (options.signal.aborted) throw abortError();
  const remaining = options.deadline - options.now();
  if (remaining <= 0) return { ok: false, error: { code: 'ETIMEDOUT', message: 'git diff budget exhausted' } };
  options.onGitProcess?.();
  try {
    const { stdout } = await options.run('git', args, {
      cwd: options.cwd,
      env: options.env,
      timeout: Math.min(timeout, remaining),
      // Each side is at most `limit` bytes (larger ones are binary to git); every line gains a prefix.
      maxBuffer: 4 * options.limit + 1024 * 1024,
      signal: options.signal,
    });
    return { ok: true, stdout };
  } catch (error) {
    if (options.signal.aborted || (error as { code?: unknown } | undefined)?.code === 'ABORT_ERR') throw abortError();
    return { ok: false, error: (error ?? {}) as GitError };
  }
}

// ─── Output of `git diff --stat --patch` ────────────────────────────────────

const PATCH_START = /^diff --/m;
const BINARY_STAT = /\|\s+Bin(?: (\d+) -> (\d+) bytes)?$/m;

/**
 * The stat block comes first (one line for the file, a summary line, an empty
 * line), then the patch, which starts with its `diff --git` header. Stat lines
 * start with a space and quote unusual names, so the first line starting with
 * `diff --` is the patch header.
 */
export function splitStatAndPatch(output: string): { stat: string; patch: string } {
  const match = PATCH_START.exec(output);
  if (!match) return { stat: output, patch: '' };
  return { stat: output.slice(0, match.index), patch: output.slice(match.index) };
}

/** `Bin <old> -> <new> bytes`: binary to git, or larger than `core.bigFileThreshold`. Sizes are null when git printed none. */
export function binaryStat(stat: string): { sizes: { old: number; new: number } | null } | null {
  const match = BINARY_STAT.exec(stat);
  if (!match) return null;
  return { sizes: match[1] === undefined ? null : { old: Number(match[1]), new: Number(match[2]) } };
}

function diffArgs(limit: number): string[] {
  return ['-c', `core.bigFileThreshold=${limit}`, 'diff', '--no-color', '--no-ext-diff', '--stat=300,200', '--patch'];
}

function classify(options: ComputeFileDiffOptions, oldSize: number | null, newSize: number | null): GitFileDiff {
  const largest = Math.max(oldSize ?? 0, newSize ?? 0);
  if (largest > options.limit) {
    return {
      kind: 'too_large', token: options.token, oldSize, newSize, limit: options.limit,
      canForce: !options.forced && largest <= GIT_FILE_DIFF_FORCED_LIMIT_BYTES,
    };
  }
  return { kind: 'binary', token: options.token, oldSize, newSize };
}

/** The second process a miss may start: one blob's size. Null when it cannot be read. */
async function blobSize(options: ComputeFileDiffOptions, oid: string | null): Promise<number | null> {
  if (!oid || isNullOid(oid)) return null;
  const run = await git(options, ['cat-file', '-s', oid], GIT_PROBE_TIMEOUT_MS);
  const size = run.ok ? Number(run.stdout.trim()) : NaN;
  return Number.isSafeInteger(size) ? size : null;
}

/** Both sides of the target: which exist, and the probe for the old side when git printed no sizes. */
function sidesOf(target: FileDiffTarget): { oldExists: boolean; newExists: boolean; probe: string | null; newSize: number | null } {
  if (target.kind === 'committed') {
    const oldExists = !isNullOid(target.srcOid);
    const newExists = !isNullOid(target.dstOid);
    return { oldExists, newExists, probe: oldExists ? target.srcOid : null, newSize: null };
  }
  const { basis, stat } = target;
  const newExists = !basis.deleted && stat !== null;
  return { oldExists: basis.kind !== 'untracked' && basis.oldBlob !== null, newExists, probe: basis.oldBlob, newSize: newExists ? Number(stat!.size) : null };
}

async function answerFromOutput(options: ComputeFileDiffOptions, output: string): Promise<GitFileDiff> {
  const { stat, patch } = splitStatAndPatch(output);
  const binary = binaryStat(stat);
  if (!binary) return { kind: 'text', token: options.token, diff: patch };
  const sides = sidesOf(options.target);
  if (binary.sizes) {
    return classify(options, sides.oldExists ? binary.sizes.old : null, sides.newExists ? binary.sizes.new : null);
  }
  // Git printed `Bin` without sizes (both counted as 0): read the old side once.
  const oldSize = sides.oldExists ? await blobSize(options, sides.probe) : null;
  const newSize = !sides.newExists ? null
    : sides.newSize ?? (options.target.kind === 'committed' && options.target.srcOid === options.target.dstOid ? oldSize : null);
  return classify(options, oldSize, newSize);
}

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Runs the diff of one file. Rejects with `ABORT_ERR` when cancelled and with `GIT_DIFF_FAILED` when git fails. */
export async function computeFileDiff(options: ComputeFileDiffOptions): Promise<GitFileDiff> {
  const { target, limit } = options;
  let args: string[];
  if (target.kind === 'committed') {
    args = [...diffArgs(limit), `${target.base}...${target.head}`, '--', `:(top,literal)${target.file}`];
  } else {
    const { basis, stat } = target;
    const present = !basis.deleted && stat !== null;
    if (basis.kind === 'untracked') {
      // Gone since the state was computed, or an untracked directory (a nested repository): nothing to show.
      if (!stat || stat.isDirectory) return { kind: 'text', token: options.token, diff: '' };
      if (stat.size > BigInt(limit)) return classify(options, null, Number(stat.size));
      args = [...diffArgs(limit), '--no-index', '--', NULL_DEVICE, basis.listed];
    } else {
      if (present && !stat!.isDirectory && stat!.size > BigInt(limit)) {
        // Never handed to git: it would read (and hash) the whole working file.
        return classify(options, await blobSize(options, basis.oldBlob), Number(stat!.size));
      }
      args = [...diffArgs(limit), ...(basis.kind === 'tracked' ? ['HEAD'] : []), '--', `:(top,literal)${basis.file}`];
    }
  }
  const run = await git(options, args, options.timeout);
  if (run.ok) return answerFromOutput(options, run.stdout);
  // `--no-index` exits with 1 when the files differ, which they always do here.
  const stdout = typeof run.error.stdout === 'string' ? run.error.stdout : '';
  if (target.kind === 'uncommitted' && target.basis.kind === 'untracked' && run.error.code === 1 && PATCH_START.test(stdout)) {
    return answerFromOutput(options, stdout);
  }
  throw gitDiffFailure(`git diff failed: ${run.error.message ?? String(run.error.code)}`, run.error);
}

// ─── Cache ──────────────────────────────────────────────────────────────────

/** Bookkeeping per cached answer besides its text. */
const ENTRY_OVERHEAD_BYTES = 256;

function bytesOf(value: GitFileDiff): number {
  return value.kind === 'text' ? Buffer.byteLength(value.diff, 'utf8') : 0;
}

/**
 * Answers by (worktree, path, kind, token, limit), least recently used out
 * first once the total exceeds the byte limit. Answers above the entry limit
 * are not kept.
 */
export class FileDiffCache {
  private readonly entries = new Map<string, { worktree: string; bytes: number; value: GitFileDiff }>();
  private total = 0;

  constructor(
    private readonly limitBytes: number = GIT_DIFF_CACHE_LIMIT_BYTES,
    private readonly entryLimitBytes: number = GIT_DIFF_CACHE_ENTRY_LIMIT_BYTES,
  ) {}

  get bytes(): number { return this.total; }
  get size(): number { return this.entries.size; }

  get(key: string): GitFileDiff | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** False when the answer is too large to keep. */
  set(key: string, worktree: string, value: GitFileDiff): boolean {
    const text = bytesOf(value);
    if (text > this.entryLimitBytes) return false;
    this.delete(key);
    const bytes = text + ENTRY_OVERHEAD_BYTES + key.length;
    this.entries.set(key, { worktree, bytes, value });
    this.total += bytes;
    for (const oldest of this.entries.keys()) {
      if (this.total <= this.limitBytes) break;
      this.delete(oldest);
    }
    return this.entries.has(key);
  }

  dropWorktree(worktree: string): void {
    for (const [key, entry] of this.entries) if (entry.worktree === worktree) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
  }
}
