import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
  verifyCliStartup: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
  spawnSync: mocks.spawnSync,
}));

vi.mock('../../../scripts/verify-cli-startup.mjs', () => ({
  verifyCliStartup: mocks.verifyCliStartup,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  mkdtempSync: mocks.mkdtempSync,
  readFileSync: mocks.readFileSync,
  readdirSync: mocks.readdirSync,
  rmSync: mocks.rmSync,
  statSync: mocks.statSync,
  writeFileSync: mocks.writeFileSync,
}));

const scriptPath = fileURLToPath(new URL('../../../scripts/smoke-publish-install.mjs', import.meta.url));
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const publishDir = path.join(repoRoot, 'packages/server/publish');
const serverPackagePath = path.join(repoRoot, 'packages/server/package.json');
const tempRoot = path.resolve('mock-publish-smoke');
const installPrefix = path.join(tempRoot, 'prefix');
const globalRoot = path.join(installPrefix, 'lib/node_modules');
const installedRoot = path.join(globalRoot, 'agent-tower');
const consumerDir = path.join(tempRoot, 'consumer-project');
const tarballName = 'agent-tower-1.2.3-beta.4.tgz';
const generatedTarball = path.join(tempRoot, 'pack', tarballName);
const externalTarball = path.resolve('release artifacts', tarballName);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const piVersion = '0.85.1';
const originalArgv = process.argv;
let existingFiles: Set<string>;
let packageMetadata: Map<string, object>;

async function runSmoke(args: string[] = []) {
  process.argv = [process.execPath, scriptPath, ...args];
  await import('../../../scripts/smoke-publish-install.mjs');
}

function expectInstall(tarballPath: string) {
  expect(mocks.execFileSync).toHaveBeenCalledWith(
    npmCommand,
    ['install', '--global', '--prefix', installPrefix, tarballPath, '--no-audit', '--no-fund'],
    {
      cwd: consumerDir,
      env: expect.objectContaining({ INIT_CWD: consumerDir, PWD: consumerDir }),
      stdio: 'inherit',
    },
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  existingFiles = new Set([
    path.join(publishDir, 'package.json'),
    externalTarball,
    path.join(installedRoot, 'vendor/pi/package.json'),
    path.join(installedRoot, 'vendor/pi/node_modules/undici/package.json'),
    path.join(installedRoot, 'vendor/pi/node_modules/@earendil-works/pi-agent-core/package.json'),
    path.join(installedRoot, 'vendor/pi/bin', process.platform === 'win32' ? 'pi.cmd' : 'pi.mjs'),
  ]);
  packageMetadata = new Map([
    [path.join(installedRoot, 'package.json'), {
      name: 'agent-tower',
      version: '1.2.3-beta.4',
      dependencies: { fastify: '^4.26.0' },
      bundledDependencies: ['@agent-tower/shared', '@prisma/client', '@shitiandmw/node-pty', 'cloudflared'],
    }],
    [serverPackagePath, {
      dependencies: { '@earendil-works/pi-coding-agent': piVersion },
    }],
    [path.join(installedRoot, 'vendor/pi/package.json'), { version: piVersion }],
    [path.join(installedRoot, 'node_modules/@prisma/client/package.json'), { version: '5.22.0' }],
  ]);
  mocks.verifyCliStartup.mockResolvedValue('cli=1.2.3-beta.4 health=ok web=ok mcp=agent-tower');
  mocks.existsSync.mockImplementation(filePath => existingFiles.has(filePath));
  mocks.statSync.mockReturnValue({ isFile: () => true });
  mocks.mkdtempSync.mockReturnValue(tempRoot);
  mocks.readFileSync.mockImplementation(filePath => {
    if (!packageMetadata.has(filePath)) throw new Error(`Unexpected file read: ${filePath}`);
    return JSON.stringify(packageMetadata.get(filePath));
  });
  mocks.readdirSync.mockReturnValue(['index.js', 'libquery_engine-test.node']);
  mocks.execFileSync.mockImplementation((command, args) => {
    if (command === process.execPath) return '';
    if (command !== npmCommand) throw new Error(`Unexpected executable: ${command}`);
    if (args[0] === 'pack') return `${tarballName}\n`;
    if (args[0] === 'install') return '';
    if (args[0] === 'root') return `${globalRoot}\n`;
    throw new Error(`Unexpected npm arguments: ${args.join(' ')}`);
  });
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: `${piVersion}\n`, stderr: '' });
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('publish install smoke tarball reuse', () => {
  it.each([
    ['--tarball', externalTarball],
    ['--tarball', path.relative(process.cwd(), externalTarball)],
    ['--', '--tarball', externalTarball],
  ])('installs existing input without packing or requiring a build: %j', async (...args) => {
    existingFiles.delete(path.join(publishDir, 'package.json'));

    await runSmoke(args);

    expectInstall(externalTarball);
    expect(mocks.execFileSync.mock.calls.some(([, argumentsList]) => argumentsList[0] === 'pack')).toBe(false);
    expect(mocks.existsSync).not.toHaveBeenCalledWith(path.join(publishDir, 'package.json'));
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(tempRoot, { recursive: true, force: true });
    expect(mocks.spawnSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('status=passed'));
  });

  it('keeps the no-argument temporary pack workflow', async () => {
    await runSmoke();

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      npmCommand,
      ['pack', '--silent', '--pack-destination', path.join(tempRoot, 'pack')],
      { cwd: publishDir, encoding: 'utf8' },
    );
    expectInstall(generatedTarball);
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(tempRoot, { recursive: true, force: true });
  });

  it.each([
    ['--tarball'],
    ['--unknown', externalTarball],
    [externalTarball],
    ['--tarball', ''],
    ['--tarball', '--unknown'],
    ['--tarball', externalTarball, '--tarball', externalTarball],
  ])('rejects invalid arguments before any command: %j', async (...args) => {
    await expect(runSmoke(args)).rejects.toThrow('Usage: pnpm publish:smoke');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.mkdtempSync).not.toHaveBeenCalled();
  });

  it('rejects a missing local tarball before creating temporary files', async () => {
    existingFiles.delete(externalTarball);

    await expect(runSmoke(['--tarball', externalTarball])).rejects.toThrow('Tarball not found or not a file');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.mkdtempSync).not.toHaveBeenCalled();
  });

  it('rejects directory input rather than installing it', async () => {
    mocks.statSync.mockReturnValue({ isFile: () => false });

    await expect(runSmoke(['--tarball', externalTarball])).rejects.toThrow('Tarball not found or not a file');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('still requires a build when no tarball is supplied', async () => {
    existingFiles.delete(path.join(publishDir, 'package.json'));

    await expect(runSmoke()).rejects.toThrow('Publish package not found');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.mkdtempSync).not.toHaveBeenCalled();
  });

  it('cleans only its temporary directory when installation fails', async () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error('Install failed'); });

    await expect(runSmoke(['--tarball', externalTarball])).rejects.toThrow('Install failed');
    expectInstall(externalTarball);
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(tempRoot, { recursive: true, force: true });
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it('cleans up if npm pack does not return a filename', async () => {
    mocks.execFileSync.mockReturnValue('\n');

    await expect(runSmoke()).rejects.toThrow('npm pack did not return a tarball name');
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(tempRoot, { recursive: true, force: true });
  });

  it('retains the Prisma generator guard for an existing tarball', async () => {
    packageMetadata.set(path.join(installedRoot, 'node_modules/@prisma/client/package.json'), {
      version: '5.22.0',
      scripts: { postinstall: 'generate' },
    });

    await expect(runSmoke(['--tarball', externalTarball])).rejects.toThrow('still contains an install-time generator');
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(tempRoot, { recursive: true, force: true });
  });

  it('rejects an unexpected installed package identity', async () => {
    packageMetadata.set(path.join(installedRoot, 'package.json'), { name: 'different-package' });

    await expect(runSmoke(['--tarball', externalTarball])).rejects.toThrow('Unexpected installed package');
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(tempRoot, { recursive: true, force: true });
  });

  it('retains vendored Pi executable validation for an existing tarball', async () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'Missing dependency' });

    await expect(runSmoke(['--tarball', externalTarball])).rejects.toThrow('Vendored Pi executable failed');
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(tempRoot, { recursive: true, force: true });
  });

  it('boots the installed CLI to catch incomplete install trees', async () => {
    await runSmoke(['--tarball', externalTarball]);

    expect(mocks.verifyCliStartup).toHaveBeenCalledWith(installedRoot, '1.2.3-beta.4', tempRoot);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('health=ok'));
  });

  it('rejects a published package that declares Pi in its dependency graph', async () => {
    packageMetadata.set(path.join(installedRoot, 'package.json'), {
      name: 'agent-tower',
      version: '1.2.3-beta.4',
      dependencies: { '@earendil-works/pi-coding-agent': piVersion },
      bundledDependencies: ['@agent-tower/shared'],
    });

    await expect(runSmoke(['--tarball', externalTarball]))
      .rejects.toThrow('must not declare @earendil-works/pi-coding-agent in dependencies');
    expect(mocks.verifyCliStartup).not.toHaveBeenCalled();
    expect(mocks.rmSync).toHaveBeenCalledExactlyOnceWith(tempRoot, { recursive: true, force: true });
  });
});
