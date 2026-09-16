import { createRequire } from 'node:module';
import { constants, existsSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function resolveBundledClaudeExecutable(): string | undefined {
  let adapterPath: string;
  try {
    adapterPath = require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
  } catch {
    return undefined;
  }

  const adapterRequire = createRequire(adapterPath);
  let sdkPath: string;
  try {
    sdkPath = adapterRequire.resolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    return undefined;
  }

  const sdkRequire = createRequire(sdkPath);
  const extension = process.platform === 'win32' ? '.exe' : '';
  const packageNames = claudePlatformPackageNames();
  for (const packageName of packageNames) {
    try {
      const packageJson = sdkRequire.resolve(`@anthropic-ai/${packageName}/package.json`);
      return path.join(path.dirname(packageJson), `claude${extension}`);
    } catch {
      // Optional platform packages intentionally differ by host.
    }
  }
  return undefined;
}

export function resolveBundledCodexEntrypoint(): string | undefined {
  try {
    const adapterPath = require.resolve('@agentclientprotocol/codex-acp');
    return createRequire(adapterPath).resolve('@openai/codex/bin/codex.js');
  } catch {
    return undefined;
  }
}

export function claudePlatformPackageNames(): string[] {
  if (process.platform !== 'linux') {
    return [`claude-agent-sdk-${process.platform}-${process.arch}`];
  }
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const prefix = `claude-agent-sdk-linux-${process.arch}`;
  return report?.header?.glibcVersionRuntime
    ? [prefix, `${prefix}-musl`]
    : [`${prefix}-musl`, prefix];
}

export function resolveBundledPiExecutable(): string | undefined {
  const serverPackageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
  );
  // Published npm packages vendor Pi outside `node_modules` (see
  // scripts/build-publish.mjs); desktop and workspace runtimes resolve the
  // installed dependency instead.
  const candidates = [
    path.join(
      serverPackageRoot,
      'vendor',
      'pi',
      'bin',
      process.platform === 'win32' ? 'pi.cmd' : 'pi.mjs',
    ),
    path.join(
      serverPackageRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'pi.cmd' : 'pi',
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function isExecutableFile(target: string): Promise<boolean> {
  try {
    if (!(await stat(target)).isFile()) return false;
    await access(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
