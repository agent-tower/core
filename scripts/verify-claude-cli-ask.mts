/** Bounded native smoke. No server, global settings writes, or existing Tower data. */
import { mkdtemp, mkdir, readFile, rm, access, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const artifactDir = fileURLToPath(new URL('../artifacts/claude-cli-ask/', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'tower-claude-runtime-smoke-'));
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(root, 'smoke.db')}`;
const { AgentType, RuntimeType } = await import('../packages/shared/src/types.js');
const { ExecutionEnv } = await import('../packages/server/src/executors/execution-env.js');
const { ExecutionPermissionService } = await import('../packages/server/src/services/execution-permission.service.js');
const { CliRuntimeDriver } = await import('../packages/server/src/runtime/cli-driver.js');
const { RuntimeCoordinator } = await import('../packages/server/src/runtime/runtime-coordinator.js');
const { MsgStore } = await import('../packages/server/src/output/msg-store.js');
const workspace = path.join(root, 'workspace'); const config = path.join(root, 'claude');
await mkdir(workspace); await mkdir(config);
const sourceFile = process.argv[2];
const auth: Record<string, string> = {};
if (sourceFile) {
  const source = JSON.parse((await readFile(sourceFile, 'utf8')).replace(/,\s*([}\]])/g, '$1'));
  for (const [key, value] of Object.entries(source.env ?? {})) if (key.startsWith('ANTHROPIC_') && typeof value === 'string') auth[key] = value;
}
const provider = { id: 'isolated-smoke', name: 'Smoke', agentType: AgentType.CLAUDE_CODE, runtimeType: RuntimeType.CLI,
  executionPermission: 'ASK' as const, config: {}, env: { ...auth, CLAUDE_CONFIG_DIR: config }, isDefault: false,
  settings: JSON.stringify({ permissions: { defaultMode: 'default', ask: ['Bash'] } }),
};
const permissions = new ExecutionPermissionService();
const report: any = { kind: 'Tower Executor/owned wrapper/Driver/Coordinator native smoke', runs: [], cleanupConfirmed: false };
let choice = 'reject_once'; let deadline: NodeJS.Timeout | undefined;
const processEvents: any[] = []; const answers: Promise<void>[] = [];
const coordinator = new RuntimeCoordinator({ get: () => new CliRuntimeDriver() }, {
  onRuntimeState: () => {}, onProcessEvent: async event => { processEvents.push(event); },
  onTurnEvent: envelope => {
    if (envelope.event.type === 'permission_requested') {
      const request = envelope.event.request;
      const state = coordinator.getState(envelope.towerSessionId);
      assert.equal(state.turnState, 'AWAITING_PERMISSION'); assert.equal(state.executionPermission, 'ASK');
      assert.equal(state.pendingPermissions.some(p => p.requestId === request.requestId), true);
      const row = report.runs.at(-1); row.approvalRequests++; row.restRecoveryView = true;
      permissions.authorizeMode(state.executionPermission!, { agentType: provider.agentType, runtimeType: state.runtimeType, sessionId: 'smoke' });
      answers.push(coordinator.resolvePermission(envelope.towerSessionId, request.requestId, choice));
    }
  },
});
async function waitForTree(count: number) {
  const end = Date.now() + 9000;
  while (processEvents.filter(e => e.type === 'tree_cleanup_completed').length < count && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  assert.equal(processEvents.filter(e => e.type === 'tree_cleanup_completed').length, count);
}
try {
  await permissions.prepare();
  permissions.authorize(provider, 'smoke');
  let session: string | undefined;
  for (const [index, option] of ['reject_once', 'allow_once'].entries()) {
    choice = option; const filename = option === 'allow_once' ? 'approved.txt' : 'denied.txt';
    const row = { choice, resume: !!session, approvalRequests: 0, completed: false, fileExists: false }; report.runs.push(row);
    const input = { towerSessionId: 'smoke', agentType: provider.agentType, runtimeType: RuntimeType.CLI, providerSnapshot: provider, executionPermission: 'ASK' as const,
      variant: 'DEFAULT', workingDir: workspace, env: ExecutionEnv.default(workspace), msgStore: new MsgStore(), launchClaimNumber: index + 1,
      resumeExternalSessionId: session,
      prompt: `Use Bash exactly once to execute: printf tower_smoke > ${filename}. Do not use any other tool or command. If permission is denied, stop and report denial. Do not retry.`,
    };
    // Executor applies the Provider env after admission, exactly as a real Session launch does.
    input.env.merge(provider.env);
    const timeout = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Native smoke deadline exceeded')), 80_000); });
    const handle = await Promise.race([coordinator.startTurn(input), timeout]);
    await Promise.race([handle.completion, timeout]); if (deadline) clearTimeout(deadline);
    await Promise.all(answers.splice(0)); row.completed = true;
    row.fileExists = await access(path.join(workspace, filename)).then(() => true, () => false);
    assert.equal(row.fileExists, option === 'allow_once'); assert.ok(row.approvalRequests > 0);
    session = coordinator.getState('smoke').externalSessionId ?? undefined;
    await waitForTree(index + 1);
    console.log(JSON.stringify(row));
  }
  const historical = { ...provider, executionPermission: 'FULL_ACCESS' as const, settings: JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }) };
  permissions.authorize(historical, 'history');
  const historyInput = { towerSessionId: 'history', agentType: provider.agentType, runtimeType: RuntimeType.CLI, variant: 'DEFAULT', workingDir: workspace,
    env: ExecutionEnv.default(workspace).merge(provider.env), msgStore: new MsgStore(), providerSnapshot: historical, executionPermission: 'FULL_ACCESS' as const,
    prompt: 'Reply exactly SMOKE_READY. Do not use any tools.', launchClaimNumber: 1 };
  const timeout = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Historical resume smoke deadline exceeded')), 80_000); });
  const seed = await Promise.race([coordinator.startTurn(historyInput), timeout]); await Promise.race([seed.completion, timeout]);
  await waitForTree(3);
  const nativeHistory = coordinator.getState('history').externalSessionId;
  assert.ok(nativeHistory);
  choice = 'reject_once';
  const historyRow = { choice, resume: true, fullToAsk: true, approvalRequests: 0, completed: false, fileExists: false }; report.runs.push(historyRow);
  const restricted = await Promise.race([coordinator.startTurn({ ...historyInput, providerSnapshot: provider, executionPermission: 'ASK', launchClaimNumber: 2,
    resumeExternalSessionId: nativeHistory, prompt: 'Use Bash exactly once: printf should_not_run > historical-denied.txt. If permission is denied, stop and report denial. Do not retry or use other tools.' }), timeout]);
  await Promise.race([restricted.completion, timeout]); if (deadline) clearTimeout(deadline);
  await Promise.all(answers.splice(0)); await waitForTree(4);
  historyRow.completed = true; historyRow.fileExists = await access(path.join(workspace, 'historical-denied.txt')).then(() => true, () => false);
  assert.ok(historyRow.approvalRequests > 0); assert.equal(historyRow.fileExists, false);
  console.log(JSON.stringify(historyRow));
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (deadline) clearTimeout(deadline);
  await coordinator.destroyAll();
  report.cleanupConfirmed = processEvents.filter(e => e.type === 'started').length === processEvents.filter(e => e.type === 'tree_cleanup_completed').length;
  await rm(root, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'tower-smoke.json'), JSON.stringify(report, null, 2) + '\n');
}
