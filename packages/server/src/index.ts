import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { buildApp } from './app.js';
import { getDevPort } from '@agent-tower/shared/dev-port';
import { getBundledPrismaCommand } from './utils/process-launch.js';
import { preparePrismaCliEnv } from './utils/prisma-cli-env.js';
import { installProcessErrorLogging, registerProcessShutdownHandler, writeErrorLog } from './utils/error-log.js';
import { getOrCreateInternalApiToken, INTERNAL_API_TOKEN_ENV } from './utils/internal-api-token.js';
import { getSessionManager } from './core/container.js';
import { createServerEntryShutdownCoordinator } from './runtime/server-entry-shutdown.js';
import type { ReferencedShutdownCoordinator } from './runtime/shutdown-coordinator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../../..');
const PORT = getDevPort(monorepoRoot);
let shutdownCoordinator: ReferencedShutdownCoordinator | undefined;

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
process.env[INTERNAL_API_TOKEN_ENV] = getOrCreateInternalApiToken(dataDir);

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
  process.exitCode = 1;
  throw err;
}

async function main() {
  const app = await buildApp();

  // 优雅关闭处理。Fastify 的 onClose hook 失败后不会再次执行，因此在
  // 应用级 coordinator 中重复 runtime cleanup，并用 referenced retry 保持
  // 进程存活直到所有 owner 真正确认退出。
  const shutdown = createServerEntryShutdownCoordinator({
    closeApp: () => app.close(),
    destroyRuntime: () => getSessionManager().destroyAll(),
    onAppCloseError: (error) => {
      console.warn('Fastify close reported an error after runtime cleanup; continuing shutdown', error);
    },
  },
    (error, attempt) => {
      console.error(`Shutdown cleanup pending (attempt ${attempt}); retrying`, error);
      writeErrorLog({
        level: 'warn',
        source: 'server.index.shutdown.retry',
        message: 'Runtime cleanup is still pending; shutdown will retry',
        error,
        metadata: { attempt },
      }, { dataDir });
    },
  );
  shutdownCoordinator = shutdown;
  registerProcessShutdownHandler(() => shutdown.request());

  const requestShutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    void shutdown.request().then(() => {
      console.log('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));

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
    throw err;
  }
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  writeErrorLog({
    level: 'error',
    source: 'server.index.main',
    message: 'Fatal dev server error',
    error: err,
  }, { dataDir });
  const shutdown = shutdownCoordinator;
  if (shutdown) {
    await shutdown.request();
  }
  process.exitCode = 1;
});
