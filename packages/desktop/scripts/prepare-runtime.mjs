import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { patchClaudeAgentAcp } from '../../server/scripts/patch-claude-agent-acp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const monorepoRoot = path.resolve(packageRoot, '../..');
const runtimeDir = path.join(packageRoot, 'runtime');
const serverRuntimeDir = path.join(runtimeDir, 'server');
const webRuntimeDir = path.join(runtimeDir, 'web');
const nodeRuntimeDir = path.join(runtimeDir, 'node');

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

function assertNoRuntimeSymlinks(target) {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    if (entry.name === '.bin' && entry.isDirectory()) {
      continue;
    }

    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Desktop runtime must not contain dependency symlinks: ${path.relative(monorepoRoot, entryPath)}`);
    }
    if (entry.isDirectory()) {
      assertNoRuntimeSymlinks(entryPath);
    }
  }
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });

const nodeRuntimePath = path.join(nodeRuntimeDir, process.platform === 'win32' ? 'node.exe' : 'node');
mkdirSync(nodeRuntimeDir, { recursive: true });
cpSync(process.execPath, nodeRuntimePath, {
  dereference: true,
});
if (process.platform !== 'win32') {
  chmodSync(nodeRuntimePath, 0o755);
}
requirePath(nodeRuntimePath, 'Node runtime');

run('pnpm', ['--filter', '@agent-tower/server', '--config.node-linker=hoisted', 'deploy', '--legacy', '--prod', serverRuntimeDir]);

const selfWorkspaceLink = path.join(serverRuntimeDir, 'node_modules/.pnpm/node_modules/@agent-tower/server');
rmSync(selfWorkspaceLink, { recursive: true, force: true });
if (existsSync(selfWorkspaceLink)) {
  throw new Error(`Failed to remove self workspace entry: ${selfWorkspaceLink}`);
}

requirePath(path.join(serverRuntimeDir, 'dist/cli.js'), 'server CLI build output');
requirePath(path.join(serverRuntimeDir, 'prisma/schema.prisma'), 'Prisma schema');
requirePath(path.join(serverRuntimeDir, 'node_modules/prisma/build/index.js'), 'Prisma CLI runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/@prisma/client'), 'Prisma client runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/@shitiandmw/node-pty'), 'node-pty runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/@modelcontextprotocol/sdk'), 'MCP SDK runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/@agentclientprotocol/sdk'), 'ACP SDK runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/@agentclientprotocol/codex-acp'), 'Codex ACP adapter runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/@agentclientprotocol/claude-agent-acp'), 'Claude Code ACP adapter runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/pi-acp/dist/index.js'), 'Pi ACP adapter runtime');
requirePath(path.join(serverRuntimeDir, 'node_modules/pi-mcp-adapter/package.json'), 'Pi MCP adapter runtime');
const piPackagePath = path.join(serverRuntimeDir, 'node_modules/@earendil-works/pi-coding-agent/package.json');
requirePath(piPackagePath, 'Pi runtime');
const piPackage = JSON.parse(readFileSync(piPackagePath, 'utf-8'));
if (piPackage.version !== '0.85.1') {
  throw new Error(`Unexpected Pi version ${piPackage.version}`);
}
requirePath(
  path.join(serverRuntimeDir, 'node_modules/.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi'),
  'Pi executable',
);
await patchClaudeAgentAcp({ moduleRoot: serverRuntimeDir });
assertNoRuntimeSymlinks(path.join(serverRuntimeDir, 'node_modules'));

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

const runtimeCheck = spawnSync(nodeRuntimePath, [
  '--input-type=module',
  '-e',
  [
    "import { createRequire } from 'node:module'",
    "const require = createRequire(import.meta.url)",
    "require('fastify')",
    "require('@prisma/client')",
    "require.resolve('@prisma/engines')",
    "require.resolve('@prisma/debug')",
    "require.resolve('@prisma/fetch-engine')",
    "require.resolve('@prisma/get-platform')",
    "await import('@modelcontextprotocol/sdk/server/mcp.js')",
    "await import('@agentclientprotocol/sdk')",
    "require.resolve('@agentclientprotocol/codex-acp')",
    "require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')",
    "require.resolve('pi-acp')",
    "require.resolve('pi-mcp-adapter')",
    "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 19)) throw new Error(`Bundled Node ${process.versions.node} is older than 22.19.0`)",
    "await import('@earendil-works/pi-coding-agent')",
    "const bundledExecutables = await import('./dist/runtime/acp/agents/executable-resolution.js')",
    "const claudeExecutable = bundledExecutables.resolveBundledClaudeExecutable()",
    "if (!claudeExecutable) throw new Error('Bundled Claude executable was not resolved')",
    "const codexEntrypoint = bundledExecutables.resolveBundledCodexEntrypoint()",
    "if (!codexEntrypoint) throw new Error('Bundled Codex entrypoint was not resolved')",
    "const piExecutable = bundledExecutables.resolveBundledPiExecutable()",
    "if (!piExecutable) throw new Error('Bundled Pi executable was not resolved')",
    "const { spawnSync: verifySpawnSync } = await import('node:child_process')",
    "const claudeVersion = verifySpawnSync(claudeExecutable, ['--version'], { encoding: 'utf-8', env: process.env })",
    "if (claudeVersion.status !== 0) throw new Error(`Bundled Claude executable failed: ${claudeVersion.error?.message ?? claudeVersion.stderr}`)",
    "const codexVersion = verifySpawnSync(process.execPath, [codexEntrypoint, '--version'], { encoding: 'utf-8', env: process.env })",
    "if (codexVersion.status !== 0) throw new Error(`Bundled Codex entrypoint failed: ${codexVersion.error?.message ?? codexVersion.stderr}`)",
    "const piVersion = verifySpawnSync(piExecutable, ['--version'], { encoding: 'utf-8', env: process.env, shell: process.platform === 'win32', timeout: 30000 })",
    "if (piVersion.status !== 0) throw new Error(`Bundled Pi executable failed: ${piVersion.error?.message ?? piVersion.stderr}`)",
    `if (piVersion.stdout.trim() !== ${JSON.stringify(piPackage.version)}) throw new Error(\`Unexpected bundled Pi version: \${piVersion.stdout.trim()}\`)`,
    "await import('./dist/mcp/server.js')",
  ].join(';'),
], {
  cwd: serverRuntimeDir,
  encoding: 'utf-8',
  env: process.env,
});
if (runtimeCheck.status !== 0) {
  throw new Error([
    'Packaged server runtime module resolution check failed.',
    runtimeCheck.stdout.trim(),
    runtimeCheck.stderr.trim(),
  ].filter(Boolean).join('\n'));
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
