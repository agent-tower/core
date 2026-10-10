/** Bounded native smoke for Codex CLI auto-review through the owned Tower driver. */
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { parse, stringify } from '../packages/server/node_modules/smol-toml/dist/index.js';
import { AgentType, RuntimeType, type ExecutionPermissionMode, type Provider } from '../packages/shared/src/types.js';
import { RuntimeCoordinator } from '../packages/server/src/runtime/runtime-coordinator.js';
import { CliRuntimeDriver } from '../packages/server/src/runtime/cli-driver.js';
import { ExecutionEnv } from '../packages/server/src/executors/execution-env.js';
import { MsgStore } from '../packages/server/src/output/msg-store.js';
import { ExecutionPermissionService } from '../packages/server/src/services/execution-permission.service.js';
import type { RuntimeProcessEvent } from '../packages/server/src/runtime/contracts.js';

const waitFor = async (condition: () => boolean, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!condition()) throw new Error('Native smoke deadline exceeded.');
};
const exists = (file: string) => access(file).then(() => true, () => false);

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tower-codex-auto-smoke-'));
  // The sandbox also permits OS temporary roots, so place this target in the repository.
  const outside = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.codex-auto-smoke-'));
  const home = path.join(root, 'codex'); const workingDir = path.join(root, 'work');
  const processes: RuntimeProcessEvent[] = [];
  const coordinator = new RuntimeCoordinator({ get: () => new CliRuntimeDriver() }, {
    onTurnEvent: () => {}, onRuntimeState: () => {}, onProcessEvent: async event => { processes.push(event); },
  });
  try {
    await mkdir(home, { mode: 0o700 }); await mkdir(workingDir);
    const sourceHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const original = parse(await readFile(path.join(sourceHome, 'config.toml'), 'utf8'));
    const connection: Record<string, unknown> = {};
    for (const key of ['model_provider', 'model_providers']) if (original[key] !== undefined) connection[key] = original[key];
    connection.model = 'gpt-6-sol';
    await writeFile(path.join(home, 'config.toml'), stringify({ ...connection,
      sandbox_workspace_write: { writable_roots: [outside], network_access: true },
    }), { mode: 0o600 });
    await copyFile(path.join(sourceHome, 'auth.json'), path.join(home, 'auth.json'));
    await chmod(path.join(home, 'auth.json'), 0o600);
    const provider: Provider = { id: 'auto-smoke', name: 'Native auto-review smoke', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      executionPermission: 'AUTO_SANDBOX', env: { CODEX_HOME: home }, config: { model: 'gpt-6-sol' }, settings: stringify(connection), isDefault: false };
    const permissions = new ExecutionPermissionService(); await permissions.prepare();
    permissions.authorize(provider);
    const env = ExecutionEnv.default(workingDir).set('CODEX_HOME', home);
    let nativeThread: string | undefined;
    let claim = 0;

    async function turn(mode: ExecutionPermissionMode, prompt: string, target?: string, expected?: boolean, allowHumanRequest = false) {
      const launchClaimNumber = ++claim;
      const store = new MsgStore();
      const snapshot = { ...provider, executionPermission: mode };
      permissions.authorize(snapshot);
      const handle = await coordinator.startTurn({ towerSessionId: 'smoke', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
        providerSnapshot: snapshot, executionPermission: mode, workingDir, env, variant: 'DEFAULT', prompt, msgStore: store,
        launchClaimNumber, resumeExternalSessionId: nativeThread });
      let completed = false; let failure: unknown;
      void handle.completion.then(() => { completed = true; }, error => { completed = true; failure = error; });
      await waitFor(() => completed || coordinator.getState('smoke').pendingPermissions.length > 0);
      let humanRequest: string | undefined;
      if (coordinator.getState('smoke').pendingPermissions.length > 0) {
        const request = coordinator.getState('smoke').pendingPermissions[0]!;
        await coordinator.resolvePermission('smoke', request.requestId, 'reject_once');
        humanRequest = request.toolName;
        if (!allowHumanRequest) throw new Error(`Unexpected remaining human approval during ${mode} smoke: ${request.toolName}`);
        await waitFor(() => completed);
      }
      if (failure) throw failure;
      if (target && await exists(target) !== expected) throw new Error(`${mode} action did not match the expected native result.`);
      const nextThread = coordinator.getState('smoke').externalSessionId;
      if (!nextThread || (nativeThread && nextThread !== nativeThread)) throw new Error('Codex native thread was not preserved.');
      nativeThread = nextThread;
      const started = processes.find(event => event.type === 'started' && event.launchClaimNumber === launchClaimNumber);
      if (!started) throw new Error('Native launch ownership was not recorded.');
      await waitFor(() => processes.some(event => event.type === 'tree_cleanup_completed' && event.runtimeInstanceId === started.runtimeInstanceId), 12_000);
      const applied = coordinator.getState('smoke').executionPermission;
      if (mode !== 'FULL_ACCESS' && applied !== mode) throw new Error('Confirmed execution mode differs from the authorized mode.');
      const usage = store.getSnapshot().entries.some(entry => entry.entryType === 'token_usage_info');
      if (mode === 'AUTO_SANDBOX' && !usage) throw new Error('Codex auto-review turn did not preserve usage.');
      console.log(JSON.stringify({ mode, resumed: launchClaimNumber > 1, created: target ? await exists(target) : undefined,
        usage, nativeThreadPreserved: true, treeCleaned: true, ...(humanRequest ? { humanRequestRejected: humanRequest } : {}) }));
    }

    const inside = path.join(workingDir, 'inside.txt');
    await turn('AUTO_SANDBOX', `Use exec_command exactly once to run: printf inside > ${inside}. Then stop.`, inside, true);
    await turn('ASK', 'Reply ASK_READY. Do not run tools.');
    const escaped = path.join(outside, 'auto-approved.txt');
    await turn('AUTO_SANDBOX', `Use exec_command exactly once with sandbox_permissions=require_escalated and justification="Temporary native auto-review smoke" to run: printf approved > ${escaped}. This is a harmless disposable file. If denied, do not retry. Then stop.`, escaped, true);
    let networkReached = false;
    const server = createServer((_request, response) => { networkReached = true; response.end('local-smoke'); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback probe did not bind.');
      await turn('AUTO_SANDBOX', `Use exec_command exactly once with sandbox_permissions=require_escalated and justification="Temporary loopback network smoke" to run: curl --max-time 5 http://127.0.0.1:${address.port}/health. If denied, do not retry. Then stop.`, undefined, undefined, true);
      console.log(JSON.stringify({ networkProbe: 'loopback', reached: networkReached }));
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    await turn('AUTO_SANDBOX', 'Use exec_command exactly once with sandbox_permissions=require_escalated and justification="Harmless administrative capability check" to run: sudo -n true. Do not retry. Then stop.', undefined, undefined, true);
    const marker = path.join(workingDir, 'running.txt'); const final = path.join(workingDir, 'should-not-exist.txt');
    const oldClaim = ++claim;
    const old = await coordinator.startTurn({ towerSessionId: 'smoke', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      providerSnapshot: provider, executionPermission: 'AUTO_SANDBOX', workingDir, env, variant: 'DEFAULT',
      prompt: `Use exec_command exactly once to run: printf running > ${marker}; sleep 30; printf finished > ${final}. Do not retry.`,
      msgStore: new MsgStore(), launchClaimNumber: oldClaim, resumeExternalSessionId: nativeThread });
    void old.completion.catch(() => {});
    await waitFor(() => processes.some(event => event.type === 'started' && event.launchClaimNumber === oldClaim) && coordinator.getState('smoke').turnState === 'RUNNING');
    const markerDeadline = Date.now() + 60_000;
    while (!(await exists(marker)) && Date.now() < markerDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!(await exists(marker))) throw new Error('The cancellable native command did not start.');
    const oldStart = processes.find(event => event.type === 'started' && event.launchClaimNumber === oldClaim)!;
    await coordinator.cancelTurn('smoke');
    const replacement = await coordinator.startTurn({ towerSessionId: 'smoke', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      providerSnapshot: { ...provider, executionPermission: 'ASK' }, executionPermission: 'ASK', workingDir, env,
      variant: 'DEFAULT', prompt: 'Reply STOPPED. Do not run tools.', msgStore: new MsgStore(),
      launchClaimNumber: ++claim, resumeExternalSessionId: nativeThread });
    let replacementDone = false; let replacementFailure: unknown;
    void replacement.completion.then(() => { replacementDone = true; }, error => { replacementDone = true; replacementFailure = error; });
    await waitFor(() => replacementDone);
    if (replacementFailure) throw replacementFailure;
    const oldClean = processes.findIndex(event => event.type === 'tree_cleanup_completed' && event.runtimeInstanceId === oldStart.runtimeInstanceId);
    const nextStart = processes.findIndex(event => event.type === 'started' && event.launchClaimNumber === claim);
    if (oldClean < 0 || nextStart <= oldClean || await exists(final)) throw new Error('Cancellation did not preserve the cleanup boundary.');
    const newStart = processes[nextStart]!;
    await waitFor(() => processes.some(event => event.type === 'tree_cleanup_completed' && event.runtimeInstanceId === newStart.runtimeInstanceId), 12_000);
    console.log(JSON.stringify({ cancelled: 'AUTO_SANDBOX running', replacement: 'ASK', oldTreeCleanedBeforeNewStarted: true, oldActionExecuted: false }));
    await turn('FULL_ACCESS', 'Reply FULL_READY. Do not run tools.');
    try {
      await turn('AUTO_SANDBOX', 'Reply AUTO_READY. Do not run tools.');
      throw new Error('AUTO resume unexpectedly accepted an unconfirmed sandbox boundary.');
    } catch (error) {
      if ((error as { code?: string }).code !== 'permission_mode_unconfirmed') throw error;
      console.log(JSON.stringify({ resumedFromFullAccess: true, unconfirmedSandboxRefusedBeforeTask: true }));
    }
  } finally {
    await coordinator.destroyAll();
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(JSON.stringify({ code: error.code ?? 'SMOKE_FAILED', message: error.message })); process.exitCode = 1; });
