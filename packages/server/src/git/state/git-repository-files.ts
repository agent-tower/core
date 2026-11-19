/**
 * Reads the files of a git repository that the git state service needs, so
 * that these answers cost no git process: where the git directory is, which
 * operation is in progress, and which commit a branch points to.
 *
 * Anything unusual (reftable refs, a tag that shadows a branch, a name with
 * revision syntax) is reported as `unknown`, and the caller asks git instead.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitOperation } from './git-state-types.js';
import { parsePackedRefs, type PackedRefs } from './git-state-parsers.js';

export interface RepositoryLayout {
  /** Top of the work tree: the directory that holds `.git`. */
  topLevel: string;
  /** The work tree's own git directory: HEAD, index, MERGE_HEAD, rebase state. */
  gitDir: string;
  /** The repository's shared git directory: refs and packed-refs. */
  commonDir: string;
  /** Refs live in a reftable, which this module does not read. */
  reftable: boolean;
}

export type RefLookup =
  | { kind: 'found'; oid: string }
  | { kind: 'missing' }
  | { kind: 'unknown' };

const MISSING: RefLookup = { kind: 'missing' };
const UNKNOWN: RefLookup = { kind: 'unknown' };
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the git directory the way git discovers it from `startPath`: the
 * nearest ancestor with a `.git` directory that has a HEAD, or a `.git` file
 * (`gitdir: <path>`, a linked worktree). Null when there is none.
 */
export async function discoverRepository(startPath: string): Promise<RepositoryLayout | null> {
  let directory = path.resolve(startPath);
  for (;;) {
    const candidate = path.join(directory, '.git');
    let gitDir: string | null = null;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        if (await exists(path.join(candidate, 'HEAD'))) gitDir = candidate;
      } else if (stat.isFile()) {
        const content = await readText(candidate);
        const match = /^gitdir: (.+)$/m.exec(content ?? '');
        // A `.git` file that points nowhere ends the search, as it does for git.
        if (!match) return null;
        gitDir = path.resolve(directory, match[1]!.trim());
      }
    } catch {
      // No `.git` here: keep walking up.
    }
    if (gitDir) {
      const commonDirFile = await readText(path.join(gitDir, 'commondir')).catch(() => null);
      const commonDir = commonDirFile ? path.resolve(gitDir, commonDirFile.trim()) : gitDir;
      return { topLevel: directory, gitDir, commonDir, reftable: await exists(path.join(commonDir, 'reftable')) };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Same checks as rebase/merge detection in `WorktreeManager`, without processes. */
export async function detectOperation(layout: RepositoryLayout): Promise<GitOperation> {
  const [rebaseMerge, rebaseApply, mergeHead] = await Promise.all([
    exists(path.join(layout.gitDir, 'rebase-merge')),
    exists(path.join(layout.gitDir, 'rebase-apply')),
    exists(path.join(layout.gitDir, 'MERGE_HEAD')),
  ]);
  if (rebaseMerge || rebaseApply) return 'rebase';
  return mergeHead ? 'merge' : 'idle';
}

/**
 * Names that are safe to look up as files: valid ref names without revision
 * syntax (`check-ref-format` rules, one-level names allowed).
 */
export function isPlainRefName(name: string): boolean {
  if (!name || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name === '@' || name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split('/').every((component) => component.length > 0 && !component.startsWith('.') && !component.endsWith('.lock'));
}

/** Refs that belong to one work tree and live in its own git directory. */
function isPerWorktreeRef(ref: string): boolean {
  return /^[A-Z_]+$/.test(ref) || ref.startsWith('refs/bisect/') || ref.startsWith('refs/worktree/') || ref.startsWith('refs/rewritten/');
}

const packedRefsCache = new Map<string, { key: string; refs: PackedRefs }>();

async function readPackedRefs(commonDir: string): Promise<PackedRefs | null> {
  const file = path.join(commonDir, 'packed-refs');
  let key: string;
  try {
    const stat = await fs.stat(file);
    key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { refs: new Map(), tagsPeeled: true };
    return null;
  }
  const cached = packedRefsCache.get(commonDir);
  if (cached?.key === key) return cached.refs;
  const content = await readText(file).catch(() => null);
  if (content === null) return null;
  const refs = parsePackedRefs(content);
  packedRefsCache.set(commonDir, { key, refs });
  // A handful of repositories at most; keep the cache from growing without bound.
  if (packedRefsCache.size > 64) packedRefsCache.delete(packedRefsCache.keys().next().value!);
  return refs;
}

/**
 * Reads one full ref name (loose file first, then packed-refs, as git's files
 * backend does), following symbolic refs. Tags resolve to the commit they
 * point to only when packed-refs records it.
 */
export async function readRef(layout: RepositoryLayout, ref: string, depth = 0): Promise<RefLookup> {
  if (layout.reftable || depth > 5) return UNKNOWN;
  const directory = isPerWorktreeRef(ref) ? layout.gitDir : layout.commonDir;
  let content: string | null;
  try {
    content = await readText(path.join(directory, ...ref.split('/')));
  } catch {
    return UNKNOWN;
  }
  if (content !== null) {
    const value = content.trim();
    if (value.startsWith('ref: ')) return readRef(layout, value.slice('ref: '.length).trim(), depth + 1);
    if (!OBJECT_ID.test(value)) return UNKNOWN;
    // A loose tag may be an annotated tag object; only git can peel it.
    return ref.startsWith('refs/tags/') ? UNKNOWN : { kind: 'found', oid: value };
  }
  const packed = await readPackedRefs(layout.commonDir);
  if (!packed) return UNKNOWN;
  const entry = packed.refs.get(ref);
  if (!entry) return MISSING;
  if (!OBJECT_ID.test(entry.oid)) return UNKNOWN;
  if (ref.startsWith('refs/tags/')) {
    if (entry.peeled && OBJECT_ID.test(entry.peeled)) return { kind: 'found', oid: entry.peeled };
    return packed.tagsPeeled ? { kind: 'found', oid: entry.oid } : UNKNOWN;
  }
  return { kind: 'found', oid: entry.oid };
}

/**
 * Resolves a revision name the way git does for `<name>...HEAD`: the first of
 * `<name>`, `refs/<name>`, `refs/tags/<name>`, `refs/heads/<name>`,
 * `refs/remotes/<name>`, `refs/remotes/<name>/HEAD` that exists.
 */
export async function resolveRevisionName(layout: RepositoryLayout, name: string): Promise<RefLookup> {
  if (!isPlainRefName(name)) return UNKNOWN;
  const candidates = [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`];
  for (const candidate of candidates) {
    const lookup = await readRef(layout, candidate);
    if (lookup.kind !== 'missing') return lookup;
  }
  return MISSING;
}

/** The ref HEAD points to (`refs/heads/main`), or null for a detached or unreadable HEAD. */
export async function readHeadTarget(layout: RepositoryLayout): Promise<string | null> {
  const content = await readText(path.join(layout.gitDir, 'HEAD')).catch(() => null);
  const match = /^ref: (refs\/\S.*)$/m.exec(content ?? '');
  return match ? match[1]!.trim() : null;
}

/** Whether `refs/heads/<branch>` exists. */
export async function readLocalBranch(layout: RepositoryLayout, branch: string): Promise<RefLookup> {
  if (!isPlainRefName(branch)) return UNKNOWN;
  return readRef(layout, `refs/heads/${branch}`);
}

/**
 * Size of a working file (as git sees it: `lstat`), or null when it does not
 * exist. `relativePath` is relative to the top of the work tree.
 */
export async function workingFileSize(layout: RepositoryLayout | null, cwd: string, relativePath: string): Promise<number | null> {
  try {
    const stat = await fs.lstat(path.join(layout?.topLevel ?? cwd, relativePath));
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Identity of the git files that change when HEAD, the index or the given
 * refs change: Tower's own git operations (commit, merge, rebase, reset,
 * checkout) all rewrite at least one of them. Stat calls only.
 */
export async function fingerprintRepository(layout: RepositoryLayout, refs: string[]): Promise<string> {
  const files = [
    path.join(layout.gitDir, 'HEAD'),
    path.join(layout.gitDir, 'index'),
    path.join(layout.commonDir, 'packed-refs'),
    ...refs.filter((ref) => !isPerWorktreeRef(ref)).map((ref) => path.join(layout.commonDir, ...ref.split('/'))),
  ];
  const parts = await Promise.all(files.map(async (file) => {
    try {
      const stat = await fs.stat(file);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return '-';
    }
  }));
  return parts.join('|');
}
