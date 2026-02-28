#!/usr/bin/env node
/**
 * agent-tower CLI 入口
 *
 * 用法:
 *   agent-tower                     # 默认端口 3000，数据目录 ~/.agent-tower
 *   agent-tower --port 8080         # 指定端口
 *   agent-tower --data-dir /path    # 指定数据目录
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 12580;
const DEFAULT_DATA_DIR = path.join(homedir(), '.agent-tower');

function parseArgs(): { port: number; dataDir: string } {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let dataDir: string | undefined;

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
      case '--data-dir':
      case '-d':
        dataDir = args[++i];
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
    dataDir: dataDir ?? (process.env.AGENT_TOWER_DATA_DIR || DEFAULT_DATA_DIR),
  };
}

function printHelp() {
  console.log(`
agent-tower - AI Agent Task Management Dashboard

Usage: agent-tower [options]

Options:
  -p, --port <port>      Server port (default: 12580, env: AGENT_TOWER_PORT)
  -d, --data-dir <path>  Data directory (default: ~/.agent-tower, env: AGENT_TOWER_DATA_DIR)
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

/** 确保数据库 schema 与当前版本一致 */
function ensureDatabase(dbPath: string, schemaPath: string) {
  const prismaBin = path.resolve(__dirname, '../node_modules/.bin/prisma');
  try {
    execFileSync(prismaBin, ['db', 'push', '--skip-generate', `--schema=${schemaPath}`], {
      stdio: 'pipe',
      env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to initialize database:', msg);
    process.exit(1);
  }
}

async function main() {
  const { port, dataDir } = parseArgs();

  // 确保数据目录存在
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log(`Created data directory: ${dataDir}`);
  }

  // 设置环境变量（必须在 import app 之前，因为 Prisma client 在模块加载时初始化）
  const dbPath = path.join(dataDir, 'data.db');
  process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
  process.env.AGENT_TOWER_DATA_DIR = dataDir;
  process.env.AGENT_TOWER_WEB_DIR = 'web'; // 相对于 __dirname (dist/)，即 dist/web/
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';

  // 初始化数据库
  const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
  ensureDatabase(dbPath, schemaPath);

  // 启动服务器
  const { buildApp } = await import('./app.js');
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

  await app.listen({ port, host: '0.0.0.0' });

  // 写入端口文件，供 MCP 等外部进程发现
  const portFile = path.join(dataDir, 'port');
  writeFileSync(portFile, String(port), 'utf-8');

  const cleanupPortFile = () => {
    try { unlinkSync(portFile); } catch {}
  };
  process.on('exit', cleanupPortFile);

  console.log(`Agent Tower is running on http://localhost:${port}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
