/** Bounded native smoke through the actual executor/coordinator, with a private temporary Codex home. */
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from '../packages/server/node_modules/smol-toml/dist/index.js';
import { AgentType, RuntimeType, type Provider } from '../packages/shared/src/types.js';
import { RuntimeCoordinator } from '../packages/server/src/runtime/runtime-coordinator.js';
import { CliRuntimeDriver } from '../packages/server/src/runtime/cli-driver.js';
import { ExecutionEnv } from '../packages/server/src/executors/execution-env.js';
import { MsgStore } from '../packages/server/src/output/msg-store.js';
import { ExecutionPermissionService } from '../packages/server/src/services/execution-permission.service.js';
import type { RuntimeProcessEvent } from '../packages/server/src/runtime/contracts.js';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tower-codex-ask-smoke-'));
  // This target must be outside both cwd and the native sandbox's default temporary writable roots.
  const outside = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.codex-ask-smoke-'));
  const home = path.join(root, 'codex'); const workingDir = path.join(root, 'work');
  const processes: RuntimeProcessEvent[] = [];
  const coordinator = new RuntimeCoordinator({ get: () => new CliRuntimeDriver() }, {
    onTurnEvent: () => {}, onRuntimeState: () => {}, onProcessEvent: async e => { processes.push(e); },
  });
  try {
    await mkdir(home, { mode: 0o700 }); await mkdir(workingDir);
    const originalHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const config = parse(await readFile(path.join(originalHome, 'config.toml'), 'utf8'));
    const connection: Record<string, any> = {};
    for (const key of ['model', 'model_provider', 'model_providers']) if (config[key] !== undefined) connection[key] = config[key];
    if (process.env.TOWER_CODEX_SMOKE_MODEL) connection.model = process.env.TOWER_CODEX_SMOKE_MODEL;
    await writeFile(path.join(home, 'config.toml'), stringify(connection), { mode: 0o600 });
    await copyFile(path.join(originalHome, 'auth.json'), path.join(home, 'auth.json'));
    await chmod(path.join(home, 'auth.json'), 0o600);
    const provider: Provider = { id: 'native-smoke', name: 'Native smoke', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      executionPermission: 'ASK', env: { CODEX_HOME: home }, config: {}, settings: stringify(connection), isDefault: false };
    const permissions = new ExecutionPermissionService(); await permissions.prepare(); permissions.authorize(provider);
    const env = ExecutionEnv.default(workingDir).set('CODEX_HOME', home);
    // Seed the native history through the unchanged exec FULL_ACCESS path, then restore it as ASK.
    const seed = await coordinator.startTurn({ towerSessionId: 'smoke', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      providerSnapshot: { ...provider, executionPermission: 'FULL_ACCESS' }, executionPermission: 'FULL_ACCESS', workingDir, env,
      variant: 'DEFAULT', prompt: 'Reply READY. Do not run tools.', msgStore: new MsgStore(), launchClaimNumber: 1 });
    let seedTimer: NodeJS.Timeout | undefined;
    try { await Promise.race([seed.completion, new Promise((_, reject) => { seedTimer = setTimeout(() => reject(new Error('Seed model deadline exceeded.')), 60000); })]); }
    finally { if (seedTimer) clearTimeout(seedTimer); }
    let nativeId = coordinator.getState('smoke').externalSessionId;
    if (!nativeId) throw new Error('FULL_ACCESS exec did not preserve the native thread ID.');
    const seedDeadline = Date.now() + 12000;
    while (!processes.some(e => e.type === 'tree_cleanup_completed') && Date.now() < seedDeadline) await new Promise(r => setTimeout(r, 25));
    if (!processes.some(e => e.type === 'tree_cleanup_completed')) throw new Error('FULL_ACCESS seed cleanup was not confirmed.');
    const decisions = process.env.TOWER_CODEX_SMOKE_STOP_ONLY === '1' ? [] : ['allow_once', 'reject_once', 'allow_once', 'reject_once'];
    for (const [index, optionId] of decisions.entries()) {
      const target = path.join(index >= 2 ? outside : root, `action-${index}.txt`);
      const prompt = index >= 2
        ? `Use apply_patch exactly once to create ${target} with content approved. This is outside cwd. Do not use another tool; if denied, stop. Do not retry.`
        : `Use exec_command exactly once with sandbox_permissions=require_escalated and justification="Temporary approval smoke" to run: printf approved > ${target}. If denied, do not retry or use another tool. Stop afterwards.`;
      const msgStore = new MsgStore();
      const handle = await coordinator.startTurn({ towerSessionId: 'smoke', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
        providerSnapshot: provider, executionPermission: 'ASK', workingDir, env, variant: 'DEFAULT', prompt, msgStore,
        launchClaimNumber: index + 2, resumeExternalSessionId: nativeId });
      let done = false; let failure: unknown;
      void handle.completion.then(() => { done = true; }, e => { done = true; failure = e; });
      let answered = false; const deadline = Date.now() + 60000;
      while (!done && Date.now() < deadline) {
        const request = coordinator.getState('smoke').pendingPermissions[0];
        if (request) {
          if (answered) throw new Error('Model attempted another action after the single smoke action.');
          if (await access(target).then(() => true, () => false)) throw new Error('Action executed before approval.');
          await coordinator.resolvePermission('smoke', request.requestId, optionId, () => permissions.authorizeMode('ASK', { agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI }));
          answered = true;
        }
        await new Promise(r => setTimeout(r, 25));
      }
      if (!done) throw new Error('Native model smoke exceeded the 60s turn deadline.');
      if (failure) throw failure;
      if (!answered) throw new Error('Native model did not request approval for this smoke action.');
      const created = await access(target).then(() => true, () => false);
      if (created !== (optionId === 'allow_once')) throw new Error('Native action result did not match the decision.');
      nativeId = coordinator.getState('smoke').externalSessionId;
      if (!nativeId) throw new Error('Native thread ID was not preserved.');
      const cleanupDeadline = Date.now() + 12000;
      while (processes.filter(e => e.type === 'tree_cleanup_completed').length < index + 2 && Date.now() < cleanupDeadline) await new Promise(r => setTimeout(r, 25));
      if (processes.filter(e => e.type === 'tree_cleanup_completed').length !== index + 2) throw new Error('Native launch tree cleanup was not confirmed.');
      console.log(JSON.stringify({ round: index + 1, resumed: true, restoredFrom: index === 0 ? 'FULL_ACCESS exec' : 'ASK app-server', action: index >= 2 ? 'fileChange' : 'commandExecution', optionId,
        mode: coordinator.getState('smoke').executionPermission, created, usage: msgStore.getSnapshot().entries.some(e => e.entryType === 'token_usage_info'), treeCleaned: true }));
    }
    if (process.env.TOWER_CODEX_SMOKE_STOP === '1') {
      const waitFor = async (condition: () => boolean, ms = 60000, code = 'SMOKE_CANCEL_DEADLINE') => {
        const deadline = Date.now() + ms;
        while (!condition() && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
        if (!condition()) throw Object.assign(new Error('Native cancellation smoke deadline exceeded.'), { code });
      };
      for (const [index, phase] of ['pending', 'running'].entries()) {
        const target = path.join(root, `cancel-${phase}.txt`); const marker = path.join(workingDir, `running-${phase}.txt`); const store = new MsgStore();
        const input = { towerSessionId: 'smoke', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
          providerSnapshot: provider, executionPermission: 'ASK' as const, workingDir, env, variant: 'DEFAULT',
          msgStore: store, resumeExternalSessionId: nativeId, launchClaimNumber: 6 + index * 2,
          prompt: `Use exec_command exactly once with sandbox_permissions=require_escalated and justification="Cancellation smoke" to run: printf RUNNING > ${marker}; sleep 30; printf executed > ${target}. Do not retry or use another tool.` };
        const old = await coordinator.startTurn(input); void old.completion.catch(() => {});
        await waitFor(() => coordinator.getState('smoke').pendingPermissions.length > 0, 60000, 'SMOKE_CANCEL_NO_APPROVAL');
        const request = coordinator.getState('smoke').pendingPermissions[0]!;
        const launch = processes.filter(e => e.type === 'started').at(-1)!;
        if (phase === 'running') {
          await coordinator.resolvePermission('smoke', request.requestId, 'allow_once');
          // Observe the actual command's first filesystem effect, independent of
          // native stdout buffering. The final effect must still be absent.
          const deadline = Date.now() + 12000;
          while (!(await access(marker).then(() => true, () => false)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
          if (!(await access(marker).then(() => true, () => false))) throw Object.assign(new Error('Approved command did not start.'), { code: 'SMOKE_CANCEL_NO_RUNNING_ACTION' });
        }
        await coordinator.cancelTurn('smoke');
        const replacement = await coordinator.startTurn({ ...input, launchClaimNumber: input.launchClaimNumber + 1,
          msgStore: new MsgStore(), prompt: 'Reply STOPPED. Do not call tools.' });
        let done = false; let failure: unknown;
        void replacement.completion.then(() => { done = true; }, e => { done = true; failure = e; });
        await waitFor(() => done); if (failure) throw failure;
        const cleanIndex = processes.findIndex(e => e.type === 'tree_cleanup_completed' && e.runtimeInstanceId === launch.runtimeInstanceId);
        const nextLaunch = processes.filter(e => e.type === 'started').at(-1)!;
        if (cleanIndex < 0 || cleanIndex >= processes.indexOf(nextLaunch)) throw new Error('Replacement began before actual tree cleanup.');
        if (await access(target).then(() => true, () => false)) throw new Error('Cancelled action executed.');
        await coordinator.resolvePermission('smoke', request.requestId, 'allow_once').then(() => { throw new Error('Old approval remained active.'); }, e => { if (e.code !== 'permission_not_found') throw e; });
        await waitFor(() => processes.some(e => e.type === 'tree_cleanup_completed' && e.runtimeInstanceId === nextLaunch.runtimeInstanceId), 12000);
        nativeId = coordinator.getState('smoke').externalSessionId;
        console.log(JSON.stringify({ cancelled: phase, replacementMode: coordinator.getState('smoke').executionPermission, oldActionExecuted: false, oldTreeCleanedBeforeReplacement: true }));
      }
    }
  } finally {
    // A cleanup failure keeps the evidence/directories intact; it is never represented as success.
    await coordinator.destroyAll();
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(JSON.stringify({ code: e.code ?? 'SMOKE_FAILED' })); console.error('Codex CLI ASK smoke failed. Temporary state is removed only after verified process cleanup.'); process.exitCode = 1; });
