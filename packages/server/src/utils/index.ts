import pkg from '@prisma/client';
import { execFile, type ExecOptions } from 'child_process';
import { promisify } from 'util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  normalizeCommandLookupOutput,
  withUnixUserPathFallbacks,
  withWindowsUserPathFallbacks,
} from './process-launch.js';
const { PrismaClient } = pkg;
const execFileAsync = promisify(execFile);

export const prisma = new PrismaClient();

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

let databaseRuntimeInitialization: Promise<void> | null = null;

function isSqliteLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  // Prisma wraps SQLite errors in P2010; preserve all other initialization
  // failures instead of treating arbitrary query errors as startup contention.
  return ['5', '6'].includes(String(failure.meta?.code))
    || /SQLITE_BUSY|SQLITE_LOCKED|database (?:is |table is )?locked/i.test(String(failure.message))
    || ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String(failure.code));
}

/**
 * Configure SQLite before HTTP traffic starts. WAL is persisted in the database file;
 * busy_timeout protects the active Prisma connection from failing immediately on a writer lock.
 */
export function initializeDatabaseRuntime(): Promise<void> {
  if (databaseRuntimeInitialization) {
    return databaseRuntimeInitialization;
  }

  databaseRuntimeInitialization = (async () => {
    await prisma.$queryRawUnsafe(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    // Another CLI can still be synchronizing the same database. Changing its
    // journal mode can return SQLITE_BUSY without invoking SQLite's busy
    // handler, so retry this idempotent pragma within a bounded startup window.
    const retryDeadline = performance.now() + SQLITE_BUSY_TIMEOUT_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await prisma.$queryRawUnsafe(`PRAGMA journal_mode = WAL`);
        break;
      } catch (error) {
        const remainingMs = retryDeadline - performance.now();
        if (!isSqliteLockError(error) || remainingMs <= 0) throw error;
        await delay(Math.min(attempt * 50, 250, remainingMs));
        if (performance.now() >= retryDeadline) throw error;
      }
    }
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
    timeoutMs?: number
  } = {}
): Promise<string | null> {
  try {
    const platform = options.platform ?? process.platform;
    const lookupCommand = platform === 'win32' ? 'where' : 'which';
    const env = options.env ?? process.env;
    const { stdout } = await execFileAsync(lookupCommand, [command], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: options.timeoutMs,
      env: platform === 'win32'
        ? withWindowsUserPathFallbacks(env)
        : platform === 'darwin' || platform === 'linux'
          ? withUnixUserPathFallbacks(env, platform)
          : env,
    });
    return normalizeCommandLookupOutput(String(stdout ?? ''), platform);
  } catch {
    return null;
  }
}
