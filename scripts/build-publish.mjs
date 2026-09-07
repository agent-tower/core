/**
 * 发布构建脚本
 *
 * 构建所有包并组装可发布的 npm 包到 packages/server/publish/ 目录。
 *
 * 用法: node scripts/build-publish.mjs
 */
import { execFileSync, execSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const serverDir = resolve(root, 'packages/server');
const sharedDir = resolve(root, 'packages/shared');
const webDir = resolve(root, 'packages/web');
const publishDir = resolve(serverDir, 'publish');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const piPackageName = '@earendil-works/pi-coding-agent';

// ── Clean ────────────────────────────────────────────────────────
console.log('Cleaning previous build...');
rmSync(publishDir, { recursive: true, force: true });
rmSync(resolve(serverDir, 'dist'), { recursive: true, force: true });
rmSync(resolve(sharedDir, 'dist'), { recursive: true, force: true });
rmSync(resolve(webDir, 'dist'), { recursive: true, force: true });

// ── Build shared ─────────────────────────────────────────────────
console.log('\n[1/3] Building @agent-tower/shared...');
execSync('pnpm --filter @agent-tower/shared build', { cwd: root, stdio: 'inherit' });

// ── Build server ─────────────────────────────────────────────────
console.log('\n[2/3] Building @agent-tower/server...');
execSync('pnpm --filter @agent-tower/server build', { cwd: root, stdio: 'inherit' });

// ── Build web ────────────────────────────────────────────────────
console.log('\n[3/3] Building web...');
execSync('pnpm --filter web build', { cwd: root, stdio: 'inherit' });

// ── Assemble publish directory ───────────────────────────────────
console.log('\nAssembling publish package...');
mkdirSync(publishDir, { recursive: true });
const serverPkg = JSON.parse(readFileSync(resolve(serverDir, 'package.json'), 'utf-8'));
const sharedPkg = JSON.parse(readFileSync(resolve(sharedDir, 'package.json'), 'utf-8'));

// 1. 复制 server 编译产物
cpSync(resolve(serverDir, 'dist'), resolve(publishDir, 'dist'), { recursive: true });
// 确保 bin 入口文件有执行权限
chmodSync(resolve(publishDir, 'dist/cli.js'), 0o755);
chmodSync(resolve(publishDir, 'dist/mcp/index.js'), 0o755);

// 2. 复制前端构建产物到 dist/web/
cpSync(resolve(webDir, 'dist'), resolve(publishDir, 'dist/web'), { recursive: true });

// 3. 复制 prisma schema
cpSync(resolve(serverDir, 'prisma'), resolve(publishDir, 'prisma'), { recursive: true });
// 删除可能存在的数据库文件（不应发布）
const dbFile = resolve(publishDir, 'prisma/data.db');
if (existsSync(dbFile)) rmSync(dbFile);

// 4. 复制 postinstall 脚本
mkdirSync(resolve(publishDir, 'scripts'), { recursive: true });
cpSync(resolve(serverDir, 'scripts/postinstall.js'), resolve(publishDir, 'scripts/postinstall.js'));
cpSync(
  resolve(serverDir, 'scripts/patch-claude-agent-acp.mjs'),
  resolve(publishDir, 'scripts/patch-claude-agent-acp.mjs'),
);

// 5. 将 @agent-tower/shared 放入 node_modules（bundledDependencies 需要）
const sharedDest = resolve(publishDir, 'node_modules/@agent-tower/shared');
mkdirSync(sharedDest, { recursive: true });
cpSync(resolve(sharedDir, 'dist'), resolve(sharedDest, 'dist'), { recursive: true });
cpSync(resolve(sharedDir, 'package.json'), resolve(sharedDest, 'package.json'));

// 6. Bundle @prisma/client without its postinstall generator. npm runs package
// postinstall scripts concurrently, so leaving both generators enabled can corrupt
// node_modules/.prisma/client. The regular prisma dependency still installs the
// target machine's engines, then Agent Tower's postinstall runs the sole generate.
const prismaClientSrc = realpathSync(resolve(serverDir, 'node_modules/@prisma/client'));
const prismaClientDest = resolve(publishDir, 'node_modules/@prisma/client');
mkdirSync(prismaClientDest, { recursive: true });
cpSync(prismaClientSrc, prismaClientDest, {
  recursive: true,
  dereference: true,
  filter: (src) => {
    const rel = src.slice(prismaClientSrc.length);
    return !/[\\/]node_modules(?:[\\/]|$)/.test(rel);
  },
});
const prismaClientPkgPath = resolve(prismaClientDest, 'package.json');
const prismaClientPkg = JSON.parse(readFileSync(prismaClientPkgPath, 'utf-8'));
if (prismaClientPkg.scripts) {
  delete prismaClientPkg.scripts.generate;
  delete prismaClientPkg.scripts.postinstall;
}
// Agent Tower already depends on the exact matching Prisma CLI. Keeping the
// optional peer on a bundled client makes npm treat that CLI as part of the
// bundle without packing its files, leaving an empty node_modules/prisma.
if (prismaClientPkg.peerDependencies) {
  delete prismaClientPkg.peerDependencies.prisma;
  if (Object.keys(prismaClientPkg.peerDependencies).length === 0) {
    delete prismaClientPkg.peerDependencies;
  }
}
if (prismaClientPkg.peerDependenciesMeta) {
  delete prismaClientPkg.peerDependenciesMeta.prisma;
  if (Object.keys(prismaClientPkg.peerDependenciesMeta).length === 0) {
    delete prismaClientPkg.peerDependenciesMeta;
  }
}
writeFileSync(prismaClientPkgPath, JSON.stringify(prismaClientPkg, null, 2) + '\n');
console.log(`Bundled @prisma/client@${prismaClientPkg.version} without install-time generation`);

// cloudflared's JS wrapper is bundled without its publish-machine binary; the
// server downloads the correct binary on first tunnel start.

// 7. 生成发布用 package.json
const deps = { ...serverPkg.dependencies };
// 替换 workspace 协议为真实版本
deps['@agent-tower/shared'] = sharedPkg.version;
// The generated client and CLI must stay on the same exact Prisma release.
const prismaPkg = JSON.parse(readFileSync(resolve(serverDir, 'node_modules/prisma/package.json'), 'utf-8'));
if (prismaPkg.version !== prismaClientPkg.version) {
  throw new Error(`Prisma version mismatch: prisma=${prismaPkg.version}, client=${prismaClientPkg.version}`);
}
deps.prisma = prismaPkg.version;
deps['@prisma/client'] = prismaClientPkg.version;
// node-pty 保留在 dependencies 中（bundledDependencies 要求包必须同时在 dependencies 中声明）
// bundled 的预编译版本会优先使用，npm 不会再触发远程安装/node-gyp

const cloudflaredVersion = serverPkg.dependencies.cloudflared.replace(/^[~^]/, '');
const cloudflaredSrc = resolve(root, `node_modules/.pnpm/cloudflared@${cloudflaredVersion}/node_modules/cloudflared`);
const cloudflaredDest = resolve(publishDir, 'node_modules/cloudflared');
cpSync(cloudflaredSrc, cloudflaredDest, {
  recursive: true,
  dereference: true,
  filter: (src) => {
    const rel = src.slice(cloudflaredSrc.length);
    return !rel.includes('node_modules') && !/[\\/]bin(?:[\\/]|$)/.test(rel);
  },
});
const cloudflaredPkgPath = resolve(cloudflaredDest, 'package.json');
const cloudflaredPkg = JSON.parse(readFileSync(cloudflaredPkgPath, 'utf-8'));
if (cloudflaredPkg.scripts) {
  delete cloudflaredPkg.scripts.postinstall;
}
writeFileSync(cloudflaredPkgPath, JSON.stringify(cloudflaredPkg, null, 2) + '\n');
rmSync(resolve(cloudflaredDest, 'scripts/postinstall.mjs'), { force: true });
console.log(`Bundled cloudflared@${cloudflaredVersion} JS wrapper without a native binary`);

// 8. 将 @shitiandmw/node-pty 预打包（含多平台 prebuilds，避免用户需要 Python/node-gyp/MSVC）
const nodePtyVersion = serverPkg.dependencies['@shitiandmw/node-pty'];
const nodePtyPnpmDir = resolve(root, `node_modules/.pnpm/@shitiandmw+node-pty@${nodePtyVersion}/node_modules/@shitiandmw/node-pty`);
const nodePtyDest = resolve(publishDir, 'node_modules/@shitiandmw/node-pty');
mkdirSync(nodePtyDest, { recursive: true });
cpSync(nodePtyPnpmDir, nodePtyDest, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(nodePtyPnpmDir.length);
    if (rel.includes('node_modules')) return false;
    if (/[\\/]build[\\/]/.test(rel)) return false;
    if (/[\\/]test[\\/]/.test(rel)) return false;
    if (/[\\/]examples[\\/]/.test(rel)) return false;
    if (/[\\/]deps[\\/]/.test(rel)) return false;
    if (/[\\/]src[\\/]/.test(rel)) return false;
    if (rel.endsWith('.gyp') || rel.endsWith('.cc') || rel.endsWith('.h')) return false;
    return true;
  },
});
const nodePtyPkgPath = resolve(nodePtyDest, 'package.json');
const nodePtyPkg = JSON.parse(readFileSync(nodePtyPkgPath, 'utf-8'));
delete nodePtyPkg.scripts.install;
delete nodePtyPkg.scripts.postinstall;
writeFileSync(nodePtyPkgPath, JSON.stringify(nodePtyPkg, null, 2) + '\n');
console.log(`Bundled @shitiandmw/node-pty@${nodePtyVersion} with prebuilds`);

// 9. Materialize Pi with npm's nested install strategy before bundling it.
// Copying the pnpm package alone would leave symlinks into the workspace virtual
// store, while relying on npm to reconstruct Pi's shrinkwrap has produced
// incomplete global installs. This tree is self-contained and portable.
const piVersion = serverPkg.dependencies[piPackageName];
if (!piVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(piVersion)) {
  throw new Error(`Expected an exact ${piPackageName} version, received ${String(piVersion)}`);
}
const piStageRoot = mkdtempSync(resolve(tmpdir(), 'agent-tower-pi-runtime-'));
try {
  writeFileSync(resolve(piStageRoot, 'package.json'), JSON.stringify({
    name: 'agent-tower-pi-runtime-stage',
    private: true,
  }, null, 2) + '\n');
  console.log(`Staging complete runtime tree for ${piPackageName}@${piVersion}...`);
  execFileSync(
    npmCommand,
    [
      'install',
      `${piPackageName}@${piVersion}`,
      '--install-strategy=nested',
      '--omit=optional',
      '--ignore-scripts',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: piStageRoot, stdio: 'inherit' },
  );

  const piSrc = resolve(piStageRoot, 'node_modules', piPackageName);
  const piDest = resolve(publishDir, 'node_modules', piPackageName);
  mkdirSync(dirname(piDest), { recursive: true });
  cpSync(piSrc, piDest, { recursive: true, dereference: true });
  // npm pack excludes generated dependency bin links and recreates them when
  // installing. Remove them now because npm stages them as absolute temp links.
  rmSync(resolve(piDest, 'node_modules/.bin'), { recursive: true, force: true });

  const piPackage = JSON.parse(readFileSync(resolve(piDest, 'package.json'), 'utf-8'));
  if (piPackage.version !== piVersion) {
    throw new Error(`Staged Pi version mismatch: expected=${piVersion}, actual=${piPackage.version}`);
  }
  for (const requiredPath of [
    'dist/cli.js',
    'node_modules/undici/package.json',
    'node_modules/@earendil-works/pi-agent-core/package.json',
  ]) {
    if (!existsSync(resolve(piDest, requiredPath))) {
      throw new Error(`Incomplete bundled Pi runtime: missing ${requiredPath}`);
    }
  }
  console.log(`Bundled ${piPackageName}@${piVersion} with its complete runtime dependency tree`);
} finally {
  rmSync(piStageRoot, { recursive: true, force: true });
}

const publishPkg = {
  name: 'agent-tower',
  version: serverPkg.version,
  description: 'AI Agent Task Management Dashboard',
  repository: {
    type: 'git',
    url: 'git+https://github.com/agent-tower/core.git',
  },
  homepage: 'https://github.com/agent-tower/core#readme',
  bugs: {
    url: 'https://github.com/agent-tower/core/issues',
  },
  type: 'module',
  license: 'MIT',
  bin: {
    'agent-tower': './dist/cli.js',
    'agent-tower-mcp': './dist/mcp/index.js',
  },
  main: './dist/index.js',
  files: [
    'dist/',
    'prisma/',
    'scripts/',
    'node_modules/@agent-tower/',
    'node_modules/@earendil-works/pi-coding-agent/',
    'node_modules/@prisma/',
    'node_modules/@shitiandmw/',
    'node_modules/cloudflared/',
  ],
  scripts: {
    postinstall: 'node scripts/postinstall.js',
  },
  dependencies: deps,
  optionalDependencies: {
    fsevents: '~2.3.3',
  },
  bundledDependencies: [
    '@agent-tower/shared',
    '@earendil-works/pi-coding-agent',
    '@prisma/client',
    '@shitiandmw/node-pty',
    'cloudflared',
  ],
  engines: {
    node: '>=22.19.0',
  },
};

writeFileSync(resolve(publishDir, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

// 10. 复制 README.md
cpSync(resolve(root, 'README.md'), resolve(publishDir, 'README.md'));

// 7. 在 cli.ts 中设置 AGENT_TOWER_WEB_DIR 指向 dist/web
// app.ts 只在显式设置 AGENT_TOWER_WEB_DIR 时托管前端静态文件
// 实际上 cli.ts 中 __dirname = dist/，web 在 dist/web/，所以 app.ts 中用 'web' 相对路径即可
// 我们在 cli.ts 中设置 AGENT_TOWER_WEB_DIR=web（相对于 __dirname）

console.log(`\nPublish package ready at: ${publishDir}`);
console.log('\nPack once (from the repository root):');
console.log('  npm pack ./packages/server/publish --json --pack-destination ./packages/server/publish > ./packages/server/publish/pack-result.json');
console.log('\nFor full install validation, reuse that tarball:');
console.log(`  pnpm publish:smoke --tarball ./packages/server/publish/agent-tower-${serverPkg.version}.tgz`);
console.log('\nPublish the same tarball with an explicit dist-tag; follow .agents/skills/publish/SKILL.md.');
