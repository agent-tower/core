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
): Promise<SpawnedProcessIdentity | null> {
  if (platform !== 'win32') {
    const identity = await createUnixProcessIdentityAdapter(platform).captureProcess(pid, ownershipToken);
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
    return birthMarker ? {
      processGroupId: String(pid),
      birthMarker,
      ownershipToken,
    } : null;
  } catch {
    return null;
  }
}
