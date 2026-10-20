/**
 * Install-level CLI startup verification for a freshly installed Agent Tower.
 *
 * The package-content checks in `smoke-publish-install.mjs` only import a
 * utility module. That is how a tree which npm left full of empty directories
 * once passed the smoke test while the real `agent-tower` CLI crashed on
 * startup, so booting the CLI is verified for real here.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedLegacyDatabase, assertLegacyDatabase, fixtureClient, snapshotLegacyDatabase } from './p3-startup-fixture.mjs';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const onClose = () => { clearTimeout(timer); resolve(); };
    child.once('close', onClose);
    const timer = setTimeout(() => {
      child.off('close', onClose);
      reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function stopChild(child) {
  if (!child) return;
  child.kill();
  try { await waitForExit(child, 15_000); }
  catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child);
    throw error;
  }
}

function isolatedEnv(scratchDir) {
  const home = path.join(scratchDir, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_TOWER_') || key.startsWith('PRISMA_')) delete env[key];
  return env;
}

export async function verifyCliStartup(installedRoot, expectedVersion, scratchDir) {
  const env = isolatedEnv(scratchDir);
  const cliEntry = path.join(installedRoot, 'dist/cli.js');
  const versionCheck = spawnSync(process.execPath, [cliEntry, '--version'], {
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
  if (versionCheck.status !== 0) {
    throw new Error(`agent-tower --version failed: ${versionCheck.stderr || versionCheck.error?.message}`);
  }
  const reportedVersion = versionCheck.stdout.trim();
  if (reportedVersion !== expectedVersion) {
    throw new Error(`Unexpected CLI version: expected=${expectedVersion}, actual=${reportedVersion}`);
  }

  const port = await freePort();
  const dataDir = path.join(scratchDir, 'cli-data');
  const server = spawn(
    process.execPath,
    [
      cliEntry,
      '--port', String(port),
      '--host', '127.0.0.1',
      '--data-dir', dataDir,
      '--disable-access-password',
    ],
    { cwd: scratchDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverLog = '';
  server.stdout.on('data', chunk => { serverLog += chunk.toString(); });
  server.stderr.on('data', chunk => { serverLog += chunk.toString(); });

  let mcp;
  let mcpStdout = '';
  let mcpStderr = '';
  try {
    const deadline = Date.now() + 180_000;
    let lastError = 'no attempt';
    let healthy = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) {
        throw new Error(`agent-tower exited early with code ${server.exitCode}\n${serverLog.slice(-4000)}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok && (await response.json())?.status === 'ok') {
          healthy = true;
          break;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error.message;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!healthy) {
      throw new Error(`agent-tower never became healthy (last: ${lastError})\n${serverLog.slice(-4000)}`);
    }

    const indexResponse = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
    const indexHtml = await indexResponse.text();
    if (!indexResponse.ok || !indexHtml.includes('id="root"')) {
      throw new Error(`agent-tower did not serve the web UI (HTTP ${indexResponse.status})`);
    }

    const internalToken = readFileSync(path.join(dataDir, 'internal-api-token'), 'utf8').trim();
    if (!internalToken) throw new Error('agent-tower did not write an internal API token.');

    mcp = spawn(process.execPath, [path.join(installedRoot, 'dist/mcp/index.js')], {
      cwd: scratchDir,
      env: {
        ...env,
        AGENT_TOWER_PORT: String(port),
        AGENT_TOWER_INTERNAL_TOKEN: internalToken,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    mcp.stdout.on('data', chunk => { mcpStdout += chunk.toString(); });
    mcp.stderr.on('data', chunk => { mcpStderr += chunk.toString(); });
    mcp.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'publish-smoke', version: '1.0.0' },
      },
    })}\n`);

    const mcpDeadline = Date.now() + 60_000;
    let mcpServerName;
    while (Date.now() < mcpDeadline) {
      const line = mcpStdout.split(/\r?\n/).find(candidate => candidate.trim().startsWith('{'));
      if (line) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            mcpServerName = parsed.result?.serverInfo?.name;
            break;
          }
        } catch {
          // Wait for a complete line.
        }
      }
      if (mcp.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!mcpServerName) {
      throw new Error(`agent-tower-mcp initialize handshake failed\n${`${mcpStdout}\n${mcpStderr}`.slice(-2000)}`);
    }

    return `cli=${reportedVersion} health=ok web=ok mcp=${mcpServerName}`;
  } finally {
    mcp?.stdin.end();
    const stopped = await Promise.allSettled([stopChild(mcp), stopChild(server)]);
    for (const result of stopped) if (result.status === 'rejected') throw result.reason;
    if (server.exitCode !== 0) throw new Error(`CLI did not stop normally: ${server.exitCode}/${server.signalCode}`);
  }
}

/** Bounded old-db startup acceptance, reusable for npm and desktop runtimes. */
export async function verifyP3Startup(installedRoot, scratchDir, options = {}) {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const entryKind = options.entryKind ?? 'cli';
  const env = isolatedEnv(scratchDir);
  const dataDir = entryKind === 'cli' ? path.join(scratchDir, 'legacy-data') : path.join(env.HOME, '.agent-tower-dev');
  const dbPath = path.join(dataDir, 'data.db');
  for (const asset of ['dist/utils/database-schema.js', 'prisma/schema.prisma', 'prisma/migrations/20261016010000_add_message_deliveries/migration.sql']) {
    if (!existsSync(path.join(installedRoot, asset))) throw new Error(`Missing packaged P3 asset: ${asset}`);
  }
  const baseline = await seedLegacyDatabase(installedRoot, dbPath, scratchDir, nodeExecutable);
  let port;
  if (entryKind === 'cli') port = await freePort();
  else {
    const { getDevPort } = await import(pathToFileURL(path.join(installedRoot, 'node_modules/@agent-tower/shared/dist/dev-port.js')).href);
    port = getDevPort(path.resolve(installedRoot, '../..'));
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  }
  const args = entryKind === 'cli' ? [path.join(installedRoot, 'dist/cli.js'), '--port', String(port), '--host', '127.0.0.1', '--data-dir', dataDir]
    : entryKind === 'index-ts' ? ['--import', path.join(installedRoot, 'node_modules/tsx/dist/loader.mjs'), path.join(installedRoot, 'src/index.ts')]
      : [path.join(installedRoot, 'dist/index.js')];
  if (options.webDir) env.AGENT_TOWER_WEB_DIR = options.webDir;

  async function startCycle(expectFailure, cyclePort = port) {
    const cycleArgs = [...args];
    if (entryKind === 'cli') cycleArgs[cycleArgs.indexOf('--port') + 1] = String(cyclePort);
    const server = spawn(nodeExecutable, cycleArgs, { cwd: scratchDir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let logs = '';
    let spawnError;
    server.once('error', error => { spawnError = error; });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-16_000); });
    try {
      if (expectFailure) {
        await waitForExit(server, 40_000);
        if (server.exitCode !== 1 || !logs.includes(expectFailure) || /running on http|Server listening at|\[startup:onReady\]/.test(logs)) {
          throw new Error(`Expected startup rejection (${expectFailure}), got ${server.exitCode}/${server.signalCode}\n${logs}`);
        }
        return;
      }
      const deadline = Date.now() + 60_000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Startup exited early (${server.exitCode}/${server.signalCode})\n${logs}`);
        try {
          const response = await fetch(`http://127.0.0.1:${cyclePort}/api/health`, { signal: AbortSignal.timeout(1500) });
          if (response.ok && (await response.json()).status === 'ok') { healthy = true; break; }
        } catch { /* Wait within the bounded startup deadline. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!healthy) throw new Error(`Startup never became healthy\n${logs}`);
      await assertLegacyDatabase(installedRoot, dbPath, baseline);
      server.send({ type: 'agent-tower:shutdown' });
      await waitForExit(server, 15_000);
      if (server.exitCode !== 0 || !logs.includes('Server closed')) throw new Error(`Startup did not stop normally\n${logs}`);
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL');
        await waitForExit(server);
      }
    }
  }
  if (entryKind === 'cli') {
    const concurrent = await Promise.allSettled([startCycle(), startCycle(undefined, await freePort())]);
    for (const result of concurrent) if (result.status === 'rejected') throw result.reason;
  }
  await startCycle();
  await startCycle();
  const summary = await assertLegacyDatabase(installedRoot, dbPath, baseline);
  // A failing partial-upgrade fixture must not reach maintenance/recovery. Its
  // sentinel rows would be changed immediately if buildApp/onReady were run.
  if (options.checkFailure !== false) {
    const db = fixtureClient(installedRoot, dbPath);
    let sentinel;
    try {
      await db.$executeRawUnsafe('UPDATE AppSettings SET dataMigrationVersion=0');
      await db.$executeRawUnsafe('UPDATE Task SET title=?', 'long title '.repeat(50));
      await db.$executeRawUnsafe("UPDATE TranslationSource SET jobState='RUNNING'");
      await db.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
      await db.$executeRawUnsafe("UPDATE TranslationSource SET deliveryId='missing-delivery'");
      sentinel = await snapshotLegacyDatabase(db, baseline);
    } finally { await db.$disconnect(); }
    await startCycle('foreign_key_check failed');
    await assertLegacyValuesOnly(installedRoot, dbPath, sentinel);
  }
  return `entry=${entryKind} cycles=${entryKind === 'cli' ? '2-concurrent+2-serial' : '2'} health=ok shutdown=0 ${summary} rejection=${options.checkFailure === false ? 'skipped' : 'before-workers'}`;
}

async function assertLegacyValuesOnly(installedRoot, dbPath, baseline) {
  const db = fixtureClient(installedRoot, dbPath);
  try {
    if (JSON.stringify(await snapshotLegacyDatabase(db, baseline)) !== JSON.stringify(baseline)) throw new Error('Failed startup changed legacy data or ran recovery');
  } finally { await db.$disconnect(); }
}
