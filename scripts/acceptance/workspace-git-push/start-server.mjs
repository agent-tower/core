/** Start only through the workspace service MCP. This process IS the server. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configuration, repositoryRoot } from './common.mjs';

const config = configuration();
const markerPath = path.join(config.root, 'server.json');
if (fs.existsSync(markerPath)) {
  const previous = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  let alive = false;
  try { process.kill(previous.pid, 0); alive = true; } catch { /* The previous smoke server exited. */ }
  assert(!alive, 'The recorded smoke server is still running; stop it through the workspace service MCP');
}
const homeDirectory = path.join(config.root, 'home');
fs.mkdirSync(homeDirectory, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.root, 'tmp'), { recursive: true });
process.env.HOME = homeDirectory;
process.env.TMPDIR = path.join(config.root, 'tmp');
process.env.AGENT_TOWER_DATA_DIR = config.dataDir;
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(config.dataDir, 'data.db')}`;
process.env.AGENT_TOWER_COMMAND_HELPER = config.helper;
const entry = path.join(repositoryRoot, 'packages/server/dist/cli.js');
assert(fs.existsSync(entry), 'Build the server before starting this smoke service');
process.argv = [process.execPath, entry, '--host', '127.0.0.1', '--port', String(config.port), '--data-dir', config.dataDir, '--disable-access-password'];
fs.writeFileSync(markerPath, JSON.stringify({ ...config, pid: process.pid, homeDirectory, startedAt: Date.now() }, null, 2));

// Acceptance-only telemetry makes cache/process assertions observable without
// adding an endpoint or instrumentation to the application itself.
const { readRuntimeCounters } = await import(pathToFileURL(path.join(repositoryRoot, 'packages/server/dist/runtime/runtime-metrics.js')).href);
const { getCommandHelperStatus } = await import(pathToFileURL(path.join(repositoryRoot, 'packages/server/dist/runtime/command-helper/client.js')).href);
function observe(stopped = false) {
  const destination = path.join(config.root, 'observation.json');
  const value = {
    observedAt: Date.now(), stopped, serverPid: process.pid,
    serverRssBytes: process.memoryUsage.rss(),
    serverWatchHandles: process._getActiveHandles().filter((handle) => handle.constructor?.name === 'FSWatcher').length,
    helper: getCommandHelperStatus(), counters: readRuntimeCounters(),
  };
  fs.writeFileSync(`${destination}.tmp`, JSON.stringify(value));
  fs.renameSync(`${destination}.tmp`, destination);
}
const timer = setInterval(observe, 100);
timer.unref();
process.once('exit', () => { clearInterval(timer); observe(true); });
await import(pathToFileURL(entry).href);
