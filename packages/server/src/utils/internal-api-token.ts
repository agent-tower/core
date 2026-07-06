import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveDataDir } from './data-dir.js';

export const INTERNAL_API_TOKEN_HEADER = 'x-agent-tower-internal-token';
export const INTERNAL_API_TOKEN_ENV = 'AGENT_TOWER_INTERNAL_TOKEN';
const INTERNAL_API_TOKEN_FILE = 'internal-api-token';

export function getInternalApiTokenPath(dataDir = resolveDataDir()): string {
  return path.join(dataDir, INTERNAL_API_TOKEN_FILE);
}

function normalizeToken(value: string): string | null {
  const token = value.trim();
  return token.length > 0 ? token : null;
}

export function readInternalApiToken(dataDir = resolveDataDir()): string | null {
  const tokenPath = getInternalApiTokenPath(dataDir);
  if (!existsSync(tokenPath)) return null;

  try {
    return normalizeToken(readFileSync(tokenPath, 'utf-8')) ?? null;
  } catch {
    return null;
  }
}

export function readInternalApiTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[INTERNAL_API_TOKEN_ENV];
  return typeof value === 'string' ? normalizeToken(value) : null;
}

export function requireInternalApiTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const token = readInternalApiTokenFromEnv(env);
  if (!token) {
    throw new Error(`${INTERNAL_API_TOKEN_ENV} is required for Agent Tower internal API access`);
  }
  return token;
}

export function getOrCreateInternalApiToken(dataDir = resolveDataDir()): string {
  const existing = readInternalApiToken(dataDir);
  if (existing) return existing;

  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  const tokenPath = getInternalApiTokenPath(dataDir);

  try {
    writeFileSync(tokenPath, `${token}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    return token;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const raced = readInternalApiToken(dataDir);
      if (raced) return raced;
    }
    throw err;
  }
}

export function validateInternalApiToken(value: string | null | undefined): boolean {
  if (!value) return false;

  const expected = readInternalApiTokenFromEnv();
  if (!expected) return false;

  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
