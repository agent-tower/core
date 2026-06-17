import { rmSync, mkdirSync, cpSync, existsSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const monorepoRoot = path.resolve(packageRoot, '../..');
const runtimeDir = path.join(packageRoot, 'runtime');
const serverRuntimeDir = path.join(runtimeDir, 'server');
const webRuntimeDir = path.join(runtimeDir, 'web');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: monorepoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function requirePath(target, label) {
  if (!existsSync(target)) {
    throw new Error(`Missing ${label}: ${path.relative(monorepoRoot, target)}`);
  }
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });

run('pnpm', ['--filter', '@agent-tower/server', 'deploy', '--legacy', '--prod', serverRuntimeDir]);

const selfWorkspaceLink = path.join(serverRuntimeDir, 'node_modules/.pnpm/node_modules/@agent-tower/server');
rmSync(selfWorkspaceLink, { force: true });

requirePath(path.join(serverRuntimeDir, 'dist/cli.js'), 'server CLI build output');
requirePath(path.join(serverRuntimeDir, 'prisma/schema.prisma'), 'Prisma schema');
requirePath(path.join(serverRuntimeDir, 'node_modules/prisma/build/index.js'), 'Prisma CLI runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/@prisma/client'), 'Prisma client runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/@shitiandmw/node-pty'), 'node-pty runtime');

const workspacePrismaClientPackage = realpathSync(path.join(monorepoRoot, 'packages/server/node_modules/@prisma/client'));
const generatedPrismaClientSrc = path.resolve(workspacePrismaClientPackage, '../../.prisma/client');
const runtimePrismaClientPackage = realpathSync(path.join(serverRuntimeDir, 'node_modules/@prisma/client'));
const generatedPrismaClientDest = path.join(serverRuntimeDir, 'node_modules/@prisma/client/.prisma/client');
const rootGeneratedPrismaClientDest = path.join(serverRuntimeDir, 'node_modules/.prisma/client');
const pnpmGeneratedPrismaClientDest = path.resolve(runtimePrismaClientPackage, '../../.prisma/client');
requirePath(generatedPrismaClientSrc, 'generated Prisma client');
for (const target of [generatedPrismaClientDest, rootGeneratedPrismaClientDest, pnpmGeneratedPrismaClientDest]) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(generatedPrismaClientSrc, target, {
    recursive: true,
    dereference: true,
  });
}

const prismaEngineFiles = readdirSync(generatedPrismaClientDest).filter((name) => name.includes('query_engine') || name.includes('libquery_engine'));
if (prismaEngineFiles.length === 0) {
  throw new Error(`Generated Prisma client has no query engine files: ${generatedPrismaClientDest}`);
}

const nodePtyPrebuildRoot = path.join(serverRuntimeDir, 'node_modules/@shitiandmw/node-pty/prebuilds');
for (const platformDir of readdirSync(nodePtyPrebuildRoot, { withFileTypes: true })) {
  if (!platformDir.isDirectory()) continue;
  const spawnHelper = path.join(nodePtyPrebuildRoot, platformDir.name, 'spawn-helper');
  if (existsSync(spawnHelper)) {
    chmodSync(spawnHelper, 0o755);
  }
}

cpSync(path.join(monorepoRoot, 'packages/web/dist'), webRuntimeDir, {
  recursive: true,
  dereference: true,
});
requirePath(path.join(webRuntimeDir, 'index.html'), 'web dist index.html');

console.log(`[desktop:runtime] Prepared ${path.relative(monorepoRoot, runtimeDir)}`);
