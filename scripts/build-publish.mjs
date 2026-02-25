/**
 * 发布构建脚本
 *
 * 构建所有包并组装可发布的 npm 包到 packages/server/publish/ 目录。
 *
 * 用法: node scripts/build-publish.mjs
 */
import { execSync } from 'node:child_process';
import {
  cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const serverDir = resolve(root, 'packages/server');
const sharedDir = resolve(root, 'packages/shared');
const webDir = resolve(root, 'packages/web');
const publishDir = resolve(serverDir, 'publish');

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

// 5. 将 @agent-tower/shared 放入 node_modules（bundledDependencies 需要）
const sharedDest = resolve(publishDir, 'node_modules/@agent-tower/shared');
mkdirSync(sharedDest, { recursive: true });
cpSync(resolve(sharedDir, 'dist'), resolve(sharedDest, 'dist'), { recursive: true });
cpSync(resolve(sharedDir, 'package.json'), resolve(sharedDest, 'package.json'));

// 6. 将预生成的 Prisma Client 打包进 node_modules（避免全局安装时 prisma generate 出错）
const prismaClientSrc = resolve(root, 'node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules');
// @prisma/client — 包的入口，require('.prisma/client/default')
const atPrismaClientSrc = resolve(prismaClientSrc, '@prisma/client');
const atPrismaDest = resolve(publishDir, 'node_modules/@prisma/client');
mkdirSync(atPrismaDest, { recursive: true });
cpSync(atPrismaClientSrc, atPrismaDest, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(atPrismaClientSrc.length);
    return !rel.includes('node_modules');
  },
});
// .prisma/client 放到 @prisma/client/node_modules/.prisma/client/ 下
// 这样 require('.prisma/client/default') 能通过 Node 模块解析找到
const dotPrismaDest = resolve(atPrismaDest, 'node_modules/.prisma/client');
mkdirSync(dotPrismaDest, { recursive: true });
cpSync(resolve(prismaClientSrc, '.prisma/client'), dotPrismaDest, { recursive: true });

// 7. 将 prisma CLI 和 @prisma/engines 预打包（避免全局安装时 postinstall 脚本失败）
const prismaSrc = resolve(root, 'node_modules/.pnpm/prisma@5.22.0/node_modules');
// prisma CLI
const prismaDest = resolve(publishDir, 'node_modules/prisma');
mkdirSync(prismaDest, { recursive: true });
cpSync(resolve(prismaSrc, 'prisma'), prismaDest, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(resolve(prismaSrc, 'prisma').length);
    return !rel.includes('node_modules');
  },
});
// @prisma/engines 及其完整依赖链（@prisma/debug, @prisma/fetch-engine, @prisma/get-platform 等）
const enginesFullSrc = resolve(root, 'node_modules/.pnpm/@prisma+engines@5.22.0/node_modules/@prisma');
const enginesFullDest = resolve(prismaDest, 'node_modules/@prisma');
mkdirSync(enginesFullDest, { recursive: true });
cpSync(enginesFullSrc, enginesFullDest, { recursive: true, dereference: true });

// 6. 生成发布用 package.json
const serverPkg = JSON.parse(readFileSync(resolve(serverDir, 'package.json'), 'utf-8'));
const sharedPkg = JSON.parse(readFileSync(resolve(sharedDir, 'package.json'), 'utf-8'));

const deps = { ...serverPkg.dependencies };
// 替换 workspace 协议为真实版本
deps['@agent-tower/shared'] = sharedPkg.version;
// prisma 从 devDependencies 提升到 dependencies（bundledDependencies 需要在 deps 中声明）
deps['prisma'] = serverPkg.devDependencies.prisma;

const publishPkg = {
  name: 'agent-tower',
  version: serverPkg.version,
  description: 'AI Agent Task Management Dashboard',
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
    'node_modules/@prisma/',
    'node_modules/prisma/',
  ],
  scripts: {
    postinstall: 'node scripts/postinstall.js',
  },
  dependencies: deps,
  optionalDependencies: {
    fsevents: '~2.3.3',
  },
  bundledDependencies: ['@agent-tower/shared', '@prisma/client', 'prisma'],
  engines: {
    node: '>=18.0.0',
  },
};

writeFileSync(resolve(publishDir, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

// 7. 在 cli.ts 中设置 AGENT_TOWER_WEB_DIR 指向 dist/web
// cli.ts 已经设置 NODE_ENV=production，app.ts 会读取 AGENT_TOWER_WEB_DIR
// 需要在 cli.ts 的 env 设置中加入 web dir
// 实际上 cli.ts 中 __dirname = dist/，web 在 dist/web/，所以 app.ts 中用 'web' 相对路径即可
// 我们在 cli.ts 中设置 AGENT_TOWER_WEB_DIR=web（相对于 __dirname）

console.log(`\nPublish package ready at: ${publishDir}`);
console.log('\nTo publish:');
console.log(`  cd ${publishDir}`);
console.log('  npm publish');
console.log('\nTo test locally:');
console.log(`  cd ${publishDir}`);
console.log('  npm pack');
console.log('  npm install -g agent-tower-*.tgz');
