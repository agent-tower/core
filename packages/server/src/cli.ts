#!/usr/bin/env node
/**
 * agent-tower CLI 入口
 *
 * 用法:
 *   agent-tower                     # 默认端口 3000，数据目录 ~/.agent-tower
 *   agent-tower --port 8080         # 指定端口
 *   agent-tower --data-dir /path    # 指定数据目录
 *   agent-tower --host 127.0.0.1    # 指定监听地址
 *   agent-tower --web-dir web       # 指定前端静态目录（相对 dist/）
 *   agent-tower --disable-access-password  # 关闭访问密码（忘记密码恢复）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBundledPrismaCommand } from './utils/process-launch.js';
import { resolveDataDir } from './utils/data-dir.js';
import { preparePrismaCliEnv } from './utils/prisma-cli-env.js';
import { installProcessErrorLogging, writeErrorLog } from './utils/error-log.js';
import { getOrCreateInternalApiToken, INTERNAL_API_TOKEN_ENV } from './utils/internal-api-token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 12580;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_WEB_DIR = 'web';
let currentDataDir: string | undefined;

function parseArgs(): { port: number; host: string; dataDir: string; webDir: string; disableAccessPassword: boolean } {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let host: string | undefined;
  let dataDir: string | undefined;
  let webDir: string | undefined;
  let disableAccessPassword = process.env.AGENT_TOWER_DISABLE_ACCESS_PASSWORD === '1'
    || process.env.AGENT_TOWER_DISABLE_ACCESS_PASSWORD === 'true';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        port = parseInt(args[++i], 10);
        if (isNaN(port)) {
          console.error('Error: --port requires a valid number');
          process.exit(1);
        }
        break;
      case '--host':
        host = args[++i];
        if (!host) {
          console.error('Error: --host requires a valid hostname or IP address');
          process.exit(1);
        }
        break;
      case '--data-dir':
      case '-d':
        dataDir = args[++i];
        if (!dataDir) {
          console.error('Error: --data-dir requires a path');
          process.exit(1);
        }
        break;
      case '--web-dir':
        webDir = args[++i];
        if (!webDir) {
          console.error('Error: --web-dir requires a path');
          process.exit(1);
        }
        break;
      case '--disable-access-password':
        disableAccessPassword = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--version':
      case '-v':
        printVersion();
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return {
    port: port ?? (process.env.AGENT_TOWER_PORT ? parseInt(process.env.AGENT_TOWER_PORT, 10) : DEFAULT_PORT),
    host: host ?? process.env.AGENT_TOWER_HOST ?? DEFAULT_HOST,
    dataDir: resolveDataDir(dataDir),
    webDir: webDir ?? (process.env.AGENT_TOWER_WEB_DIR || DEFAULT_WEB_DIR),
    disableAccessPassword,
  };
}

function printHelp() {
  console.log(`
agent-tower - AI Agent Task Management Dashboard

Usage: agent-tower [options]

Options:
  -p, --port <port>      Server port (default: 12580, env: AGENT_TOWER_PORT)
  --host <host>          Listen host (default: 0.0.0.0, env: AGENT_TOWER_HOST)
  -d, --data-dir <path>  Data directory (default: ~/.agent-tower, env: AGENT_TOWER_DATA_DIR)
  --web-dir <path>       Web dist directory, resolved relative to dist/ unless absolute
                         (default: web, env: AGENT_TOWER_WEB_DIR)
  --disable-access-password
                         Disable the access password and rotate sessions
                         (env: AGENT_TOWER_DISABLE_ACCESS_PASSWORD=1)
  -h, --help             Show this help
  -v, --version          Show version
`);
}

function printVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
    );
    console.log(pkg.version);
  } catch {
    console.log('unknown');
  }
}

function getCommandOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  const output = (error as Partial<SpawnSyncReturns<Buffer>> | null)?.[key];
  if (!output) return '';
  return Buffer.isBuffer(output) ? output.toString('utf-8').trim() : String(output).trim();
}

/** 确保数据库 schema 与当前版本一致 */
function ensureDatabase(dataDir: string, dbPath: string, schemaPath: string) {
  const prisma = getBundledPrismaCommand(__dirname);
  try {
    execFileSync(prisma.command, [...prisma.args, 'db', 'push', '--skip-generate', `--schema=${schemaPath}`], {
      stdio: 'pipe',
      env: preparePrismaCliEnv(dataDir, dbPath),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to initialize database:', msg);
    const stderr = getCommandOutput(err, 'stderr');
    const stdout = getCommandOutput(err, 'stdout');
    writeErrorLog({
      level: 'error',
      source: 'server.cli.ensureDatabase',
      message: 'Failed to initialize database',
      error: err,
      metadata: {
        dbPath,
        schemaPath,
        stderr,
        stdout,
      },
    }, { dataDir });
    if (stderr) {
      console.error(stderr);
    }
    if (stdout) {
      console.error(stdout);
    }
    process.exit(1);
  }
}

async function main() {
  const { port, host, dataDir, webDir, disableAccessPassword } = parseArgs();
  currentDataDir = dataDir;
  installProcessErrorLogging(dataDir);

  // 确保数据目录存在
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log(`Created data directory: ${dataDir}`);
  }

  // 设置环境变量（必须在 import app 之前，因为 Prisma client 在模块加载时初始化）
  const dbPath = path.join(dataDir, 'data.db');
  process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
  process.env.AGENT_TOWER_DATA_DIR = dataDir;
  process.env.AGENT_TOWER_WEB_DIR = webDir;
  process.env.AGENT_TOWER_HOST = host;
  process.env.AGENT_TOWER_PORT = String(port);
  process.env.AGENT_TOWER_URL = `http://127.0.0.1:${port}`;

  // 初始化数据库
  const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
  ensureDatabase(dataDir, dbPath, schemaPath);
  process.env[INTERNAL_API_TOKEN_ENV] = getOrCreateInternalApiToken(dataDir);

  // 启动服务器
  const { buildApp } = await import('./app.js');
  if (disableAccessPassword) {
    const { AccessAuthService } = await import('./services/access-auth.service.js');
    await AccessAuthService.disableForRecovery();
    console.log('Access password disabled.');
  }
  const app = await buildApp();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log('\nForce exit.');
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down...`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      console.error('Shutdown error:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port, host });

  // 写入端口文件，供 MCP 等外部进程发现
  const portFile = path.join(dataDir, 'port');
  writeFileSync(portFile, String(port), 'utf-8');

  const cleanupPortFile = () => {
    try { unlinkSync(portFile); } catch {}
  };
  process.on('exit', cleanupPortFile);

  const printableHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`Agent Tower is running on http://${printableHost}:${port}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  writeErrorLog({
    level: 'error',
    source: 'server.cli.main',
    message: 'Fatal server startup error',
    error: err,
  }, { dataDir: currentDataDir });
  process.exit(1);
});
