/** Bounded native argument parsing only; never initializes a model or starts an Agent session.
 * Usage: pnpm --filter @agent-tower/server exec tsx ../../scripts/verify-gemini-permission-args.mts <installed @google/gemini-cli directory>
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentType, RuntimeType } from '../packages/shared/src/index.js';
import { createExecutorFromProvider } from '../packages/server/src/executors/index.js';
import { ExecutionEnv } from '../packages/server/src/executors/execution-env.js';
import type { CommandParts } from '../packages/server/src/executors/command-builder.js';

const nativeRoot = process.argv[2];
assert(nativeRoot, 'Pass an installed Gemini CLI package directory.');
const version = JSON.parse(readFileSync(path.join(nativeRoot, 'package.json'), 'utf8')).version;
const parserUrl = pathToFileURL(path.resolve(nativeRoot, 'dist/src/config/config.js')).href;
const parserCode = `
  import assert from 'node:assert/strict';
  const parser = await import(process.argv[1]);
  process.argv = [process.execPath, 'gemini', ...JSON.parse(process.argv[2])];
  const args = await parser.parseArguments({});
  assert.equal(args.approvalMode, 'yolo');
  assert.equal(args.sandbox, false);
  console.log('native parser accepted');
`;
const parse = (args: string[]) => execFileSync(process.execPath,
  ['--input-type=module', '-e', parserCode, parserUrl, JSON.stringify(args)],
  { timeout: 10_000, maxBuffer: 64 * 1024, stdio: 'pipe' });

for (const [label, permission] of [
  ['canonical', { executionPermission: 'FULL_ACCESS' as const, config: {} }],
  ['canonical with matching legacy flag', { executionPermission: 'FULL_ACCESS' as const, config: { yolo: true } }],
  ['legacy yolo', { config: { yolo: true } }],
] as const) {
  const executor = createExecutorFromProvider({
    id: 'gemini-parameter-check', name: 'Parameter check', agentType: AgentType.GEMINI_CLI,
    runtimeType: RuntimeType.CLI, ...permission, env: {}, isDefault: false,
  });
  const commands: CommandParts[] = [];
  // Capture the final command at the same boundary used by both spawn paths, without creating a PTY.
  (executor as unknown as { spawnWithStdin: (...args: unknown[]) => Promise<unknown> }).spawnWithStdin = async (_input, command) => {
    commands.push(command as CommandParts);
    return {};
  };
  const input = { workingDir: os.tmpdir(), prompt: '', env: ExecutionEnv.default(os.tmpdir()) };
  await executor.spawn(input);
  await executor.spawnFollowUp(input, 'latest');
  for (const [index, command] of commands.entries()) {
    assert.equal(command.program, 'npx');
    assert.deepEqual(command.args.slice(0, 2), ['-y', '@google/gemini-cli@0.23.0']);
    const nativeArgs = command.args.slice(2);
    parse(nativeArgs);
    console.log(JSON.stringify({ version, label, turn: index === 0 ? 'initial' : 'follow-up', command, result: 'accepted' }));
    // Control: the original double projection must still be rejected by the native parser.
    assert.throws(() => parse([...nativeArgs, '--yolo']), (error: unknown) => {
      const failure = error as { status?: number; stderr?: Buffer };
      return failure.status === 1 && String(failure.stderr).includes('Cannot use both --yolo');
    });
  }
}
