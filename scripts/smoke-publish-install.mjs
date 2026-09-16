import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyCliStartup } from './verify-cli-startup.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishDir = path.join(repoRoot, 'packages/server/publish');
const publishPackagePath = path.join(publishDir, 'package.json');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const piPackageName = '@earendil-works/pi-coding-agent';
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

if (args.length > 0 && (
  args.length !== 2 || args[0] !== '--tarball' || !args[1] || args[1].startsWith('--')
)) {
  throw new Error('Usage: pnpm publish:smoke [--tarball <local-package.tgz>]');
}

let tarballPath = args.length > 0 ? path.resolve(args[1]) : undefined;
if (tarballPath && (!existsSync(tarballPath) || !statSync(tarballPath).isFile())) {
  throw new Error(`Tarball not found or not a file: ${tarballPath}`);
}
if (!tarballPath && !existsSync(publishPackagePath)) {
  throw new Error('Publish package not found. Run pnpm build:publish first.');
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-tower-publish-smoke-'));
const packDir = path.join(tempRoot, 'pack');
const installPrefix = path.join(tempRoot, 'prefix');
const consumerDir = path.join(tempRoot, 'consumer-project');

try {
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
    name: 'agent-tower-publish-smoke-consumer',
    private: true,
  }, null, 2) + '\n');
  if (!tarballPath) {
    mkdirSync(packDir, { recursive: true });
    const tarballName = execFileSync(
      npmCommand,
      ['pack', '--silent', '--pack-destination', packDir],
      { cwd: publishDir, encoding: 'utf8' },
    ).trim().split(/\r?\n/).at(-1);
    if (!tarballName) throw new Error('npm pack did not return a tarball name.');
    tarballPath = path.join(packDir, tarballName);
  }

  console.log(`[publish-smoke] tarball=${tarballPath}`);
  execFileSync(
    npmCommand,
    [
      'install',
      '--global',
      '--prefix',
      installPrefix,
      tarballPath,
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: consumerDir,
      env: {
        ...process.env,
        INIT_CWD: consumerDir,
        PWD: consumerDir,
      },
      stdio: 'inherit',
    },
  );

  const globalRoot = execFileSync(
    npmCommand,
    ['root', '--global', '--prefix', installPrefix],
    { encoding: 'utf8' },
  ).trim();
  const installedRoot = path.join(globalRoot, 'agent-tower');
  const installedPackage = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  if (installedPackage.name !== 'agent-tower') {
    throw new Error(`Unexpected installed package: ${installedPackage.name}`);
  }
  const clientPackagePath = path.join(installedRoot, 'node_modules/@prisma/client/package.json');
  const generatedClientDir = path.join(installedRoot, 'node_modules/.prisma/client');
  const generatedClientPath = path.join(generatedClientDir, 'index.js');
  const leakedGeneratedClientDir = path.join(consumerDir, 'node_modules/.prisma/client');
  const clientPackage = JSON.parse(readFileSync(clientPackagePath, 'utf8'));

  if (existsSync(leakedGeneratedClientDir)) {
    throw new Error(`Prisma Client leaked into the installer's working directory: ${leakedGeneratedClientDir}`);
  }
  if (clientPackage.scripts?.generate || clientPackage.scripts?.postinstall) {
    throw new Error('Bundled @prisma/client still contains an install-time generator.');
  }
  execFileSync(process.execPath, ['--check', generatedClientPath], { stdio: 'inherit' });
  const appPrismaModuleUrl = pathToFileURL(path.join(installedRoot, 'dist/utils/index.js')).href;
  const importAppPrismaScript = [
    `const module = await import(${JSON.stringify(appPrismaModuleUrl)})`,
    "if (!module.prisma || typeof module.prisma.$disconnect !== 'function') process.exit(1)",
    'await module.prisma.$disconnect()',
  ].join('; ');
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', importAppPrismaScript],
    { cwd: consumerDir, stdio: 'inherit' },
  );

  const engineFiles = readdirSync(generatedClientDir).filter(name => (
    name.includes('query_engine') || name.includes('libquery_engine')
  ));
  if (engineFiles.length === 0) {
    throw new Error('Prisma generate did not install a query engine.');
  }

  const serverPackage = JSON.parse(readFileSync(path.join(repoRoot, 'packages/server/package.json'), 'utf8'));
  const expectedPiVersion = serverPackage.dependencies?.[piPackageName];
  if (!expectedPiVersion) {
    throw new Error(`packages/server does not pin ${piPackageName}.`);
  }
  // Pi must stay out of the published dependency graph: `npm install -g`
  // otherwise treats it as a bundle that already provides the rest of the tree
  // and skips unpacking those packages. See scripts/build-publish.mjs step 9.
  for (const field of ['dependencies', 'bundledDependencies']) {
    if (installedPackage[field]?.[piPackageName] || installedPackage[field]?.includes?.(piPackageName)) {
      throw new Error(`Published package must not declare ${piPackageName} in ${field}.`);
    }
  }
  const piRoot = path.join(installedRoot, 'vendor', 'pi');
  const piPackagePath = path.join(piRoot, 'package.json');
  if (!existsSync(piPackagePath)) {
    throw new Error(`Vendored Pi runtime is missing: ${piPackagePath}`);
  }
  const piPackage = JSON.parse(readFileSync(piPackagePath, 'utf8'));
  if (piPackage.version !== expectedPiVersion) {
    throw new Error(`Vendored Pi version mismatch: expected=${expectedPiVersion}, actual=${piPackage.version}`);
  }
  for (const requiredPath of [
    'node_modules/undici/package.json',
    'node_modules/@earendil-works/pi-agent-core/package.json',
  ]) {
    if (!existsSync(path.join(piRoot, requiredPath))) {
      throw new Error(`Vendored Pi runtime is incomplete: missing ${requiredPath}`);
    }
  }
  const piExecutable = path.join(
    piRoot,
    'bin',
    process.platform === 'win32' ? 'pi.cmd' : 'pi.mjs',
  );
  if (!existsSync(piExecutable)) {
    throw new Error('Published Agent Tower package does not expose the vendored Pi executable.');
  }
  const piVersionCheck = spawnSync(piExecutable, ['--version'], {
    cwd: installedRoot,
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32',
    timeout: 30_000,
  });
  if (piVersionCheck.status !== 0) {
    throw new Error([
      'Vendored Pi executable failed.',
      piVersionCheck.error?.message,
      piVersionCheck.stdout?.trim(),
      piVersionCheck.stderr?.trim(),
    ].filter(Boolean).join('\n'));
  }
  const actualPiVersion = piVersionCheck.stdout.trim();
  if (actualPiVersion !== expectedPiVersion) {
    throw new Error(`Unexpected Pi version: expected=${expectedPiVersion}, actual=${actualPiVersion}`);
  }

  const startupSummary = await verifyCliStartup(installedRoot, installedPackage.version, tempRoot);

  console.log([
    '[publish-smoke] status=passed',
    `prisma=${clientPackage.version}`,
    `pi=${actualPiVersion}`,
    `engines=${engineFiles.join(',')}`,
    startupSummary,
  ].join(' '));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
