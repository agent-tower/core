import { spawn } from 'node:child_process';
import {
  createIsolatedDesktopTestEnv,
  findPackagedAppExecutable,
  packageRoot,
} from './packaged-app-env.mjs';

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 5_000).unref();
}

const executable = findPackagedAppExecutable();
const isolated = createIsolatedDesktopTestEnv({
  prefix: 'agent-tower-desktop-acceptance',
  extraEnv: {
    AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS: process.env.AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS || '120000',
  },
});

console.log(`[desktop:acceptance] Starting ${executable}`);
console.log('[desktop:acceptance] This is an isolated test launch. Do not use macOS open for desktop acceptance.');
console.log(`[desktop:acceptance] HOME=${isolated.tempHome}`);
console.log(`[desktop:acceptance] userData=${isolated.tempUserData}`);
console.log(`[desktop:acceptance] dataDir=${isolated.dataDir}`);
console.log(`[desktop:acceptance] startupTimeoutMs=${isolated.env.AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS}`);

const child = spawn(executable, process.argv.slice(2), {
  cwd: packageRoot,
  env: isolated.env,
  stdio: 'inherit',
});

const shutdown = () => {
  terminate(child);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

child.on('error', (error) => {
  isolated.cleanup();
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  isolated.cleanup();
  if (typeof code === 'number') {
    process.exit(code);
  }
  process.exit(signal ? 1 : 0);
});
