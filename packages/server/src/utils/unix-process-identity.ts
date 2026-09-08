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
  ownershipError?: unknown;
  state?: string;
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
  /**
   * Establish identity from a direct child owned by this process, including
   * native executables whose environment is hidden by macOS. The caller must
   * retain the actual child/PTY handle and supply its launch-liveness check.
   * The check is repeated after asynchronous probes, before caching ownership.
   */
  captureChildProcess?(pid: number, ownershipToken: string, isCurrent: () => boolean): Promise<UnixProcessIdentity | null>;
  /** Discard observed ownership only after the complete tree is confirmed gone. */
  releaseOwnership?(ownershipToken: string): void;
  captureDescendantGroups(root: UnixProcessIdentity): Promise<UnixProcessGroupIdentity[]>;
  /**
   * Capture all processes carrying an ownership token, including descendants
   * that were re-parented after the launch root exited. The default adapter
   * also tracks markerless descendants observed through verified ancestry or
   * process-group membership; retain the same adapter for later verification.
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
  // An inherited environment marker is a discovery aid, not a requirement on
  // every executable in an owned tree. Keep ancestry established from a live,
  // verified root so launchers that sanitize env remain owned after root exit.
  private readonly ancestry = new Map<string, Map<number, UnixProcessIdentity>>();
  private readonly directChildren = new Map<number, UnixProcessIdentity>();
  private readonly launchStartTicks = new Map<string, bigint>();

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly dependencies: Required<UnixProcessIdentityAdapterDependencies>,
  ) {}

  async captureProcess(pid: number, ownershipToken: string): Promise<UnixProcessIdentity | null> {
    const row = (await this.listProcesses()).find((candidate) => candidate.pid === pid);
    if (!row) return null;
    if (row.state === 'Z' || row.state === 'X') return null;
    const observed = this.ancestry.get(ownershipToken)?.get(pid);
    if (observed?.birthIdentity === `${row.birthMarker}:${ownershipToken}`) {
      return { ...observed, pgid: row.pgid };
    }
    const currentToken = await this.readOwnershipToken(pid);
    if (currentToken !== ownershipToken) return null;
    const identity = {
      pid: row.pid,
      pgid: row.pgid,
      birthIdentity: `${row.birthMarker}:${ownershipToken}`,
      ownershipToken,
    };
    this.rememberIdentity(row, identity);
    return identity;
  }

  async captureChildProcess(pid: number, ownershipToken: string, isCurrent: () => boolean): Promise<UnixProcessIdentity | null> {
    if (!isCurrent()) return null;
    const row = (await this.listProcesses()).find((candidate) => candidate.pid === pid);
    if (!isCurrent() || !row || row.ppid !== process.pid || isExitedRow(row)) return null;
    const identity = {
      pid,
      pgid: row.pgid,
      birthIdentity: `${row.birthMarker}:${ownershipToken}`,
      ownershipToken,
    };
    const previous = this.directChildren.get(pid);
    // A retry may re-observe the same launch, but cannot bind an existing
    // owner to a new child that happens to reuse the PID.
    if (previous && !unixProcessIdentityMatches(previous, identity)) return null;
    this.directChildren.set(pid, identity);
    this.rememberIdentity(row, identity);
    return identity;
  }

  private rememberIdentity(row: UnixProcessRow, identity: UnixProcessIdentity): void {
    const observed = this.ancestry.get(identity.ownershipToken) ?? new Map<number, UnixProcessIdentity>();
    observed.set(row.pid, identity);
    this.ancestry.set(identity.ownershipToken, observed);
    this.rememberLaunchStart(row, identity.ownershipToken);
  }

  private rememberLaunchStart(row: UnixProcessRow, ownershipToken: string): void {
    // Only an actual server child establishes a launch lower bound. An owned
    // grandchild discovered after root exit can be younger than an escaped
    // sibling, so its birth must never exclude that sibling from recovery.
    const ticks = linuxStartTicks(row);
    if (row.ppid !== process.pid || ticks === undefined) return;
    const current = this.launchStartTicks.get(ownershipToken);
    if (current === undefined || ticks < current) this.launchStartTicks.set(ownershipToken, ticks);
  }

  releaseOwnership(ownershipToken: string): void {
    this.ancestry.delete(ownershipToken);
    this.launchStartTicks.delete(ownershipToken);
    for (const [pid, identity] of this.directChildren) {
      if (identity.ownershipToken === ownershipToken) this.directChildren.delete(pid);
    }
  }

  async captureDescendantGroups(root: UnixProcessIdentity): Promise<UnixProcessGroupIdentity[]> {
    if (!await this.isProcessAlive(root)) return [];
    const rows = await this.listProcesses();
    const currentRoot = rows.find((row) => row.pid === root.pid
      && row.pgid === root.pgid
      && `${row.birthMarker}:${root.ownershipToken}` === root.birthIdentity);
    if (!currentRoot) return [];
    return this.captureRelatedGroups(rows, [currentRoot], root.ownershipToken)
      .map((group) => ({ ...group, members: group.members.filter((member) => member.pid !== root.pid) }))
      .filter((group) => group.members.length > 0);
  }

  async captureOwnedGroups(
    ownershipToken: string,
    processGroupId?: number,
  ): Promise<UnixProcessGroupIdentity[]> {
    const rows = await this.listProcessesWithOwnership();
    const observed = this.ancestry.get(ownershipToken);
    const seeds = rows.filter((row) => (processGroupId === undefined || row.pgid === processGroupId)
      && (row.ownershipToken === ownershipToken
        || observed?.get(row.pid)?.birthIdentity === `${row.birthMarker}:${ownershipToken}`));
    for (const row of seeds) {
      if (row.ownershipToken === ownershipToken) this.rememberLaunchStart(row, ownershipToken);
    }
    this.assertOwnershipProbes(rows, seeds, ownershipToken);
    return this.captureRelatedGroups(rows, seeds, ownershipToken);
  }

  private assertOwnershipProbes(rows: UnixProcessRow[], seeds: UnixProcessRow[], ownershipToken: string): void {
    const related = collectRelatedPids(rows, seeds);
    const startTicks = this.launchStartTicks.get(ownershipToken);
    for (const row of rows) {
      if (!row.ownershipError) continue;
      const code = processErrorCode(row.ownershipError);
      const ticks = linuxStartTicks(row);
      // Permission denial is harmless only for a process proven to predate
      // this launch and unrelated to every verified member. Unknown peers
      // born at/after launch may be escaped children and remain unresolved.
      if ((code === 'EACCES' || code === 'EPERM') && !related.has(row.pid)
        && startTicks !== undefined && ticks !== undefined && ticks < startTicks) continue;
      throw row.ownershipError;
    }
  }

  private captureRelatedGroups(
    rows: UnixProcessRow[],
    seeds: UnixProcessRow[],
    ownershipToken: string,
  ): UnixProcessGroupIdentity[] {
    const ownedPids = collectRelatedPids(rows, seeds);
    const observed = this.ancestry.get(ownershipToken) ?? new Map<number, UnixProcessIdentity>();
    this.ancestry.set(ownershipToken, observed);
    for (const [pid, identity] of observed) {
      if (!rows.some((row) => row.pid === pid && `${row.birthMarker}:${ownershipToken}` === identity.birthIdentity)) {
        observed.delete(pid);
      }
    }
    const owned = rows.filter((row) => ownedPids.has(row.pid)).map((row): UnixProcessIdentity => {
      const identity = {
        pid: row.pid,
        pgid: row.pgid,
        birthIdentity: `${row.birthMarker}:${ownershipToken}`,
        ownershipToken,
      };
      observed.set(row.pid, identity);
      return identity;
    });
    const groups = new Map<number, UnixProcessIdentity[]>();
    for (const identity of owned) {
      if (isExitedRow(rows.find((row) => row.pid === identity.pid)!)) continue;
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
      const withOwnership = await Promise.all(rows.map(async (row) => {
        // Keep the row for verified ancestry expansion, but zombies/dead
        // tasks have no live execution or readable environ to discover.
        if (isExitedRow(row)) return { ...row, ownershipToken: null };
        if (!await this.isLinuxOwnershipCandidate(row.pid)) return { ...row, ownershipToken: null };
        try {
          return { ...row, ownershipToken: await this.readOwnershipToken(row.pid) };
        } catch (error) {
          return { ...row, ownershipToken: null, ownershipError: error };
        }
      }));
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

  private async isLinuxOwnershipCandidate(pid: number): Promise<boolean> {
    const uid = process.getuid?.();
    if (uid === undefined) return true;
    let status: string;
    try {
      status = await this.dependencies.readFile(`/proc/${pid}/status`, 'utf8');
    } catch (error) {
      if (isProcessDisappearanceError(error)) return false;
      throw new Error(`Unix process owner probe failed for pid ${pid}`, { cause: error });
    }
    const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
    if (!match) throw new Error(`Unix process owner probe returned malformed output for pid ${pid}`);
    return match.slice(1).some((value) => Number(value) === uid);
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
        const state = fields[0];
        const ppid = Number(fields[1]);
        const pgid = Number(fields[2]);
        const startTicks = fields[19];
        return Number.isFinite(ppid) && pgid > 0 && startTicks
          ? { pid, ppid, pgid, state, birthMarker: `linux:${startTicks}` }
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

function isExitedRow(row: UnixProcessRow): boolean {
  return row.state === 'Z' || row.state === 'X';
}

function linuxStartTicks(row: UnixProcessRow): bigint | undefined {
  const match = /^linux:(\d+)$/.exec(row.birthMarker);
  return match ? BigInt(match[1]!) : undefined;
}

function collectRelatedPids(rows: UnixProcessRow[], seeds: UnixProcessRow[]): Set<number> {
  const pids = new Set(seeds.map((row) => row.pid));
  const groups = new Set(seeds.map((row) => row.pgid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (pids.has(row.pid) || (!pids.has(row.ppid) && !groups.has(row.pgid))) continue;
      pids.add(row.pid);
      groups.add(row.pgid);
      changed = true;
    }
  }
  return pids;
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

function processErrorCode(error: unknown): string | undefined {
  let current: any = error;
  for (let i = 0; i < 3 && current; i += 1) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return undefined;
}
