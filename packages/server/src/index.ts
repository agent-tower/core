import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { getDevPort } from '@agent-tower/shared/dev-port';
import { synchronizeDatabaseSchema } from './utils/database-schema.js';
import { installProcessErrorLogging, registerProcessShutdownHandler, writeErrorLog } from './utils/error-log.js';
import { getOrCreateInternalApiToken, INTERNAL_API_TOKEN_ENV } from './utils/internal-api-token.js';
import { createServerEntryShutdownCoordinator, finishFailedServerEntry, installServerEntryShutdownRequests } from './runtime/server-entry-shutdown.js';
import type { ReferencedShutdownCoordinator } from './runtime/shutdown-coordinator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../../..');
const PORT = getDevPort(monorepoRoot);
let shutdownCoordinator: ReferencedShutdownCoordinator | undefined;
const shutdownRequests = installServerEntryShutdownRequests();

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

async function main() {
  // Keep the application singleton and worker imports behind schema validation.
  const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
  try {
    await synchronizeDatabaseSchema({ dataDir, dbPath, schemaPath, entryDir: __dirname });
  } catch (err) {
    writeErrorLog({
      level: 'error', source: 'server.index.ensureDatabase',
      message: 'Failed to initialize dev database', error: err,
      metadata: { dbPath, schemaPath, stdout: (err as { stdout?: string }).stdout, stderr: (err as { stderr?: string }).stderr },
    }, { dataDir });
    throw err;
  }
  const { buildApp } = await import('./app.js');
  const { destroyApplicationProcesses } = await import('./core/container.js');
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  // 优雅关闭处理。Fastify 的 onClose hook 失败后不会再次执行，因此在
  // 应用级 coordinator 中重复 runtime cleanup，并用 referenced retry 保持
  // 进程存活直到所有 owner 真正确认退出。
  const shutdown = createServerEntryShutdownCoordinator({
    closeApp: () => app?.close() ?? Promise.resolve(),
    destroyRuntime: destroyApplicationProcesses,
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
  app = await buildApp();

  const requestShutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    void shutdown.request().then(() => {
      console.log('Server closed');
      process.exit(0);
    });
  };

  shutdownRequests.setHandler(requestShutdown);
  if (shutdownRequests.requested) return;

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
  await finishFailedServerEntry(shutdownCoordinator);
});
