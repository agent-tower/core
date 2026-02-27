import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { buildApp } from './app.js';
import { getDevPort } from '@agent-tower/shared/dev-port';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../../..');
const PORT = getDevPort(monorepoRoot);

// Dev 数据目录：与生产环境 (~/.agent-tower) 隔离
const dataDir = path.join(homedir(), '.agent-tower-dev');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'data.db');
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = dataDir;

// 确保数据库 schema 与当前版本一致
const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
const prismaBin = path.resolve(__dirname, '../node_modules/.bin/prisma');
try {
  execFileSync(prismaBin, ['db', 'push', '--skip-generate', `--schema=${schemaPath}`], {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Failed to initialize dev database:', msg);
  process.exit(1);
}

async function main() {
  const app = await buildApp();

  // 优雅关闭处理
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    try {
      await app.close();
      console.log('Server closed');
      // 等待 OS 释放端口
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Data directory: ${dataDir}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
