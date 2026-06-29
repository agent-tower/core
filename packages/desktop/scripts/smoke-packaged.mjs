import { spawn } from 'node:child_process';
import {
  createIsolatedDesktopTestEnv,
  findPackagedAppExecutable,
  packageRoot,
} from './packaged-app-env.mjs';

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const SMOKE_TIMEOUT_EXTRA_MS = 30_000;

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${value}`);
  }
  return parsed;
}

const startupTimeoutMs = process.env.AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS
  ? parsePositiveNumber(
    process.env.AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS,
    'AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS',
  )
  : DEFAULT_STARTUP_TIMEOUT_MS;

const timeoutMs = process.env.AGENT_TOWER_DESKTOP_SMOKE_TIMEOUT_MS
  ? parsePositiveNumber(
    process.env.AGENT_TOWER_DESKTOP_SMOKE_TIMEOUT_MS,
    'AGENT_TOWER_DESKTOP_SMOKE_TIMEOUT_MS',
  )
  : startupTimeoutMs + SMOKE_TIMEOUT_EXTRA_MS;

async function waitForOutput(child, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for packaged smoke output`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      const result = predicate(text);
      if (result) {
        cleanup();
        resolve(result);
      }
    };

    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Packaged app exited before smoke passed: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

async function fetchJson(url, init = {}, timeout = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 5_000).unref();
}

async function terminateAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', cleanup);
      child.off('error', cleanup);
      resolve();
    };

    child.once('exit', cleanup);
    child.once('error', cleanup);
    terminate(child);
  });
}

const executable = findPackagedAppExecutable();
const isolated = createIsolatedDesktopTestEnv({
  prefix: 'agent-tower-desktop-smoke',
  extraEnv: {
    AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS: String(startupTimeoutMs),
    AGENT_TOWER_DESKTOP_VERIFY_SOCKET: '1',
    AGENT_TOWER_DESKTOP_VERIFY_TERMINAL: '1',
    AGENT_TOWER_DESKTOP_SMOKE: '1',
  },
});

console.log(`[desktop:smoke] Starting ${executable}`);
console.log(`[desktop:smoke] HOME=${isolated.tempHome}`);
console.log(`[desktop:smoke] userData=${isolated.tempUserData}`);
console.log(`[desktop:smoke] dataDir=${isolated.dataDir}`);
console.log(`[desktop:smoke] startupTimeoutMs=${isolated.env.AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS}`);
console.log(`[desktop:smoke] smokeTimeoutMs=${timeoutMs}`);

const child = spawn(executable, [], {
  cwd: packageRoot,
  env: isolated.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let health = false;
let socketConnected = false;
let terminalCreate = false;
let terminalCleanup = false;
let loadedUi = false;
let baseUrl = null;

try {
  await waitForOutput(child, (text) => {
    if (text.includes('Backend health check passed')) health = true;
    if (text.includes('Socket.IO verification passed')) socketConnected = true;
    if (text.includes('Terminal create verification passed')) terminalCreate = true;
    if (text.includes('Terminal cleanup verification passed')) terminalCleanup = true;
    if (text.includes('Loaded Agent Tower UI')) loadedUi = true;

    const baseUrlMatch = text.match(/Backend health check passed: (http:\/\/127\.0\.0\.1:\d+)\/api\/health/);
    if (baseUrlMatch) {
      baseUrl = baseUrlMatch[1];
    }

    if (health && socketConnected && terminalCreate && terminalCleanup && loadedUi) {
      return true;
    }
    return false;
  });
  if (!baseUrl) {
    throw new Error('Packaged smoke could not determine backend base URL');
  }

  const mcpConfig = await fetchJson(`${baseUrl}/api/system/mcp-config`);
  if (mcpConfig.runtimeMode !== 'desktop-packaged') {
    throw new Error(`Expected desktop-packaged MCP runtime mode, got ${mcpConfig.runtimeMode}`);
  }
  if (mcpConfig.command === 'agent-tower-mcp' || mcpConfig.config?.mcpServers?.['agent-tower']?.command === 'agent-tower-mcp') {
    throw new Error('Packaged MCP config uses global agent-tower-mcp command');
  }
  if (process.platform === 'win32') {
    const command = String(mcpConfig.command || '').replaceAll('\\', '/');
    if (!command.endsWith('/runtime/node/node.exe')) {
      throw new Error(`Packaged Windows MCP config command is not bundled node.exe: ${mcpConfig.command}`);
    }
    if (mcpConfig.env?.ELECTRON_RUN_AS_NODE) {
      throw new Error('Packaged Windows MCP config should not use ELECTRON_RUN_AS_NODE');
    }
  } else if (mcpConfig.command !== executable) {
    throw new Error(`Packaged MCP config command is not the app executable: ${mcpConfig.command}`);
  }
  if (process.platform !== 'win32' && (!mcpConfig.env || mcpConfig.env.ELECTRON_RUN_AS_NODE !== '1')) {
    throw new Error('Packaged MCP config is missing ELECTRON_RUN_AS_NODE=1');
  }
  const mcpEntryArg = String(mcpConfig.args?.[0] || '').replaceAll('\\', '/');
  if (!mcpEntryArg.includes('runtime/server/dist/mcp/index.js')) {
    throw new Error(`Packaged MCP config does not point at bundled MCP entry: ${mcpConfig.args?.[0]}`);
  }
  console.log('[desktop:smoke] MCP config verification passed');
  console.log('[desktop:smoke] Packaged smoke passed');
} finally {
  await terminateAndWait(child);
  isolated.cleanup();
}
