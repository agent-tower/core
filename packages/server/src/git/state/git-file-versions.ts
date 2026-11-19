/**
 * Version tokens of changed files (design: docs/task-view-latency-redesign-
 * 2026-11-16.md, section 5.B.4). A token changes whenever the diff of its
 * file can change. Clients compare tokens only for equality: the web client
 * keys a file's diff query by it, and the git state service keys cached
 * diffs and reused line counts by it.
 *
 * - Committed entries (merge base to HEAD): the modes and blob ids of both
 *   sides, from `git diff --raw --no-abbrev`.
 * - Uncommitted entries (HEAD to the working tree): HEAD's side from `git
 *   status --porcelain=v2` (`mH`, `hH`) plus the working file's `lstat`
 *   (size, mtime and ctime in nanoseconds, inode). A file the diff shows as
 *   deleted gets a deletion marker instead of the stat data; an untracked
 *   file gets the stat data only.
 * - Racy files: a file modified within GIT_RACY_WINDOW_MS of the start of
 *   the state computation may change again without a visible stat change.
 *   Its token also carries the epoch and version of the state, so it changes
 *   with every new state until the file has settled, as git treats racily
 *   clean index entries.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { GIT_RACY_WINDOW_MS } from './git-state-limits.js';

/** `lstat` of a working file, with the fields that make its version. */
export interface WorkingFileStat {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  isDirectory: boolean;
}

/**
 * What an uncommitted entry's token and diff are made of, besides the
 * working file's `lstat`. Kept by the git state service next to the state it
 * belongs to; it never leaves the service.
 */
export interface UncommittedFileBasis {
  /**
   * `tracked`: HEAD against the working tree (`git diff HEAD -- <file>`).
   * `initial`: before the first commit, the index against the working tree,
   * as the change list compares then. `untracked`: the whole file as added.
   */
  kind: 'tracked' | 'initial' | 'untracked';
  /** Path relative to the top of the work tree: for `lstat` and the pathspec. */
  file: string;
  /** Path relative to the requested directory, as listed (untracked files are listed that way). */
  listed: string;
  /** The other side in the token: HEAD's mode and blob, a rename source, unmerged stages, or the index side before the first commit. */
  base: string;
  /**
   * The blob on the diff's old side (HEAD's; the index's before the first
   * commit), for the size probe of a working file above the limit. Null when
   * that side has no blob at `file`.
   */
  oldBlob: string | null;
  /** The diff shows a deletion whatever the working tree holds: removed from the index, or the source of a rename. */
  deleted: boolean;
  /** Treated as racy in every state: the stat data of submodules and conflicted files does not settle their diff. */
  volatile: boolean;
}

/** The state a token belongs to: the racy rule and racy tokens need it. */
export interface TokenState {
  epoch: string;
  version: number;
  /** Start of the computation that produced the state (ms since the Unix epoch). */
  computedAt: number;
}

const ZERO_OID = /^0+$/;

export function isNullOid(oid: string | undefined | null): boolean {
  return !oid || ZERO_OID.test(oid);
}

function digest(text: string): string {
  return createHash('sha1').update(text).digest('base64url').slice(0, 22);
}

/** `lstat` with nanosecond times; null when the path does not exist or cannot be read. */
export async function statWorkingFile(file: string): Promise<WorkingFileStat | null> {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    return { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, ino: stat.ino, isDirectory: stat.isDirectory() };
  } catch {
    return null;
  }
}

export function sameStat(a: WorkingFileStat | null, b: WorkingFileStat | null): boolean {
  if (!a || !b) return a === b;
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino;
}

/** Modified within the racy window before `at` (ms), or later. */
export function isRacyAt(stat: WorkingFileStat | null, at: number): boolean {
  return stat !== null && stat.mtimeNs >= BigInt(Math.floor(at - GIT_RACY_WINDOW_MS)) * 1_000_000n;
}

/** Everything but the state of a racy token: equal sources mean an equal diff for settled files. */
export function uncommittedSource(basis: UncommittedFileBasis, stat: WorkingFileStat | null): string {
  const working = basis.deleted || !stat
    ? 'deleted'
    : `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
  return `${basis.kind}|${basis.base}|${working}`;
}

export function isRacyFile(basis: UncommittedFileBasis, stat: WorkingFileStat | null, computedAt: number): boolean {
  return basis.volatile || (!basis.deleted && isRacyAt(stat, computedAt));
}

/**
 * Token of a racy entry before its state has a version. The git state
 * service compares contents with it, so an unchanged racy file does not by
 * itself make a new version, and then replaces it with `racyToken`.
 */
export function provisionalRacyToken(source: string): string {
  return digest(`${source}|racy`);
}

export function racyToken(source: string, state: Pick<TokenState, 'epoch' | 'version'>): string {
  return digest(`${source}|racy|${state.epoch}|${state.version}`);
}

export function settledToken(source: string): string {
  return digest(source);
}

/** The token of an uncommitted entry in `state`, for the working file's `stat` (taken now or during the computation). */
export function uncommittedToken(basis: UncommittedFileBasis, stat: WorkingFileStat | null, state: TokenState): string {
  const source = uncommittedSource(basis, stat);
  return isRacyFile(basis, stat, state.computedAt) ? racyToken(source, state) : settledToken(source);
}

/** Committed entries: both sides' modes and blob ids. */
export function committedToken(srcMode: string, srcOid: string, dstMode: string, dstOid: string): string {
  return digest(`committed|${srcMode}:${srcOid}|${dstMode}:${dstOid}`);
}

/** The answer for a path the state does not list: valid for this state only. */
export function unlistedToken(state: Pick<TokenState, 'epoch' | 'version'>, kind: string, file: string): string {
  return digest(`unlisted|${kind}|${file}|${state.epoch}|${state.version}`);
}
