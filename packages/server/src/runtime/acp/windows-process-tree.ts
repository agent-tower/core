import { execFileSync } from 'node:child_process';
import { AgentRuntimeError } from '../errors.js';

/**
 * Windows process-tree discovery shared by the ACP process manager, terminals
 * and owned commands. It lives apart from the ACP process manager so that
 * light processes (the command helper) can use it without loading the
 * executor and database modules that the manager depends on.
 */

export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  birthMarker: string;
}

export interface WindowsProcessTreeAdapter {
  captureProcess(pid: number): Promise<WindowsProcessIdentity | null>;
  captureDescendants(rootPid: number): Promise<WindowsProcessIdentity[]>;
  isProcessAlive(identity: WindowsProcessIdentity): Promise<boolean>;
  terminateTree(pid: number): Promise<void>;
}

export function createWindowsProcessTreeAdapter(runExecFileSync: typeof execFileSync = execFileSync): WindowsProcessTreeAdapter {
  const listProcesses = (): WindowsProcessIdentity[] => {
    const script = [
      'Get-CimInstance Win32_Process',
      'Select-Object ProcessId,ParentProcessId,CreationDate',
      'ConvertTo-Json -Compress',
    ].join(' | ');
    try {
      const output = runExecFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!output) throw new Error('Windows process enumeration returned empty output');
      const parsed = JSON.parse(output) as Record<string, unknown> | Array<Record<string, unknown>>;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      // CIM includes the System Idle Process (PID 0) without a creation date.
      // It cannot be our child and is not a malformed candidate identity.
      const identities = rows.filter((row) => row.ProcessId !== 0 && row.ProcessId !== '0').map((row): WindowsProcessIdentity | null => {
        const pid = Number(row.ProcessId);
        const parentPid = Number(row.ParentProcessId);
        const birthMarker = typeof row.CreationDate === 'string' ? row.CreationDate : '';
        return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0 && birthMarker
          ? { pid, parentPid, birthMarker }
          : null;
      });
      if (identities.length === 0 || identities.some((identity) => identity === null)) {
        throw new Error('Windows process enumeration returned malformed output');
      }
      return identities as WindowsProcessIdentity[];
    } catch (error) {
      throw processEnumerationFailed(error);
    }
  };

  return {
    async captureProcess(pid) {
      return listProcesses().find((processIdentity) => processIdentity.pid === pid) ?? null;
    },
    async captureDescendants(rootPid) {
      const rows = listProcesses();
      const descendantIds = new Set<number>([rootPid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (descendantIds.has(row.pid) || !descendantIds.has(row.parentPid)) continue;
          descendantIds.add(row.pid);
          changed = true;
        }
      }
      return rows.filter((row) => row.pid !== rootPid && descendantIds.has(row.pid));
    },
    async isProcessAlive(identity) {
      const current = listProcesses().find((row) => row.pid === identity.pid);
      return current?.birthMarker === identity.birthMarker;
    },
    async terminateTree(pid) {
      try {
        runExecFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // The identity is rechecked before signalling; a concurrent exit is harmless.
      }
    },
  };
}

function processEnumerationFailed(cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError(
    'process_identity_mismatch',
    'close',
    'ACP adapter process enumeration failed; ownership could not be verified safely',
    true,
    cause === undefined ? undefined : { cause },
  );
}
