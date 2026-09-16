/**
 * Install-level CLI startup verification for a freshly installed Agent Tower.
 *
 * The package-content checks in `smoke-publish-install.mjs` only import a
 * utility module. That is how a tree which npm left full of empty directories
 * once passed the smoke test while the real `agent-tower` CLI crashed on
 * startup, so booting the CLI is verified for real here.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

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
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('close', resolve);
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
}

export async function verifyCliStartup(installedRoot, expectedVersion, scratchDir) {
  const cliEntry = path.join(installedRoot, 'dist/cli.js');
  const versionCheck = spawnSync(process.execPath, [cliEntry, '--version'], {
    encoding: 'utf8',
    timeout: 60_000,
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
    { cwd: scratchDir, stdio: ['ignore', 'pipe', 'pipe'] },
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
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
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

    const indexResponse = await fetch(`http://127.0.0.1:${port}/`);
    const indexHtml = await indexResponse.text();
    if (!indexResponse.ok || !indexHtml.includes('id="root"')) {
      throw new Error(`agent-tower did not serve the web UI (HTTP ${indexResponse.status})`);
    }

    const internalToken = readFileSync(path.join(dataDir, 'internal-api-token'), 'utf8').trim();
    if (!internalToken) throw new Error('agent-tower did not write an internal API token.');

    mcp = spawn(process.execPath, [path.join(installedRoot, 'dist/mcp/index.js')], {
      cwd: scratchDir,
      env: {
        ...process.env,
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
    if (mcp) {
      mcp.stdin.end();
      mcp.kill();
      await waitForExit(mcp);
    }
    server.kill();
    await waitForExit(server);
  }
}
