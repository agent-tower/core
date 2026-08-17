import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishDir = path.join(repoRoot, 'packages/server/publish');
const publishPackagePath = path.join(publishDir, 'package.json');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const piPackageName = '@earendil-works/pi-coding-agent';

if (!existsSync(publishPackagePath)) {
  throw new Error('Publish package not found. Run pnpm build:publish first.');
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-tower-publish-smoke-'));
const packDir = path.join(tempRoot, 'pack');
const installPrefix = path.join(tempRoot, 'prefix');
const consumerDir = path.join(tempRoot, 'consumer-project');

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
    name: 'agent-tower-publish-smoke-consumer',
    private: true,
  }, null, 2) + '\n');
  const tarballName = execFileSync(
    npmCommand,
    ['pack', '--silent', '--pack-destination', packDir],
    { cwd: publishDir, encoding: 'utf8' },
  ).trim().split(/\r?\n/).at(-1);
  if (!tarballName) throw new Error('npm pack did not return a tarball name.');

  const tarballPath = path.join(packDir, tarballName);
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

  const expectedPiVersion = installedPackage.dependencies?.[piPackageName];
  if (!expectedPiVersion) {
    throw new Error(`Installed Agent Tower package does not declare ${piPackageName}.`);
  }
  const piRoot = path.join(installedRoot, 'node_modules', piPackageName);
  for (const requiredPath of [
    'dist/cli.js',
    'node_modules/undici/package.json',
    'node_modules/@earendil-works/pi-agent-core/package.json',
  ]) {
    if (!existsSync(path.join(piRoot, requiredPath))) {
      throw new Error(`Installed Pi runtime is incomplete: missing ${requiredPath}`);
    }
  }
  const piExecutable = path.join(
    installedRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'pi.cmd' : 'pi',
  );
  if (!existsSync(piExecutable)) {
    throw new Error('Installed Agent Tower package does not expose the bundled Pi executable.');
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
      'Bundled Pi executable failed.',
      piVersionCheck.error?.message,
      piVersionCheck.stdout?.trim(),
      piVersionCheck.stderr?.trim(),
    ].filter(Boolean).join('\n'));
  }
  const actualPiVersion = piVersionCheck.stdout.trim();
  if (actualPiVersion !== expectedPiVersion) {
    throw new Error(`Unexpected Pi version: expected=${expectedPiVersion}, actual=${actualPiVersion}`);
  }

  console.log([
    '[publish-smoke] status=passed',
    `prisma=${clientPackage.version}`,
    `pi=${actualPiVersion}`,
    `engines=${engineFiles.join(',')}`,
  ].join(' '));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
