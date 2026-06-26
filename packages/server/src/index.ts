import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { buildApp } from './app.js';
import { getDevPort } from '@agent-tower/shared/dev-port';
import { getBundledPrismaCommand } from './utils/process-launch.js';
import { preparePrismaCliEnv } from './utils/prisma-cli-env.js';
import { installProcessErrorLogging, writeErrorLog } from './utils/error-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../../..');
const PORT = getDevPort(monorepoRoot);

// Dev 数据目录：与生产环境 (~/.agent-tower) 隔离
const dataDir = path.join(homedir(), '.agent-tower-dev');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}
installProcessErrorLogging(dataDir);

const dbPath = path.join(dataDir, 'data.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = dataDir;
process.env.AGENT_TOWER_PORT = String(PORT);
process.env.AGENT_TOWER_URL = `http://127.0.0.1:${PORT}`;

// 确保数据库 schema 与当前版本一致
const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
const prisma = getBundledPrismaCommand(__dirname);
try {
  execFileSync(prisma.command, [...prisma.args, 'db', 'push', '--skip-generate', `--schema=${schemaPath}`], {
    stdio: 'pipe',
    env: preparePrismaCliEnv(dataDir, dbPath),
  });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Failed to initialize dev database:', msg);
  writeErrorLog({
    level: 'error',
    source: 'server.index.ensureDatabase',
    message: 'Failed to initialize dev database',
    error: err,
    metadata: {
      dbPath,
      schemaPath,
    },
  }, { dataDir });
  process.exit(1);
}

async function main() {
  const app = await buildApp();

  // 优雅关闭处理
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log('\nForce exit.');
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down gracefully...`);
    try {
      await app.close();
      console.log('Server closed');
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      writeErrorLog({
        level: 'error',
        source: 'server.index.shutdown',
        message: 'Error during shutdown',
        error: err,
      }, { dataDir });
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
    writeErrorLog({
      level: 'error',
      source: 'server.index.listen',
      message: 'Failed to start server listener',
      error: err,
      metadata: { port: PORT },
    }, { dataDir });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  writeErrorLog({
    level: 'error',
    source: 'server.index.main',
    message: 'Fatal dev server error',
    error: err,
  }, { dataDir });
  process.exit(1);
});
