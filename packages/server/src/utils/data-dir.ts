import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_DATA_DIR_NAME = '.agent-tower';

export function getDefaultDataDir(): string {
  return path.join(homedir(), DEFAULT_DATA_DIR_NAME);
}

export function resolveDataDir(override?: string | null): string {
  return override || process.env.AGENT_TOWER_DATA_DIR || getDefaultDataDir();
}
