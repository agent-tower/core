/**
 * Parsers for the machine-readable git output the git state service uses.
 * All of them take `-z` output, so paths arrive unquoted.
 */

// ─── git status --porcelain=v2 -z --branch ──────────────────────────────────

/** Modes and object names of a tracked record; they make the file version tokens (./git-file-versions.ts). */
export interface StatusSides {
  /** `N...` for a file, `S<c><m><u>` for a submodule. */
  sub: string;
  /** Mode and object name in HEAD (`000000` and zeros when HEAD has no such path). */
  mH: string;
  hH: string;
  /** Mode and object name in the index. */
  mI: string;
  hI: string;
}

export type StatusEntry =
  /** `1 XY sub mH mI mW hH hI path` */
  | ({ kind: 'changed'; xy: string; path: string } & StatusSides)
  /** `2 XY sub mH mI mW hH hI Xscore path\0origPath`: `mH`/`hH` describe `origPath` in HEAD. */
  | ({ kind: 'renamed'; xy: string; path: string; origPath: string } & StatusSides)
  /** `u XY sub m1 m2 m3 mW h1 h2 h3 path`: stage 2 (ours) is HEAD's side. */
  | { kind: 'unmerged'; xy: string; path: string; sub: string; stages: string }
  | { kind: 'untracked'; path: string };

export interface ParsedStatus {
  /** `# branch.oid`: null before the first commit (`(initial)`). */
  headOid: string | null;
  /** `# branch.head`: null when HEAD is detached. */
  headBranch: string | null;
  entries: StatusEntry[];
}

/** Splits off the first `count` space-separated fields; the rest (a path may contain spaces) is returned last. */
function splitFields(record: string, count: number): string[] | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(' ', start);
    if (space < 0) return null;
    fields.push(record.slice(start, space));
    start = space + 1;
  }
  fields.push(record.slice(start));
  return fields;
}

/** `<kind> XY sub mH mI mW hH hI ...` */
function statusSides(fields: string[]): StatusSides {
  return { sub: fields[2]!, mH: fields[3]!, mI: fields[4]!, hH: fields[6]!, hI: fields[7]! };
}

export function parseStatusV2(output: string): ParsedStatus {
  const records = output.split('\0');
  const parsed: ParsedStatus = { headOid: null, headBranch: null, entries: [] };
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length === 0) continue;
    switch (record[0]) {
      case '#': {
        if (record.startsWith('# branch.oid ')) {
          const oid = record.slice('# branch.oid '.length);
          parsed.headOid = oid === '(initial)' ? null : oid;
        } else if (record.startsWith('# branch.head ')) {
          const head = record.slice('# branch.head '.length);
          parsed.headBranch = head === '(detached)' ? null : head;
        }
        break;
      }
      case '1': {
        const fields = splitFields(record, 8);
        if (fields) parsed.entries.push({ kind: 'changed', xy: fields[1]!, path: fields[8]!, ...statusSides(fields) });
        break;
      }
      case '2': {
        const fields = splitFields(record, 9);
        const origPath = records[++i];
        if (fields && origPath !== undefined) parsed.entries.push({ kind: 'renamed', xy: fields[1]!, path: fields[9]!, origPath, ...statusSides(fields) });
        break;
      }
      case 'u': {
        const fields = splitFields(record, 10);
        if (fields) parsed.entries.push({ kind: 'unmerged', xy: fields[1]!, path: fields[10]!, sub: fields[2]!, stages: fields.slice(3, 10).join(' ') });
        break;
      }
      case '?':
        if (record.startsWith('? ')) parsed.entries.push({ kind: 'untracked', path: record.slice(2) });
        break;
      default:
        // `!` (ignored) is not requested; unknown records are skipped.
        break;
    }
  }
  return parsed;
}

// ─── git diff --raw --numstat --stat -z ─────────────────────────────────────

export interface RawDiffEntry {
  /** As git prints it, with the similarity score of renames and copies (`R086`). */
  status: string;
  srcMode: string;
  dstMode: string;
  srcOid: string;
  dstOid: string;
  /** The new path (the destination of a rename or copy). */
  path: string;
  srcPath?: string;
}

export interface NumstatEntry {
  /** `null` for `-` (binary, or larger than `core.bigFileThreshold`). */
  additions: number | null;
  deletions: number | null;
  path: string;
  srcPath?: string;
  /**
   * Byte sizes of both sides from the matching `--stat` line, known for
   * binary entries only (`Bin <old> -> <new> bytes`).
   */
  binarySizes?: { old: number; new: number };
}

export interface ParsedDiff {
  raw: RawDiffEntry[];
  numstat: NumstatEntry[];
  /** True when every binary numstat entry could be matched with its `--stat` line. */
  sizesKnown: boolean;
}

const NUMSTAT_RECORD = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;
const BINARY_STAT_LINE = /\|\s+Bin(?: (\d+) -> (\d+) bytes)?$/;

/**
 * Parses `git diff --raw --numstat --stat -z --no-abbrev` output. Git prints
 * the raw records, then the numstat records (both NUL-terminated), then the
 * `--stat` lines (newline-terminated, no NUL), one per numstat record and in
 * the same order, followed by the summary line.
 */
export function parseDiffOutput(output: string): ParsedDiff {
  const tokens = output.split('\0');
  // Text after the last NUL: the --stat block.
  const statBlock = tokens.pop() ?? '';
  const raw: RawDiffEntry[] = [];
  const numstat: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length && tokens[i]!.startsWith(':')) {
    const header = tokens[i++]!.slice(1).split(' ');
    const status = header[4] ?? '';
    const twoPaths = status.startsWith('R') || status.startsWith('C');
    const srcPath = twoPaths ? tokens[i++] : undefined;
    const path = tokens[i++];
    if (path === undefined) break;
    raw.push({
      status, srcMode: header[0] ?? '', dstMode: header[1] ?? '', srcOid: header[2] ?? '', dstOid: header[3] ?? '',
      path, ...(srcPath !== undefined ? { srcPath } : {}),
    });
  }
  while (i < tokens.length) {
    const match = NUMSTAT_RECORD.exec(tokens[i++]!);
    if (!match) continue;
    let path = match[3]!;
    let srcPath: string | undefined;
    if (path === '') {
      srcPath = tokens[i++];
      path = tokens[i++] ?? '';
    }
    numstat.push({
      additions: match[1] === '-' ? null : Number(match[1]),
      deletions: match[2] === '-' ? null : Number(match[2]),
      path,
      ...(srcPath !== undefined ? { srcPath } : {}),
    });
  }

  const lines = statBlock.split('\n').filter((line) => line.length > 0);
  // One line per numstat record plus the summary line.
  let sizesKnown = numstat.length === 0 || lines.length === numstat.length + 1;
  if (sizesKnown && numstat.length > 0) {
    numstat.forEach((entry, index) => {
      if (entry.additions !== null && entry.deletions !== null) return;
      const match = BINARY_STAT_LINE.exec(lines[index]!);
      if (!match) {
        sizesKnown = false;
        return;
      }
      entry.binarySizes = { old: Number(match[1] ?? 0), new: Number(match[2] ?? 0) };
    });
  }
  return { raw, numstat, sizesKnown };
}

// ─── git rev-list --left-right --count A...B ───────────────────────────────

/** `<left>\t<right>`: commits only in A (behind) and only in B (ahead). */
export function parseLeftRightCount(output: string): { behind: number; ahead: number } {
  const parts = output.trim().split(/\s+/);
  return { behind: parseInt(parts[0] ?? '0', 10) || 0, ahead: parseInt(parts[1] ?? '0', 10) || 0 };
}

// ─── packed-refs ────────────────────────────────────────────────────────────

export interface PackedRef {
  oid: string;
  /** The commit an annotated tag points to (`^<oid>` line). */
  peeled?: string;
}

export interface PackedRefs {
  refs: Map<string, PackedRef>;
  /** The header promises a `^` line for every annotated tag (`peeled` or `fully-peeled`). */
  tagsPeeled: boolean;
}

export function parsePackedRefs(content: string): PackedRefs {
  const refs = new Map<string, PackedRef>();
  let tagsPeeled = false;
  let previous: PackedRef | undefined;
  for (const line of content.split('\n')) {
    if (line.startsWith('#')) {
      const traits = line.replace(/^# pack-refs with:/, '').trim().split(/\s+/);
      tagsPeeled = traits.includes('peeled') || traits.includes('fully-peeled');
      continue;
    }
    if (line.startsWith('^')) {
      if (previous) previous.peeled = line.slice(1).trim();
      continue;
    }
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    previous = { oid: line.slice(0, space) };
    refs.set(line.slice(space + 1).trim(), previous);
  }
  return { refs, tagsPeeled };
}
