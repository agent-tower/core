import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const packageRoot = path.resolve(__dirname, '..');
export const releaseDir = path.join(packageRoot, 'release');
const productName = 'Agent Tower';
const macAppName = `${productName}.app`;
const cleanupOptions = {
  recursive: true,
  force: true,
  maxRetries: process.platform === 'win32' ? 20 : 3,
  retryDelay: 250,
};

export function findPackagedAppExecutable() {
  if (process.platform === 'darwin') {
    for (const outputDir of ['mac-arm64', 'mac']) {
      const executable = path.join(releaseDir, outputDir, macAppName, 'Contents/MacOS', productName);
      if (existsSync(executable)) return executable;
    }

    for (const outputDir of ['mac-arm64', 'mac']) {
      const executable = path.join(releaseDir, outputDir, 'Agent Tower Desktop Spike.app/Contents/MacOS/Agent Tower Desktop Spike');
      if (existsSync(executable)) return executable;
    }
  }

  if (process.platform === 'win32') {
    const executable = path.join(releaseDir, 'win-unpacked', `${productName}.exe`);
    if (existsSync(executable)) return executable;

    const legacyExecutable = path.join(releaseDir, 'win-unpacked', 'Agent Tower Desktop Spike.exe');
    if (existsSync(legacyExecutable)) return legacyExecutable;
  }

  const linuxExecutable = path.join(releaseDir, 'linux-unpacked', 'agent-tower');
  if (existsSync(linuxExecutable)) return linuxExecutable;

  const legacyLinuxExecutable = path.join(releaseDir, 'linux-unpacked', 'agent-tower-desktop-spike');
  if (existsSync(legacyLinuxExecutable)) return legacyLinuxExecutable;

  throw new Error(`Could not find packaged app executable in ${releaseDir}. Run pnpm --filter @agent-tower/desktop package:dir first.`);
}

export function createIsolatedDesktopTestEnv({
  prefix = 'agent-tower-desktop-test',
  extraEnv = {},
} = {}) {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  const tempUserData = mkdtempSync(path.join(os.tmpdir(), `${prefix}-user-data-`));
  const dataDir = path.join(tempUserData, 'data');

  const env = {
    ...process.env,
    ...extraEnv,
    AGENT_TOWER_DESKTOP_USER_DATA_DIR: tempUserData,
    AGENT_TOWER_DESKTOP_DATA_MODE: 'isolated',
    AGENT_TOWER_DATA_DIR: dataDir,
    HOME: tempHome,
    USERPROFILE: tempHome,
    PATH: process.env.PATH || '',
  };

  return {
    env,
    tempHome,
    tempUserData,
    dataDir,
    cleanup() {
      rmSync(tempHome, cleanupOptions);
      rmSync(tempUserData, cleanupOptions);
    },
  };
}
