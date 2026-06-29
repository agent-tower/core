import { app, BrowserWindow, dialog, Menu } from 'electron';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { promisify } from 'node:util';
import { resolveDesktopDataMode } from './data-mode.js';
import { redactDesktopLogText, sanitizeDesktopLogValue } from './log-redaction.js';

const execFileAsync = promisify(execFile);

const HOST = '127.0.0.1';
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const BACKEND_OUTPUT_TAIL_LIMIT = 12_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const monorepoRoot = path.resolve(packageRoot, '../..');

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort: number | null = null;
let quitting = false;

const userDataOverride = process.env.AGENT_TOWER_DESKTOP_USER_DATA_DIR;
if (userDataOverride) {
  mkdirSync(userDataOverride, { recursive: true });
  app.setPath('userData', userDataOverride);
}

function log(message: string): void {
  console.log(`[desktop] ${message}`);
}

function configureApplicationMenu(): void {
  if (process.platform !== 'darwin' && app.isPackaged) {
    Menu.setApplicationMenu(null);
  }
}

function getSharedDataDir(): string {
  return process.env.AGENT_TOWER_DATA_DIR || path.join(os.homedir(), '.agent-tower');
}

function getDesktopLogDataDir(dataDir?: string | null): string {
  return dataDir || getSharedDataDir();
}

function writeDesktopLog(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
  metadata?: Record<string, unknown>,
  dataDir?: string | null,
): void {
  try {
    const logsDir = path.join(getDesktopLogDataDir(dataDir), 'logs');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(path.join(logsDir, 'desktop.log'), `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      source,
      message: redactDesktopLogText(message),
      ...(metadata ? { metadata: sanitizeDesktopLogValue(metadata) } : {}),
    })}\n`, 'utf-8');
  } catch {
    // Logging must not block desktop startup or shutdown.
  }
}

function getStartupTimeoutMs(): number {
  const raw = process.env.AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS;
  if (!raw) return DEFAULT_STARTUP_TIMEOUT_MS;

  const value = Number.parseInt(raw, 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }

  log(`Ignoring invalid AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS=${raw}`);
  return DEFAULT_STARTUP_TIMEOUT_MS;
}

interface RuntimePaths {
  serverCliPath: string;
  serverCwd: string;
  mcpEntryPath: string;
  nodeRuntimePath: string | null;
  webDistPath: string;
  runtimeRoot: string;
  packagedRuntime: boolean;
}

function shouldUsePackagedRuntime(): boolean {
  return app.isPackaged;
}

function getRuntimePaths(): RuntimePaths {
  if (shouldUsePackagedRuntime()) {
    const runtimeRoot = path.join(process.resourcesPath, 'runtime');
    return {
      runtimeRoot,
      packagedRuntime: true,
      serverCliPath: path.join(runtimeRoot, 'server/dist/cli.js'),
      serverCwd: path.join(runtimeRoot, 'server'),
      mcpEntryPath: path.join(runtimeRoot, 'server/dist/mcp/index.js'),
      nodeRuntimePath: process.platform === 'win32'
        ? path.join(runtimeRoot, 'node/node.exe')
        : null,
      webDistPath: path.join(runtimeRoot, 'web'),
    };
  }

  return {
    runtimeRoot: monorepoRoot,
    packagedRuntime: false,
    serverCliPath: path.resolve(monorepoRoot, 'packages/server/dist/cli.js'),
    serverCwd: monorepoRoot,
    mcpEntryPath: path.resolve(monorepoRoot, 'packages/server/dist/mcp/index.js'),
    nodeRuntimePath: null,
    webDistPath: path.resolve(monorepoRoot, 'packages/web/dist'),
  };
}

function requireBuiltAssets(paths: RuntimePaths): void {
  const missing: string[] = [];
  if (!existsSync(paths.serverCliPath)) {
    missing.push(path.relative(paths.runtimeRoot, paths.serverCliPath));
  }
  if (!existsSync(paths.mcpEntryPath)) {
    missing.push(path.relative(paths.runtimeRoot, paths.mcpEntryPath));
  }
  if (paths.nodeRuntimePath && !existsSync(paths.nodeRuntimePath)) {
    missing.push(path.relative(paths.runtimeRoot, paths.nodeRuntimePath));
  }
  if (!existsSync(path.join(paths.webDistPath, 'index.html'))) {
    missing.push(path.relative(paths.runtimeRoot, path.join(paths.webDistPath, 'index.html')));
  }

  if (missing.length === 0) return;

  throw new Error(
    [
      'Desktop runtime requires built server and web assets.',
      `Missing: ${missing.join(', ')}`,
      paths.packagedRuntime
        ? 'Run: pnpm --filter @agent-tower/desktop package:dir'
        : 'Run: pnpm --filter @agent-tower/desktop spike',
    ].join('\n'),
  );
}

function getBackendNodeCommand(paths: RuntimePaths): string {
  if (shouldUsePackagedRuntime()) {
    return paths.nodeRuntimePath || process.execPath;
  }
  return process.env.AGENT_TOWER_DESKTOP_NODE || 'node';
}

function appendOutputTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  if (next.length <= BACKEND_OUTPUT_TAIL_LIMIT) {
    return next;
  }
  return next.slice(next.length - BACKEND_OUTPUT_TAIL_LIMIT);
}

function getIsolatedDataDir(): string {
  return path.join(app.getPath('userData'), 'data');
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a TCP port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const startedAt = Date.now();
  const startupTimeoutMs = getStartupTimeoutMs();
  let lastError: unknown;

  while (Date.now() - startedAt < startupTimeoutMs) {
    try {
      const health = await fetchJson<{ status?: string }>(`${baseUrl}/api/health`, {}, 2_000);
      if (health.status === 'ok') return;
      lastError = new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Backend did not become healthy within ${startupTimeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function startBackend(): Promise<string> {
  const runtimePaths = getRuntimePaths();
  requireBuiltAssets(runtimePaths);

  const port = await getAvailablePort();
  backendPort = port;

  const dataMode = resolveDesktopDataMode({
    envMode: process.env.AGENT_TOWER_DESKTOP_DATA_MODE,
    isPackaged: app.isPackaged,
  });
  const dataDir = dataMode === 'isolated' ? getIsolatedDataDir() : null;
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
  }

  const args = [
    runtimePaths.serverCliPath,
    '--port', String(port),
    '--host', HOST,
  ];
  if (dataDir) {
    args.push('--data-dir', dataDir);
  }
  args.push('--web-dir', runtimePaths.webDistPath);

  log(`Starting backend on http://${HOST}:${port}`);
  log(`Runtime mode: ${runtimePaths.packagedRuntime ? 'packaged' : 'workspace'}`);
  log(`Server CLI: ${runtimePaths.serverCliPath}`);
  log(`Backend startup timeout: ${getStartupTimeoutMs()}ms`);
  if (dataDir) {
    log(`Data directory mode: isolated`);
    log(`Data directory: ${dataDir}`);
  } else {
    log('Data directory mode: shared (server CLI default)');
  }
  writeDesktopLog('info', 'desktop.backend.start', 'Starting backend', {
    port,
    runtimeMode: runtimePaths.packagedRuntime ? 'packaged' : 'workspace',
    dataMode,
    serverCliPath: runtimePaths.serverCliPath,
  }, dataDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_TOWER_HOST: HOST,
    AGENT_TOWER_PORT: String(port),
    AGENT_TOWER_DESKTOP_RUNTIME_MODE: runtimePaths.packagedRuntime ? 'packaged' : 'workspace',
    AGENT_TOWER_MCP_ENTRY: runtimePaths.mcpEntryPath,
    AGENT_TOWER_WEB_DIR: runtimePaths.webDistPath,
  };
  if (dataDir) {
    env.AGENT_TOWER_DATA_DIR = dataDir;
  }
  if (runtimePaths.packagedRuntime) {
    const backendNodeCommand = getBackendNodeCommand(runtimePaths);
    env.AGENT_TOWER_NODE_RUNTIME = backendNodeCommand;
    if (backendNodeCommand === process.execPath) {
      env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      delete env.ELECTRON_RUN_AS_NODE;
    }
  }

  const child = spawn(getBackendNodeCommand(runtimePaths), args, {
    cwd: runtimePaths.serverCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backendProcess = child;
  let backendReady = false;
  let backendStdoutTail = '';
  let backendStderrTail = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    backendStdoutTail = appendOutputTail(backendStdoutTail, chunk);
    process.stdout.write(`[desktop:server] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    backendStderrTail = appendOutputTail(backendStderrTail, chunk);
    process.stderr.write(`[desktop:server] ${chunk.toString()}`);
  });

  const startupError = new Promise<never>((_, reject) => {
    child.once('error', (error) => {
      log(`Backend spawn failed: ${error.message}`);
      writeDesktopLog('error', 'desktop.backend.spawn', 'Backend spawn failed', {
        message: error.message,
        stack: error.stack,
      }, dataDir);
      if (backendProcess === child) {
        backendProcess = null;
      }
      reject(error);
    });
  });

  const backendExit = new Promise<never>((_, reject) => {
    child.once('exit', (code, signal) => {
      if (backendReady) return;
      const detail = [
        `code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        backendStderrTail.trim() ? `stderr:\n${backendStderrTail.trim()}` : null,
        backendStdoutTail.trim() ? `stdout:\n${backendStdoutTail.trim()}` : null,
      ].filter(Boolean).join('\n\n');
      writeDesktopLog('error', 'desktop.backend.startupExit', 'Backend exited before becoming healthy', {
        code,
        signal,
        stderrTail: backendStderrTail.trim(),
        stdoutTail: backendStdoutTail.trim(),
      }, dataDir);
      reject(new Error(`Backend exited before becoming healthy (${detail})`));
    });
  });

  child.on('error', (error) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    if (backendReady && !quitting) {
      writeDesktopLog('error', 'desktop.backend.error', 'Backend process error after startup', {
        message: error.message,
        stack: error.stack,
      }, dataDir);
      void dialog.showMessageBox({
        type: 'error',
        title: 'Agent Tower backend failed to start',
        message: 'The local Agent Tower backend process failed.',
        detail: error.message,
      }).finally(() => app.quit());
    }
  });

  child.on('exit', (code, signal) => {
    log(`Backend exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    if (backendProcess === child) {
      backendProcess = null;
    }
    if (backendReady && !quitting) {
      writeDesktopLog('error', 'desktop.backend.exit', 'Backend process exited after startup', {
        code,
        signal,
      }, dataDir);
      void dialog.showMessageBox({
        type: 'error',
        title: 'Agent Tower backend exited',
        message: 'The local Agent Tower backend process exited.',
        detail: `code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      }).finally(() => app.quit());
    }
  });

  const baseUrl = `http://${HOST}:${port}`;
  await Promise.race([waitForHealth(baseUrl), startupError, backendExit]);
  backendReady = true;
  log(`Backend health check passed: ${baseUrl}/api/health`);
  writeDesktopLog('info', 'desktop.backend.ready', 'Backend health check passed', {
    baseUrl,
  }, dataDir);

  if (process.env.AGENT_TOWER_DESKTOP_VERIFY_SOCKET === '1') {
    await verifySocketConnection(baseUrl);
  }

  if (process.env.AGENT_TOWER_DESKTOP_VERIFY_TERMINAL === '1') {
    await verifyTerminalCreate(baseUrl);
  }

  return baseUrl;
}

async function verifyTerminalCreate(baseUrl: string): Promise<void> {
  const terminal = await fetchJson<{ terminalId: string; pid: number }>(
    `${baseUrl}/api/terminals`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        socketId: `desktop-${Date.now()}`,
        cwd: app.getPath('home'),
        cols: 80,
        rows: 24,
      }),
    },
    10_000,
  );

  log(`Terminal create verification passed: terminalId=${terminal.terminalId} pid=${terminal.pid}`);

  await fetchJson<{ success: boolean }>(
    `${baseUrl}/api/terminals/${encodeURIComponent(terminal.terminalId)}`,
    { method: 'DELETE' },
    5_000,
  );
  log('Terminal cleanup verification passed');
}

async function verifySocketConnection(baseUrl: string): Promise<void> {
  const { io } = await import('socket.io-client');

  await new Promise<void>((resolve, reject) => {
    const socket = io(`${baseUrl}/events`, {
      autoConnect: true,
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket.IO verification timed out'));
    }, 10_000);

    socket.once('connect', () => {
      clearTimeout(timer);
      const socketId = socket.id;
      socket.disconnect();
      log(`Socket.IO verification passed: socketId=${socketId}`);
      resolve();
    });

    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
  });
}

function createWindow(baseUrl: string): BrowserWindow {
  const usesMacIntegratedTitlebar = process.platform === 'darwin';
  const usesWindowsIntegratedTitlebar = process.platform === 'win32';
  const usesIntegratedTitlebar = usesMacIntegratedTitlebar || usesWindowsIntegratedTitlebar;
  const appUrl = new URL(baseUrl);
  appUrl.searchParams.set('desktop', '1');
  appUrl.searchParams.set('desktopPlatform', process.platform);
  if (usesIntegratedTitlebar) {
    appUrl.searchParams.set('desktopTitlebar', 'integrated');
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: 'Agent Tower',
    autoHideMenuBar: !usesMacIntegratedTitlebar,
    ...(usesMacIntegratedTitlebar
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    ...(usesWindowsIntegratedTitlebar
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#fafafa',
            symbolColor: '#52525b',
            height: 48,
          },
        }
      : {}),
    backgroundColor: '#0f0f10',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (!usesMacIntegratedTitlebar && app.isPackaged) {
    window.setMenu(null);
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  void window.loadURL(appUrl.toString());
  window.webContents.once('did-finish-load', () => {
    log(`Loaded Agent Tower UI: ${appUrl.toString()}`);
    setTimeout(() => {
      void logMemorySnapshot();
    }, 1_000);
  });

  return window;
}

async function getProcessRssMiB(pid: number): Promise<number | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${pid}).WorkingSet64`,
      ], { timeout: 5_000 });
      const bytes = Number(stdout.trim());
      return Number.isFinite(bytes) ? bytes / 1024 / 1024 : null;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5_000 });
    const kib = Number(stdout.trim());
    return Number.isFinite(kib) ? kib / 1024 : null;
  } catch {
    return null;
  }
}

function formatMiB(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)} MiB`;
}

async function logMemorySnapshot(): Promise<void> {
  const metrics = app.getAppMetrics();
  log('Memory snapshot (rough working set / RSS):');
  for (const metric of metrics) {
    const workingSetMiB = metric.memory.workingSetSize / 1024;
    log(`  electron ${metric.type} pid=${metric.pid} workingSet=${workingSetMiB.toFixed(1)} MiB`);
  }

  if (backendProcess?.pid) {
    const backendRss = await getProcessRssMiB(backendProcess.pid);
    log(`  backend node pid=${backendProcess.pid} rss=${formatMiB(backendRss)}`);
  }
}

function stopBackend(): void {
  if (!backendProcess) return;
  const child = backendProcess;
  backendProcess = null;
  log(`Stopping backend pid=${child.pid}`);
  child.kill('SIGTERM');

  setTimeout(() => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }, 5_000).unref();
}

app.on('before-quit', () => {
  quitting = true;
  stopBackend();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.whenReady()
  .then(async () => {
    configureApplicationMenu();
    const baseUrl = await startBackend();
    mainWindow = createWindow(baseUrl);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[desktop] Fatal startup error:', error);
    writeDesktopLog('error', 'desktop.startup', 'Fatal desktop startup error', {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    void dialog.showMessageBox({
      type: 'error',
      title: 'Agent Tower failed to start',
      message,
    }).finally(() => app.quit());
  });

process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
process.on('exit', () => {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
  }
});

export {};
