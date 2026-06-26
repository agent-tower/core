import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function getPrismaCacheBaseDir(dataDir: string): string {
  return path.join(dataDir, 'cache');
}

export function preparePrismaCliEnv(
  dataDir: string,
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const cacheDir = getPrismaCacheBaseDir(dataDir);
  mkdirSync(cacheDir, { recursive: true });

  return {
    ...env,
    AGENT_TOWER_DATABASE_URL: `file:${dbPath}`,
    CACHE_DIR: cacheDir,
  };
}
