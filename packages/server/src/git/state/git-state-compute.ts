/**
 * One computation of a worktree's git state (design: docs/task-view-latency-
 * redesign-2026-11-16.md, section 5.B.2). It reproduces what `GET
 * /git/changes` and `GET /workspaces/:id/git-status` computed with 14 git
 * processes, with these:
 *
 * - `git status --porcelain=v2 -z --branch --untracked-files=all` (always);
 * - one `git diff --raw --numstat --stat -z HEAD -- <changed files>` when a
 *   tracked file is uncommitted: the statuses and counts of today's `git diff
 *   --name-status HEAD` and `git diff --numstat HEAD`;
 * - one `git diff --raw --numstat --stat -z <base>...<head>` and one `git
 *   rev-list --left-right --count <base>...<head>`, each cached by the commit
 *   pair, so they run again only when HEAD or the base branch moved.
 *
 * Rebase and merge state, the git directory and branch commits are read from
 * files. Every command runs with `GIT_OPTIONAL_LOCKS=0`. Line counts never run
 * on a file above the size limit: such working files are left out of the
 * diff, and `core.bigFileThreshold` makes git report larger blobs as binary
 * without reading them; the `--stat` sizes then tell binary from too large.
 *
 * Every entry carries a version token (./git-file-versions.ts). A status
 * record whose tokens are the same as in the previous computation keeps its
 * entries and line counts; only records whose tokens changed (or that are
 * racy) go to the uncommitted diff, so an idle worktree with uncommitted
 * changes costs `git status` alone.
 */
import path from 'node:path';
import type { OwnedCommandOptions } from '../../utils/owned-child-process.js';
import {
  GIT_DIFF_SIZE_LIMIT_BYTES,
  GIT_DIFF_TIMEOUT_MS,
  GIT_OUTPUT_LIMIT_BYTES,
  GIT_PROBE_TIMEOUT_MS,
  GIT_REV_LIST_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS,
} from './git-state-limits.js';
import {
  parseDiffOutput, parseLeftRightCount, parseStatusV2,
  type ParsedDiff, type ParsedStatus, type RawDiffEntry, type StatusEntry,
} from './git-state-parsers.js';
import type { GitChangeEntry, GitStateContent, GitStateRequest } from './git-state-types.js';
import {
  committedToken, isNullOid, isRacyFile, provisionalRacyToken, settledToken, statWorkingFile, uncommittedSource,
  type UncommittedFileBasis, type WorkingFileStat,
} from './git-file-versions.js';
import {
  detectOperation,
  discoverRepository,
  fingerprintRepository,
  isPlainRefName,
  readHeadTarget,
  readLocalBranch,
  readRef,
  resolveRevisionName,
  type RefLookup,
  type RepositoryLayout,
} from './git-repository-files.js';

export type GitCommandRunner = (command: string, args: string[], options: OwnedCommandOptions) => Promise<{ stdout: string; stderr: string }>;

/** Small LRU map for results keyed by commit pairs. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Both sides of one committed entry, for its diff's size probe. */
export interface CommittedBlobs {
  srcOid: string;
  dstOid: string;
}

export type ComparisonValue =
  | { kind: 'changes'; entries: GitChangeEntry[]; blobs: Map<string, CommittedBlobs> }
  | { kind: 'counts'; ahead: number; behind: number }
  | { kind: 'failed' };

/** Entries and line counts of one settled status record, kept for the next computation. */
export interface ReusableRecord {
  /** The token sources of the record's paths: equal sources mean equal entries. */
  sources: string;
  entries: GitChangeEntry[];
}

/**
 * Per-path data of one state. The git state service keeps it next to the
 * state for that state's file diffs, and hands it to the next computation for
 * line-count reuse. It never leaves the service.
 */
export interface GitStateFiles {
  /** Top of the work tree; null when the layout is unknown (paths then resolve against the requested directory). */
  topLevel: string | null;
  /** Tracked paths of the uncommitted list and rename sources, by path from the top of the work tree. */
  tracked: Map<string, UncommittedFileBasis>;
  /** Listed untracked files, by listed path. */
  untracked: Map<string, UncommittedFileBasis>;
  /** The comparison the committed list shows, and both sides' blobs of its entries. */
  committed: { base: string; head: string; blobs: Map<string, CommittedBlobs> } | null;
  records: Map<string, ReusableRecord>;
}

export interface ComputeGitStateOptions {
  request: GitStateRequest;
  run: GitCommandRunner;
  signal: AbortSignal;
  /** No command starts after this time (ms since the Unix epoch); running ones get only what is left. */
  deadline: number;
  comparisons: LruCache<string, ComparisonValue>;
  /** Called before each git process starts. */
  onGitProcess?: () => void;
  now?: () => number;
  /** Start of the computation: the reference time of the racy rule. Default: now. */
  startedAt?: number;
  /** The previous computation's files of the same worktree: settled records with unchanged tokens keep their entries. */
  previous?: GitStateFiles | null;
}

export interface RepositoryFingerprint {
  layout: RepositoryLayout;
  refs: string[];
  value: string;
}

export interface ComputeGitStateOutcome {
  /** Racy entries of `uncommitted` carry a provisional token; the service replaces it once the state has its version. */
  content: GitStateContent;
  /** Identity of the git files before the computation read anything; null when the layout is unknown. */
  fingerprint: RepositoryFingerprint | null;
  gitProcesses: number;
  files: GitStateFiles;
  /** Racy entries: their index in `content.uncommitted` and their token source. */
  racy: Array<{ index: number; source: string }>;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Longest pathspec passed on the command line (Windows limits a command line to 32,767 characters). */
const PATHSPEC_CHARACTER_BUDGET = process.platform === 'win32' ? 24_000 : 512_000;
const STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind'];
const DIFF_ARGS = [
  '-c', `core.bigFileThreshold=${GIT_DIFF_SIZE_LIMIT_BYTES}`,
  'diff', '--raw', '--numstat', '--stat=300,200', '-z', '--no-abbrev', '--no-color',
];

type GitRun = { ok: true; stdout: string } | { ok: false; error: { code?: unknown; message?: string } };

interface Context {
  options: ComputeGitStateOptions;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The diffs parse `--stat` text, so they run in the C locale. */
  diffEnv: NodeJS.ProcessEnv;
  now: () => number;
  startedAt: number;
  processes: number;
  degraded: string[];
  resolvedCommits: Map<string, Promise<string | null>>;
}

/** One uncommitted path's version, as this computation saw it. */
interface PathVersion {
  basis: UncommittedFileBasis;
  stat: WorkingFileStat | null;
  source: string;
  racy: boolean;
}

function tokenOf(version: PathVersion): string {
  return version.racy ? provisionalRacyToken(version.source) : settledToken(version.source);
}

export function gitStateAbortError(): Error {
  return Object.assign(new Error('The git state computation was cancelled'), { code: 'ABORT_ERR' });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw gitStateAbortError();
}

async function git(ctx: Context, args: string[], options: { timeout: number; cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number }): Promise<GitRun> {
  throwIfAborted(ctx.options.signal);
  const remaining = ctx.options.deadline - ctx.now();
  if (remaining <= 0) return { ok: false, error: { code: 'ETIMEDOUT', message: 'git state computation budget exhausted' } };
  ctx.processes += 1;
  ctx.options.onGitProcess?.();
  try {
    const { stdout } = await ctx.options.run('git', args, {
      cwd: options.cwd ?? ctx.cwd,
      env: options.env ?? ctx.env,
      timeout: Math.min(options.timeout, remaining),
      maxBuffer: options.maxBuffer ?? GIT_OUTPUT_LIMIT_BYTES,
      signal: ctx.options.signal,
    });
    return { ok: true, stdout };
  } catch (error) {
    if (ctx.options.signal.aborted || (error as { code?: unknown } | undefined)?.code === 'ABORT_ERR') throw gitStateAbortError();
    return { ok: false, error: (error ?? {}) as { code?: unknown; message?: string } };
  }
}

/** Failures that the same commits would reproduce (git's own errors, an oversized output); timeouts are not. */
function isDeterministicFailure(error: { code?: unknown }): boolean {
  return typeof error.code === 'number' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** Git orders paths by their bytes. */
export function compareGitPaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Inserts `extra` (sorted) into `ordered` (git's diff order), keeping both orders. */
function mergeByPath(ordered: GitChangeEntry[], extra: GitChangeEntry[]): GitChangeEntry[] {
  if (extra.length === 0) return ordered;
  const merged: GitChangeEntry[] = [];
  let j = 0;
  for (const entry of ordered) {
    while (j < extra.length && compareGitPaths(extra[j]!.path, entry.path) < 0) merged.push(extra[j++]!);
    merged.push(entry);
  }
  while (j < extra.length) merged.push(extra[j++]!);
  return merged;
}

/** Root-relative pathspecs without wildcards. Null when even the short form does not fit on a command line. */
function buildPathspec(include: string[], exclude: string[]): string[] | null {
  const length = (items: string[]) => items.reduce((sum, item) => sum + item.length + 1, 0);
  const explicit = include.map((file) => `:(top,literal)${file}`);
  if (length(explicit) <= PATHSPEC_CHARACTER_BUDGET) return explicit;
  const everythingBut = [':(top)', ...exclude.map((file) => `:(top,literal,exclude)${file}`)];
  return length(everythingBut) <= PATHSPEC_CHARACTER_BUDGET ? everythingBut : null;
}

/** The part of the work tree that `workingDir` names, as `git ls-files` prefixes it ('' at the top). */
function workTreePrefix(layout: RepositoryLayout | null, cwd: string): string {
  if (!layout) return '';
  const relative = path.relative(layout.topLevel, path.resolve(cwd));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.split(path.sep).join('/');
}

// ─── Change lists ───────────────────────────────────────────────────────────

/**
 * Today's `parseNameStatus` + `attachNumstat` over one `--raw --numstat
 * --stat -z` output: a rename keeps the status `R` and the new path, and the
 * counts attach by path (the last numstat record wins). A binary file keeps
 * 0/0; a file above the size limit gets no counts. `token` versions each
 * entry.
 */
export function toChangeEntries(diff: ParsedDiff, token: (raw: RawDiffEntry) => string): GitChangeEntry[] {
  const counts = new Map<string, ParsedDiff['numstat'][number]>();
  for (const entry of diff.numstat) counts.set(entry.path, entry);
  return diff.raw.map((raw) => {
    const entry: GitChangeEntry = { status: raw.status.startsWith('R') ? 'R' : raw.status, path: raw.path, token: token(raw) };
    const stat = counts.get(raw.path);
    if (!stat) return entry;
    if (stat.additions !== null && stat.deletions !== null) return { ...entry, additions: stat.additions, deletions: stat.deletions };
    const sizes = diff.sizesKnown ? stat.binarySizes : undefined;
    if (sizes && Math.max(sizes.old, sizes.new) > GIT_DIFF_SIZE_LIMIT_BYTES) return entry;
    return { ...entry, additions: 0, deletions: 0 };
  });
}

/**
 * The entry today's `git diff --name-status HEAD` printed for a status record,
 * for files that are left out of the diff (above the size limit) or when the
 * diff failed. Without HEAD, today's fallback compared the index with the
 * working tree, so only unstaged changes count.
 */
function entryFromStatus(entry: StatusEntry, initial: boolean, token: (path: string) => string): GitChangeEntry | null {
  if (entry.kind === 'untracked') return null;
  const x = entry.xy[0];
  const y = entry.xy[1];
  const at = (status: string, file: string): GitChangeEntry => ({ status, path: file, token: token(file) });
  if (initial) {
    if (entry.kind === 'unmerged') return at('U', entry.path);
    return y && y !== '.' ? at(y, entry.path) : null;
  }
  switch (entry.kind) {
    case 'unmerged':
      // `git diff HEAD` shows a conflicted file as modified.
      return at('M', entry.path);
    case 'renamed':
      if (y === 'D') return x === 'R' ? at('D', entry.origPath) : null;
      return at(x === 'R' ? 'R' : 'A', entry.path);
    case 'changed':
      if (x === 'A') return y === 'D' ? null : at('A', entry.path);
      if (x === 'D' || y === 'D') return at('D', entry.path);
      if (x === 'T' || y === 'T') return at('T', entry.path);
      if (y === 'A') return at('A', entry.path);
      return at('M', entry.path);
  }
}

function pathsOf(entry: StatusEntry): string[] {
  return entry.kind === 'renamed' ? [entry.path, entry.origPath] : [entry.path];
}

/**
 * The versions behind one tracked status record's entries. HEAD's side comes
 * from the record (`mH`, `hH`; stage 2 of a conflict); before the first
 * commit the change list compares the index instead, so its side counts.
 */
function basesOf(entry: Exclude<StatusEntry, { kind: 'untracked' }>, initial: boolean): UncommittedFileBasis[] {
  const volatile = entry.kind === 'unmerged' || entry.sub.startsWith('S');
  const at = (file: string, rest: Pick<UncommittedFileBasis, 'base' | 'oldBlob' | 'deleted'>): UncommittedFileBasis => ({
    kind: initial ? 'initial' : 'tracked', file, listed: file, volatile, ...rest,
  });
  if (entry.kind === 'unmerged') {
    // `m1 m2 m3 mW h1 h2 h3`: stage 2 ("ours") is HEAD's side.
    const ours = entry.stages.split(' ')[5];
    return [at(entry.path, { base: `unmerged:${entry.stages}`, oldBlob: isNullOid(ours) ? null : ours!, deleted: false })];
  }
  if (initial) return [at(entry.path, { base: `${entry.mI}:${entry.hI}`, oldBlob: isNullOid(entry.hI) ? null : entry.hI, deleted: false })];
  const head = `${entry.mH}:${entry.hH}`;
  const headBlob = isNullOid(entry.hH) ? null : entry.hH;
  if (entry.kind === 'renamed') {
    // `git diff HEAD -- <path>` shows the new path as added; its line counts
    // compare against the source, so the source's blob is part of its version.
    return [
      at(entry.path, { base: `rename:${entry.origPath}:${head}`, oldBlob: null, deleted: false }),
      at(entry.origPath, { base: head, oldBlob: headBlob, deleted: true }),
    ];
  }
  return [at(entry.path, { base: head, oldBlob: headBlob, deleted: entry.xy[0] === 'D' })];
}

async function versionOf(basis: UncommittedFileBasis, root: string, startedAt: number): Promise<PathVersion> {
  const stat = await statWorkingFile(path.join(root, basis.file));
  return { basis, stat, source: uncommittedSource(basis, stat), racy: isRacyFile(basis, stat, startedAt) };
}

interface TrackedRecord {
  key: string;
  entry: Exclude<StatusEntry, { kind: 'untracked' }>;
  versions: PathVersion[];
  sources: string;
  racy: boolean;
  large: boolean;
}

interface TrackedChanges {
  entries: GitChangeEntry[];
  versions: Map<string, PathVersion>;
  records: Map<string, ReusableRecord>;
}

async function computeTrackedChanges(ctx: Context, layout: RepositoryLayout | null, status: ParsedStatus, tracked: StatusEntry[]): Promise<TrackedChanges> {
  const versions = new Map<string, PathVersion>();
  const records = new Map<string, ReusableRecord>();
  if (tracked.length === 0) return { entries: [], versions, records };
  const initial = status.headOid === null;
  const root = layout?.topLevel ?? ctx.cwd;
  // Taken after `git status`, before the diff: a change in between moves the
  // token, so the next computation counts the file again.
  const all = await Promise.all(tracked.map(async (entry): Promise<TrackedRecord> => {
    const record = entry as TrackedRecord['entry'];
    const recordVersions = await Promise.all(basesOf(record, initial).map((basis) => versionOf(basis, root, ctx.startedAt)));
    const first = recordVersions[0]!.stat;
    return {
      key: `${record.kind}\0${pathsOf(record).join('\0')}`,
      entry: record,
      versions: recordVersions,
      sources: recordVersions.map((version) => version.source).join('\n'),
      racy: recordVersions.some((version) => version.racy),
      // A working file above the limit stays out of the diff: git would compare
      // it line by line, or with core.bigFileThreshold hash it through deflate.
      large: first !== null && !first.isDirectory && first.size > BigInt(GIT_DIFF_SIZE_LIMIT_BYTES),
    };
  }));
  for (const record of all) for (const version of record.versions) versions.set(version.basis.file, version);
  const token = (file: string): string => {
    const version = versions.get(file);
    // Not expected: git listed a path that status did not. Never reuse it.
    return version ? tokenOf(version) : provisionalRacyToken(`unknown|${file}`);
  };

  const reused: GitChangeEntry[] = [];
  const large: TrackedRecord[] = [];
  const diffed: TrackedRecord[] = [];
  for (const record of all) {
    const previous = record.racy ? undefined : ctx.options.previous?.records.get(record.key);
    if (previous && previous.sources === record.sources) {
      reused.push(...previous.entries);
      records.set(record.key, previous);
    } else if (record.large) large.push(record);
    else diffed.push(record);
  }
  const byPath = (a: GitChangeEntry, b: GitChangeEntry) => compareGitPaths(a.path, b.path);
  const fromStatus = (entries: TrackedRecord[]) => entries
    .map((record) => entryFromStatus(record.entry, initial, token))
    .filter((entry): entry is GitChangeEntry => entry !== null)
    .sort(byPath);

  let fromDiff: GitChangeEntry[] | null = [];
  if (diffed.length > 0) {
    const include = diffed.flatMap((record) => pathsOf(record.entry));
    const exclude = [...large, ...all.filter((record) => records.has(record.key))].flatMap((record) => pathsOf(record.entry));
    const pathspec = buildPathspec(include, exclude);
    const run = pathspec
      ? await git(ctx, [...DIFF_ARGS, ...(initial ? [] : ['HEAD']), '--', ...pathspec], { timeout: GIT_DIFF_TIMEOUT_MS, env: ctx.diffEnv })
      : null;
    if (run?.ok) {
      fromDiff = toChangeEntries(parseDiffOutput(run.stdout), (raw) => token(raw.path));
      rememberSettledRecords(diffed, fromDiff, records);
    } else {
      fromDiff = null;
      ctx.degraded.push('uncommitted-counts');
    }
  }
  const settled = reused.sort(byPath);
  const entries = fromDiff === null
    ? mergeByPath(fromStatus([...diffed, ...large]), settled)
    : mergeByPath(mergeByPath(fromDiff, settled), fromStatus(large));
  return { entries, versions, records };
}

/** Keeps the entries of each settled diffed record for the next computation (a record may list none: added, then deleted). */
function rememberSettledRecords(diffed: TrackedRecord[], entries: GitChangeEntry[], records: Map<string, ReusableRecord>): void {
  const owner = new Map<string, TrackedRecord>();
  for (const record of diffed) for (const file of pathsOf(record.entry)) owner.set(file, record);
  const listed = new Map<TrackedRecord, GitChangeEntry[]>(diffed.map((record) => [record, []]));
  for (const entry of entries) {
    const record = owner.get(entry.path);
    if (record) listed.get(record)!.push(entry);
  }
  for (const [record, recordEntries] of listed) {
    if (!record.racy) records.set(record.key, { sources: record.sources, entries: recordEntries });
  }
}

/** A commit for a revision name: from the ref files, or from git when the files do not settle it. */
function resolveCommit(ctx: Context, layout: RepositoryLayout | null, name: string): Promise<string | null> {
  let pending = ctx.resolvedCommits.get(name);
  if (!pending) {
    pending = (async () => {
      // Today's `git diff <name>...HEAD` would read a leading dash as an option and fail.
      if (!name || name.startsWith('-')) return null;
      const lookup: RefLookup = layout ? await resolveRevisionName(layout, name).catch((): RefLookup => ({ kind: 'unknown' })) : { kind: 'unknown' };
      if (lookup.kind === 'found') return lookup.oid;
      if (lookup.kind === 'missing') return null;
      const run = await git(ctx, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { timeout: GIT_PROBE_TIMEOUT_MS });
      const oid = run.ok ? run.stdout.trim() : '';
      return OBJECT_ID.test(oid) ? oid : null;
    })();
    ctx.resolvedCommits.set(name, pending);
  }
  return pending;
}

async function localBranchExists(ctx: Context, layout: RepositoryLayout | null, branch: string): Promise<boolean> {
  const lookup: RefLookup = layout ? await readLocalBranch(layout, branch).catch((): RefLookup => ({ kind: 'unknown' })) : { kind: 'unknown' };
  if (lookup.kind !== 'unknown') return lookup.kind === 'found';
  if (!branch || branch.startsWith('-')) return false;
  const run = await git(ctx, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { timeout: GIT_PROBE_TIMEOUT_MS });
  return run.ok;
}

interface CommittedChanges {
  entries: GitChangeEntry[];
  /** The comparison the entries come from; null when there are none for lack of a base. */
  range: GitStateFiles['committed'];
}

/** Today: `<base>...HEAD`, and when that fails `origin/<base>...HEAD`; nothing when both fail. */
async function computeCommitted(ctx: Context, layout: RepositoryLayout | null, headOid: string | null, baseBranch: string): Promise<CommittedChanges> {
  const none: CommittedChanges = { entries: [], range: null };
  if (!headOid) return none;
  const remote = baseBranch.startsWith('origin/') ? baseBranch : `origin/${baseBranch}`;
  const names = remote === baseBranch ? [baseBranch] : [baseBranch, remote];
  for (const name of names) {
    const base = await resolveCommit(ctx, layout, name);
    if (!base) continue;
    const key = `committed:${base}:${headOid}`;
    let value = ctx.options.comparisons.get(key);
    if (!value) {
      const run = await git(ctx, [...DIFF_ARGS, `${base}...${headOid}`], { timeout: GIT_DIFF_TIMEOUT_MS, env: ctx.diffEnv });
      if (run.ok) {
        const parsed = parseDiffOutput(run.stdout);
        const blobs = new Map<string, CommittedBlobs>(parsed.raw.map((raw) => [raw.path, { srcOid: raw.srcOid, dstOid: raw.dstOid }]));
        const entries = toChangeEntries(parsed, (raw) => committedToken(raw.srcMode, raw.srcOid, raw.dstMode, raw.dstOid));
        value = { kind: 'changes', entries, blobs };
      } else value = { kind: 'failed' };
      if (run.ok || isDeterministicFailure(run.error)) ctx.options.comparisons.set(key, value);
      else ctx.degraded.push('committed');
    }
    if (value.kind === 'changes') return { entries: value.entries, range: { base, head: headOid, blobs: value.blobs } };
  }
  return none;
}

/**
 * Today (`getBranchStatus`): only for a HEAD on an existing local branch and an
 * existing local base branch, otherwise 0/0.
 */
async function computeAheadBehind(ctx: Context, layout: RepositoryLayout | null, head: { oid: string | null; branch: string | null }, request: GitStateRequest): Promise<{ ahead: number; behind: number }> {
  const none = { ahead: 0, behind: 0 };
  if (!head.oid || !head.branch) return none;
  if (!await localBranchExists(ctx, layout, request.baseBranch)) return none;
  const base = await resolveCommit(ctx, layout, request.baseBranch);
  if (!base) return none;
  const key = `ahead-behind:${base}:${head.oid}`;
  let value = ctx.options.comparisons.get(key);
  if (!value) {
    const run = await git(ctx, ['rev-list', '--left-right', '--count', `${base}...${head.oid}`], {
      timeout: GIT_REV_LIST_TIMEOUT_MS,
      cwd: request.repositoryPath || ctx.cwd,
    });
    value = run.ok ? { kind: 'counts', ...parseLeftRightCount(run.stdout) } : { kind: 'failed' };
    if (run.ok || isDeterministicFailure(run.error)) ctx.options.comparisons.set(key, value);
    else ctx.degraded.push('ahead-behind');
  }
  return value.kind === 'counts' ? { ahead: value.ahead, behind: value.behind } : none;
}

// ─── The computation ────────────────────────────────────────────────────────

function emptyContent(request: GitStateRequest, cwd: string, available: boolean): GitStateContent {
  return {
    worktreePath: cwd,
    baseBranch: request.baseBranch,
    available,
    operation: 'idle',
    head: { oid: null, branch: null },
    uncommitted: [],
    committed: [],
    uncommittedCount: 0,
    untrackedCount: 0,
    unmergedPaths: [],
    ahead: 0,
    behind: 0,
    degraded: [],
  };
}

/** HEAD from the files, for when `git status` failed. */
async function readHead(layout: RepositoryLayout | null): Promise<{ oid: string | null; branch: string | null } | null> {
  if (!layout) return null;
  const head = await readRef(layout, 'HEAD').catch((): RefLookup => ({ kind: 'unknown' }));
  if (head.kind !== 'found') return null;
  const target = await readHeadTarget(layout);
  return { oid: head.oid, branch: target?.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : null };
}

/** The refs whose files change when HEAD's branch or the base moves (for the fingerprint). */
async function fingerprintRefs(layout: RepositoryLayout, baseBranch: string): Promise<string[]> {
  const refs: string[] = [];
  const target = await readHeadTarget(layout);
  if (target) refs.push(target);
  if (isPlainRefName(baseBranch)) {
    refs.push(`refs/heads/${baseBranch}`);
    refs.push(baseBranch.startsWith('origin/') ? `refs/remotes/${baseBranch}` : `refs/remotes/origin/${baseBranch}`);
  }
  return refs;
}

export async function computeGitState(options: ComputeGitStateOptions): Promise<ComputeGitStateOutcome> {
  const { request } = options;
  const cwd = request.worktreePath;
  const baseEnv: NodeJS.ProcessEnv = request.env ?? process.env;
  const ctx: Context = {
    options,
    cwd,
    env: { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' },
    diffEnv: { ...baseEnv, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    now: options.now ?? Date.now,
    startedAt: options.startedAt ?? (options.now ?? Date.now)(),
    processes: 0,
    degraded: [],
    resolvedCommits: new Map(),
  };
  let layout: RepositoryLayout | null = null;
  const finish = (
    content: GitStateContent,
    fingerprint: RepositoryFingerprint | null,
    parts: {
      versions?: Map<string, PathVersion>; untracked?: Map<string, PathVersion>; committed?: CommittedChanges;
      records?: Map<string, ReusableRecord>; racy?: ComputeGitStateOutcome['racy'];
    } = {},
  ): ComputeGitStateOutcome => ({
    content: { ...content, degraded: [...new Set(ctx.degraded)].sort() },
    fingerprint,
    gitProcesses: ctx.processes,
    files: {
      topLevel: layout?.topLevel ?? null,
      tracked: new Map([...(parts.versions ?? [])].map(([file, version]) => [file, version.basis])),
      untracked: new Map([...(parts.untracked ?? [])].map(([file, version]) => [file, version.basis])),
      committed: parts.committed?.range ?? null,
      records: parts.records ?? new Map(),
    },
    racy: parts.racy ?? [],
  });

  layout = await discoverRepository(cwd).catch(() => null);
  throwIfAborted(options.signal);
  let fingerprint: RepositoryFingerprint | null = null;
  if (layout && !layout.reftable) {
    // Taken before git reads anything: a later change makes the next request recompute.
    const refs = await fingerprintRefs(layout, request.baseBranch);
    fingerprint = { layout, refs, value: await fingerprintRepository(layout, refs) };
  }
  const operation = layout ? detectOperation(layout).catch(() => 'idle' as const) : Promise.resolve('idle' as const);

  let status = await git(ctx, [...STATUS_ARGS, '--untracked-files=all'], { timeout: GIT_STATUS_TIMEOUT_MS });
  let untrackedListed = true;
  if (!status.ok && status.error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    // Too many untracked files to list one by one. Today's `ls-files` failed
    // the same way (no untracked entries) and `status --porcelain` counted
    // collapsed folders; do both.
    untrackedListed = false;
    ctx.degraded.push('untracked-files');
    status = await git(ctx, [...STATUS_ARGS, '--untracked-files=normal'], { timeout: GIT_STATUS_TIMEOUT_MS });
  }

  if (!status.ok) {
    const probe = await git(ctx, ['rev-parse', '--is-inside-work-tree'], { timeout: GIT_PROBE_TIMEOUT_MS });
    if (!probe.ok || probe.stdout.trim() !== 'true') return finish(emptyContent(request, cwd, false), fingerprint);
    // Inside a work tree, but status itself failed: today's code kept going
    // with empty uncommitted data; so does this.
    ctx.degraded.push('status');
    const head = await readHead(layout);
    const [committed, aheadBehind] = head
      ? await Promise.all([computeCommitted(ctx, layout, head.oid, request.baseBranch), computeAheadBehind(ctx, layout, head, request)])
      : [{ entries: [], range: null }, { ahead: 0, behind: 0 }];
    return finish({
      ...emptyContent(request, cwd, true),
      operation: await operation,
      head: head ?? { oid: null, branch: null },
      committed: committed.entries,
      ...aheadBehind,
    }, fingerprint, { committed });
  }

  const parsed = parseStatusV2(status.stdout);
  const tracked = parsed.entries.filter((entry) => entry.kind !== 'untracked');
  const untracked = parsed.entries.filter((entry) => entry.kind === 'untracked').map((entry) => entry.path);
  const head = { oid: parsed.headOid, branch: parsed.headBranch };
  const [trackedChanges, committed, aheadBehind] = await Promise.all([
    computeTrackedChanges(ctx, layout, parsed, tracked),
    computeCommitted(ctx, layout, head.oid, request.baseBranch),
    computeAheadBehind(ctx, layout, head, request),
  ]);

  // Today's `git ls-files --others` ran in `workingDir`: only files below it, relative to it.
  const prefix = workTreePrefix(layout, cwd);
  const listedUntracked = !untrackedListed ? [] : prefix
    ? untracked.filter((file) => file.startsWith(`${prefix}/`)).map((file) => ({ file, listed: file.slice(prefix.length + 1) }))
    : untracked.map((file) => ({ file, listed: file }));
  const root = layout?.topLevel ?? cwd;
  const untrackedVersions = new Map<string, PathVersion>(await Promise.all(listedUntracked.map(async ({ file, listed }) => [
    listed,
    await versionOf({ kind: 'untracked', file, listed, base: '', oldBlob: null, deleted: false, volatile: false }, root, ctx.startedAt),
  ] as const)));
  // Racy entries get their final token once the state has a version (the service does that).
  const racy: ComputeGitStateOutcome['racy'] = [];
  trackedChanges.entries.forEach((entry, index) => {
    const version = trackedChanges.versions.get(entry.path);
    if (!version) racy.push({ index, source: `unknown|${entry.path}` });
    else if (version.racy) racy.push({ index, source: version.source });
  });
  listedUntracked.forEach(({ listed }, offset) => {
    const version = untrackedVersions.get(listed)!;
    if (version.racy) racy.push({ index: trackedChanges.entries.length + offset, source: version.source });
  });

  return finish({
    worktreePath: cwd,
    baseBranch: request.baseBranch,
    available: true,
    operation: await operation,
    head,
    uncommitted: [
      ...trackedChanges.entries,
      ...listedUntracked.map(({ listed }) => ({ status: 'A', path: listed, token: tokenOf(untrackedVersions.get(listed)!) })),
    ],
    committed: committed.entries,
    uncommittedCount: tracked.length,
    untrackedCount: untracked.length,
    unmergedPaths: tracked.filter((entry) => entry.kind === 'unmerged').map((entry) => entry.path),
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    degraded: [],
  }, fingerprint, { versions: trackedChanges.versions, untracked: untrackedVersions, committed, records: trackedChanges.records, racy });
}
