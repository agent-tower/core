import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

export const PROCESS_IDENTITY_ENV = 'AGENT_TOWER_PROCESS_IDENTITY';
export const PTY_WRAPPER_IDENTITY_SEED_ENV = 'AGENT_TOWER_PTY_IDENTITY_SEED';

interface UnixProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  birthMarker: string;
  ownershipToken?: string | null;
}

export interface UnixProcessIdentity {
  pid: number;
  pgid: number;
  birthIdentity: string;
  ownershipToken: string;
}

export interface UnixProcessGroupIdentity {
  pgid: number;
  members: UnixProcessIdentity[];
}

export interface UnixProcessIdentityAdapter {
  captureProcess(pid: number, ownershipToken: string): Promise<UnixProcessIdentity | null>;
  captureDescendantGroups(root: UnixProcessIdentity): Promise<UnixProcessGroupIdentity[]>;
  /**
   * Capture all processes carrying an ownership token, including descendants
   * that were re-parented after the launch root exited.
   */
  captureOwnedGroups?(
    ownershipToken: string,
    processGroupId?: number,
  ): Promise<UnixProcessGroupIdentity[]>;
  isProcessAlive(identity: UnixProcessIdentity): Promise<boolean>;
  isProcessGroupAlive(identity: UnixProcessGroupIdentity): Promise<boolean>;
  signalProcess(identity: UnixProcessIdentity, signal: NodeJS.Signals): Promise<boolean>;
  signalProcessGroup(identity: UnixProcessGroupIdentity, signal: NodeJS.Signals): Promise<boolean>;
}

export interface UnixProcessIdentityAdapterDependencies {
  execFile?: typeof execFile;
  readFile?: typeof readFile;
  readdir?: typeof readdir;
}

export function unixProcessIdentityMatches(
  expected: UnixProcessIdentity,
  current: UnixProcessIdentity | null,
): boolean {
  return current !== null
    && current.pid === expected.pid
    && current.pgid === expected.pgid
    && current.birthIdentity === expected.birthIdentity
    && current.ownershipToken === expected.ownershipToken;
}

export function createUnixProcessIdentityAdapter(
  platform: NodeJS.Platform = process.platform,
  dependencies: UnixProcessIdentityAdapterDependencies = {},
): UnixProcessIdentityAdapter {
  return new DefaultUnixProcessIdentityAdapter(platform, {
    execFile: dependencies.execFile ?? execFile,
    readFile: dependencies.readFile ?? readFile,
    readdir: dependencies.readdir ?? readdir,
  });
}

class DefaultUnixProcessIdentityAdapter implements UnixProcessIdentityAdapter {
  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly dependencies: Required<UnixProcessIdentityAdapterDependencies>,
  ) {}

  async captureProcess(pid: number, ownershipToken: string): Promise<UnixProcessIdentity | null> {
    const row = (await this.listProcesses()).find((candidate) => candidate.pid === pid);
    if (!row) return null;
    const currentToken = await this.readOwnershipToken(pid);
    if (currentToken !== ownershipToken) return null;
    return {
      pid: row.pid,
      pgid: row.pgid,
      birthIdentity: `${row.birthMarker}:${ownershipToken}`,
      ownershipToken,
    };
  }

  async captureDescendantGroups(root: UnixProcessIdentity): Promise<UnixProcessGroupIdentity[]> {
    if (!await this.isProcessAlive(root)) return [];
    const rows = await this.listProcesses();
    const descendants = new Set<number>([root.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue;
        descendants.add(row.pid);
        changed = true;
      }
    }

    const candidates = rows.filter((row) => row.pid !== root.pid && descendants.has(row.pid));
    const identities = (await Promise.all(candidates.map((row) => (
      this.captureProcess(row.pid, root.ownershipToken)
    )))).filter((identity): identity is UnixProcessIdentity => identity !== null);
    const groups = new Map<number, UnixProcessIdentity[]>();
    for (const identity of identities) {
      const members = groups.get(identity.pgid) ?? [];
      members.push(identity);
      groups.set(identity.pgid, members);
    }
    return [...groups].map(([pgid, members]) => ({ pgid, members }));
  }

  async captureOwnedGroups(
    ownershipToken: string,
    processGroupId?: number,
  ): Promise<UnixProcessGroupIdentity[]> {
    const rows = await this.listProcessesWithOwnership();
    const owned = rows
      .filter((row) => (processGroupId === undefined || row.pgid === processGroupId)
        && row.ownershipToken === ownershipToken)
      .map((row): UnixProcessIdentity => ({
        pid: row.pid,
        pgid: row.pgid,
        birthIdentity: `${row.birthMarker}:${ownershipToken}`,
        ownershipToken,
      }));
    const groups = new Map<number, UnixProcessIdentity[]>();
    for (const identity of owned) {
      const members = groups.get(identity.pgid) ?? [];
      members.push(identity);
      groups.set(identity.pgid, members);
    }
    return [...groups].map(([pgid, members]) => ({ pgid, members }));
  }

  async isProcessAlive(identity: UnixProcessIdentity): Promise<boolean> {
    return unixProcessIdentityMatches(
      identity,
      await this.captureProcess(identity.pid, identity.ownershipToken),
    );
  }

  async isProcessGroupAlive(identity: UnixProcessGroupIdentity): Promise<boolean> {
    for (const member of identity.members) {
      if (await this.isProcessAlive(member) && member.pgid === identity.pgid) return true;
    }
    return false;
  }

  async signalProcess(identity: UnixProcessIdentity, signal: NodeJS.Signals): Promise<boolean> {
    if (!await this.isProcessAlive(identity)) return false;
    try {
      process.kill(identity.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  async signalProcessGroup(identity: UnixProcessGroupIdentity, signal: NodeJS.Signals): Promise<boolean> {
    if (!await this.isProcessGroupAlive(identity)) return false;
    try {
      process.kill(-identity.pgid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async listProcesses(): Promise<UnixProcessRow[]> {
    if (this.platform === 'linux') return this.listLinuxProcesses();
    return this.listPsProcesses();
  }

  private async listProcessesWithOwnership(): Promise<UnixProcessRow[]> {
    if (this.platform === 'linux') {
      const rows = await this.listLinuxProcesses();
      const withOwnership = await Promise.all(rows.map(async (row) => ({
        ...row,
        ownershipToken: await this.readOwnershipToken(row.pid),
      })));
      return withOwnership;
    }

    const output = await execFileText(
      this.dependencies.execFile,
      'ps',
      ['eww', '-axo', 'pid=,ppid=,pgid=,lstart=,command='],
    );
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error('Unix process enumeration returned empty output');
    }
    const rows = lines.map((line): UnixProcessRow | null => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const pgid = Number(match[3]);
      return pid > 0 && Number.isFinite(ppid) && pgid > 0
        ? {
            pid,
            ppid,
            pgid,
            birthMarker: `${this.platform}:${match[4]}`,
            ownershipToken: extractOwnershipToken(match[5]),
          }
        : null;
    });
    if (rows.length === 0 || rows.some((row) => row === null)) {
      throw new Error('Unix process enumeration returned malformed output');
    }
    return rows as UnixProcessRow[];
  }

  private async listLinuxProcesses(): Promise<UnixProcessRow[]> {
    let entries;
    try {
      entries = await this.dependencies.readdir('/proc', { withFileTypes: true });
    } catch (error) {
      throw new Error('Unix process enumeration failed', { cause: error });
    }
    if (entries.length === 0) {
      throw new Error('Unix process enumeration returned empty output');
    }
    const rows = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry): Promise<UnixProcessRow | null> => {
        const pid = Number(entry.name);
        let stat: string;
        try {
          stat = await this.dependencies.readFile(`/proc/${pid}/stat`, 'utf8');
        } catch (error) {
          if (isProcessDisappearanceError(error)) return null;
          throw new Error(`Unix process identity probe failed for pid ${pid}`, { cause: error });
        }
        const closeParen = stat.lastIndexOf(')');
        if (closeParen < 0) return null;
        const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        const startTicks = fields[19];
        return Number.isFinite(ppid) && pgid > 0 && startTicks
          ? { pid, ppid, pgid, birthMarker: `linux:${startTicks}` }
          : null;
      }));
    const validRows = rows.filter((row): row is UnixProcessRow => row !== null);
    if (validRows.length === 0) {
      throw new Error('Unix process enumeration returned malformed output');
    }
    return validRows;
  }

  private async listPsProcesses(): Promise<UnixProcessRow[]> {
    const output = await execFileText(this.dependencies.execFile, 'ps', ['-axo', 'pid=,ppid=,pgid=,lstart=']);
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error('Unix process enumeration returned empty output');
    }
    const rows = lines.map((line): UnixProcessRow | null => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const pgid = Number(match[3]);
      const startedAt = match[4];
      return pid > 0 && Number.isFinite(ppid) && pgid > 0 && startedAt
        ? { pid, ppid, pgid, birthMarker: `${this.platform}:${startedAt}` }
        : null;
    });
    if (rows.length === 0 || rows.some((row) => row === null)) {
      throw new Error('Unix process enumeration returned malformed output');
    }
    return rows as UnixProcessRow[];
  }

  private async readOwnershipToken(pid: number): Promise<string | null> {
    if (this.platform === 'linux') {
      let environ: Buffer;
      try {
        environ = await this.dependencies.readFile(`/proc/${pid}/environ`);
      } catch (error) {
        if (isProcessDisappearanceError(error)) return null;
        throw new Error(`Unix process environment probe failed for pid ${pid}`, { cause: error });
      }
      return extractOwnershipToken(environ.toString('utf8').replaceAll('\0', ' '));
    }
    let commandWithEnvironment: string;
    try {
      commandWithEnvironment = await execFileText(this.dependencies.execFile, 'ps', [
        'eww',
        '-p',
        String(pid),
        '-o',
        'command=',
      ]);
    } catch (error) {
      // ps reports a non-zero exit when the process disappears between the
      // process-list snapshot and its environment probe. Re-enumeration is the
      // proof that distinguishes that race from permission/command failures.
      const stillPresent = (await this.listPsProcesses()).some((row) => row.pid === pid);
      if (!stillPresent) return null;
      throw error;
    }
    return extractOwnershipToken(commandWithEnvironment);
  }
}

function extractOwnershipToken(value: string): string | null {
  for (const key of [PROCESS_IDENTITY_ENV, PTY_WRAPPER_IDENTITY_SEED_ENV]) {
    const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(value);
    if (match?.[1]) return match[1];
  }
  return null;
}

function execFileText(
  runExecFile: typeof execFile,
  command: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    runExecFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      // `ps lstart` is parsed as a machine-readable identity. Locale-specific
      // day/month names or date layouts would make a valid snapshot look
      // malformed and leave cleanup permanently unresolved.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`Unix process enumeration failed: ${command}`, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}

function isProcessDisappearanceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
}
