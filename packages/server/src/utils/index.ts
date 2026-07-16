import pkg from '@prisma/client';
import { execFile, type ExecOptions } from 'child_process';
import { promisify } from 'util';
import { normalizeCommandLookupOutput, withWindowsUserPathFallbacks } from './process-launch.js';
const { PrismaClient } = pkg;
const execFileAsync = promisify(execFile);

export const prisma = new PrismaClient();

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

let databaseRuntimeInitialization: Promise<void> | null = null;

/**
 * Configure SQLite before HTTP traffic starts. WAL is persisted in the database file;
 * busy_timeout protects the active Prisma connection from failing immediately on a writer lock.
 */
export function initializeDatabaseRuntime(): Promise<void> {
  if (databaseRuntimeInitialization) {
    return databaseRuntimeInitialization;
  }

  databaseRuntimeInitialization = (async () => {
    await prisma.$queryRawUnsafe(`PRAGMA journal_mode = WAL`);
    await prisma.$queryRawUnsafe(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  })().catch((error) => {
    databaseRuntimeInitialization = null;
    throw error;
  });

  return databaseRuntimeInitialization;
}

export async function execAsync(
  command: string,
  options?: ExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execPromise = promisify(exec);
  const { stdout, stderr } = await execPromise(command, options);
  return { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
}

/**
 * 查找可执行文件路径
 * 类似于 Unix 的 which 命令
 */
export async function which(
  command: string,
  options: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<string | null> {
  try {
    const platform = options.platform ?? process.platform;
    const lookupCommand = platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(lookupCommand, [command], {
      encoding: 'utf-8',
      windowsHide: true,
      env: platform === 'win32'
        ? withWindowsUserPathFallbacks(options.env ?? process.env)
        : options.env ?? process.env,
    });
    return normalizeCommandLookupOutput(String(stdout ?? ''), platform);
  } catch {
    return null;
  }
}
