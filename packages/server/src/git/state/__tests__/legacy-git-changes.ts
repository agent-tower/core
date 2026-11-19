/**
 * Today's `GET /git/changes` computation, copied verbatim from routes/git.ts
 * as of 36f8017 (before the git state service), minus the database lookup:
 * the differential tests run it next to the new implementation on the same
 * fixtures. Test-only; do not use it in the application.
 */
import { runOwnedCommand } from '../../../utils/owned-child-process.js';

type ChangeEntry = { status: string; path: string; additions?: number; deletions?: number };

function execGit(cwd: string, args: string[]): Promise<string> {
  return runOwnedCommand('git', args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    }).then(({ stdout }) => stdout, (error) => {
      if (error.stdout) return String(error.stdout);
      throw error;
    });
}

async function isGitAvailable(workingDir: string): Promise<boolean> {
  try {
    const output = await execGit(workingDir, ['rev-parse', '--is-inside-work-tree']);
    if (output.trim() === 'true') return true;
  } catch {
    // Fall through to the structured API error below.
  }
  return false;
}

function getRemoteBranchRef(branch: string): string {
  return branch.startsWith('origin/') ? branch : `origin/${branch}`;
}

function parseNameStatus(output: string): ChangeEntry[] {
  if (!output.trim()) return [];
  return output
    .trim()
    .split('\n')
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 2) return null;
      const rawStatus = parts[0]!;
      const status = rawStatus.startsWith('R') ? 'R' : rawStatus;
      const filePath = parts.length >= 3 ? parts[2]! : parts[1]!;
      return { status, path: filePath };
    })
    .filter((entry): entry is ChangeEntry => entry !== null);
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  if (!output.trim()) return map;
  for (const line of output.trim().split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
    const deletions = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
    let filePath = parts.slice(2).join('\t');
    if (filePath.includes(' => ')) {
      filePath = filePath.includes('{')
        ? filePath.replace(/\{[^}]*? => ([^}]*?)\}/g, '$1').replace(/\/{2,}/g, '/')
        : filePath.split(' => ').pop()!;
    }
    map.set(filePath, { additions, deletions });
  }
  return map;
}

function attachNumstat(
  entries: ChangeEntry[],
  stats: Map<string, { additions: number; deletions: number }>,
): ChangeEntry[] {
  return entries.map((entry) => {
    const stat = stats.get(entry.path);
    return stat ? { ...entry, additions: stat.additions, deletions: stat.deletions } : entry;
  });
}

/** `null` stands for the 400 `GIT_UNAVAILABLE` answer. */
export async function legacyGitChanges(workingDir: string, baseBranch: string | null): Promise<{ uncommitted: ChangeEntry[]; committed: ChangeEntry[] } | null> {
  if (!await isGitAvailable(workingDir)) return null;

  let uncommitted: ChangeEntry[] = [];
  try {
    const output = await execGit(workingDir, ['diff', '--name-status', 'HEAD']);
    uncommitted = parseNameStatus(output);
    const numstat = await execGit(workingDir, ['diff', '--numstat', 'HEAD']).catch(() => '');
    uncommitted = attachNumstat(uncommitted, parseNumstat(numstat));
  } catch {
    try {
      const output = await execGit(workingDir, ['diff', '--name-status']);
      uncommitted = parseNameStatus(output);
      const numstat = await execGit(workingDir, ['diff', '--numstat']).catch(() => '');
      uncommitted = attachNumstat(uncommitted, parseNumstat(numstat));
    } catch {
      // ignore
    }
  }

  try {
    const untrackedOutput = await execGit(workingDir, ['ls-files', '--others', '--exclude-standard']);
    if (untrackedOutput.trim()) {
      for (const f of untrackedOutput.trim().split('\n')) uncommitted.push({ status: 'A', path: f });
    }
  } catch {
    // ignore
  }

  const committedBaseBranch = baseBranch || 'main';
  let committed: ChangeEntry[] = [];
  try {
    const output = await execGit(workingDir, ['diff', '--name-status', `${committedBaseBranch}...HEAD`]);
    committed = parseNameStatus(output);
    const numstat = await execGit(workingDir, ['diff', '--numstat', `${committedBaseBranch}...HEAD`]).catch(() => '');
    committed = attachNumstat(committed, parseNumstat(numstat));
  } catch {
    try {
      const remoteRef = getRemoteBranchRef(committedBaseBranch);
      const output = await execGit(workingDir, ['diff', '--name-status', `${remoteRef}...HEAD`]);
      committed = parseNameStatus(output);
      const numstat = await execGit(workingDir, ['diff', '--numstat', `${remoteRef}...HEAD`]).catch(() => '');
      committed = attachNumstat(committed, parseNumstat(numstat));
    } catch {
      // ignore — no base branch to compare against
    }
  }

  return { uncommitted, committed };
}
