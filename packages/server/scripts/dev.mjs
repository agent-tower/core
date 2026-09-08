import { spawn } from 'node:child_process';
import { existsSync, readdirSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopBackendAndWait } from './backend-process-shutdown.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const entryFile = path.join(packageRoot, 'src', 'index.ts');
const watchRoots = [
  path.join(packageRoot, 'src'),
  path.join(packageRoot, 'prisma'),
  path.join(packageRoot, '..', 'shared', 'dist'),
];
const restartDelayMs = 1000;

const watchedDirs = new Map();
let child = null;
let restartTimer = null;
let rescanTimer = null;
let restartAfterExit = false;
let restartInProgress = false;
let shuttingDown = false;

function log(message) {
  console.log(`[server:dev] ${message}`);
}

function listDirectories(root) {
  if (!existsSync(root)) {
    return [];
  }

  const directories = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    directories.push(dir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }

      stack.push(path.join(dir, entry.name));
    }
  }

  return directories;
}

function scheduleRescan() {
  if (rescanTimer) {
    return;
  }

  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    syncWatchers();
  }, 100);
}

function scheduleRestart(changedPath) {
  if (shuttingDown || restartInProgress) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    syncWatchers();
    restartServer(changedPath);
  }, 150);
}

function addWatcher(dir) {
  const watcher = watch(dir, (eventType, filename) => {
    const changedPath = filename ? path.join(dir, filename.toString()) : dir;

    if (eventType === 'rename') {
      scheduleRescan();
    }

    scheduleRestart(changedPath);
  });

  watcher.on('error', (error) => {
    log(`watch error in ${path.relative(packageRoot, dir) || '.'}: ${error.message}`);
    scheduleRescan();
    scheduleRestart(dir);
  });

  watchedDirs.set(dir, watcher);
}

function syncWatchers() {
  const nextDirs = new Set();

  for (const root of watchRoots) {
    for (const dir of listDirectories(root)) {
      nextDirs.add(dir);
    }
  }

  for (const [dir, watcher] of watchedDirs) {
    if (nextDirs.has(dir)) {
      continue;
    }

    watcher.close();
    watchedDirs.delete(dir);
  }

  for (const dir of nextDirs) {
    if (!watchedDirs.has(dir)) {
      addWatcher(dir);
    }
  }
}

function startServer() {
  if (shuttingDown) {
    return;
  }

  const childProcess = spawn(process.execPath, ['--import', 'tsx', entryFile], {
    cwd: packageRoot,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: process.env,
  });

  child = childProcess;

  childProcess.on('exit', (code, signal) => {
    if (child !== childProcess) {
      return;
    }

    child = null;

    if (shuttingDown) {
      return;
    }

    if (restartAfterExit) {
      restartAfterExit = false;
      setTimeout(() => {
        if (!shuttingDown && !child) {
          startServer();
          restartInProgress = false;
        }
      }, restartDelayMs);
      return;
    }

    restartInProgress = false;

    if (code && code !== 0) {
      log(`server exited with code ${code}. Waiting for changes...`);
    }
  });
}

function restartServer(changedPath) {
  restartInProgress = true;
  const label = path.relative(packageRoot, changedPath) || changedPath;
  log(`restarting due to ${label}`);

  if (!child) {
    startServer();
    restartInProgress = false;
    return;
  }

  const childToRestart = child;
  restartAfterExit = true;
  void stopBackendAndWait(childToRestart);
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  if (rescanTimer) {
    clearTimeout(rescanTimer);
  }

  for (const watcher of watchedDirs.values()) {
    watcher.close();
  }
  watchedDirs.clear();

  if (!child) {
    process.exit(0);
  }

  const childToStop = child;
  void stopBackendAndWait(childToStop).then(() => process.exit(0));
}

syncWatchers();
startServer();

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
