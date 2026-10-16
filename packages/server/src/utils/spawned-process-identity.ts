import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createUnixProcessIdentityAdapter } from './unix-process-identity.js';

const execFileAsync = promisify(execFile);

export interface SpawnedProcessIdentity {
  processGroupId: string;
  birthMarker: string;
  ownershipToken: string;
}

export async function captureSpawnedProcessIdentity(
  pid: number,
  ownershipToken: string,
  platform: NodeJS.Platform = process.platform,
  isCurrent?: () => boolean,
): Promise<SpawnedProcessIdentity | null> {
  if (isCurrent && !isCurrent()) return null;
  if (platform !== 'win32') {
    const adapter = createUnixProcessIdentityAdapter(platform);
    // Only a caller holding the fresh child/PTY handle may use parentage as
    // launch evidence. ps can observe the spawn helper before exec exposes the
    // wrapper's environment, so requiring its marker here races startup.
    const identity = isCurrent
      ? await adapter.captureChildProcess!(pid, ownershipToken, isCurrent)
      : await adapter.captureProcess(pid, ownershipToken);
    return identity ? {
      processGroupId: String(identity.pgid),
      birthMarker: identity.birthIdentity,
      ownershipToken,
    } : null;
  }

  const script = [
    `Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
    'Select-Object -ExpandProperty CreationDate',
  ].join(' | ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], { encoding: 'utf8', windowsHide: true });
    const birthMarker = stdout.trim();
    return birthMarker && (!isCurrent || isCurrent()) ? {
      processGroupId: String(pid),
      birthMarker,
      ownershipToken,
    } : null;
  } catch {
    return null;
  }
}
