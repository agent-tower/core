import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { describe, expect, it, vi } from 'vitest';
import { BaseExecutor, type ExecutorSpawnConfig, type SpawnedChild } from '../../executors/base.executor.js';
import { CommandBuilder } from '../../executors/command-builder.js';
import { ExecutionEnv } from '../../executors/execution-env.js';
import * as executors from '../../executors/index.js';
import { MsgStore } from '../../output/msg-store.js';
import { CliRuntimeDriver } from '../cli-driver.js';

/** Real wrapper/stdin ACK, no provider process or translator required. */
class ControlledExecutor extends BaseExecutor {
  readonly agentType = AgentType.CURSOR_AGENT;
  readonly displayName = 'Controlled';
  child?: SpawnedChild;
  received!: () => void;
  result = new Promise<void>(resolve => { this.received = resolve; });
  protected buildCommandBuilder() { return new CommandBuilder(process.execPath); }
  async getAvailabilityInfo() { return { type: 'INSTALLATION_FOUND' as const }; }
  override async spawn(config: ExecutorSpawnConfig) {
    const script = "process.stdin.once('data',()=>{process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'Done'})+'\\n');});process.stdin.on('end',()=>process.exit(0));";
    this.child = await this.spawnWithStdin(config, { program: process.execPath, args: ['-e', script] }, config.prompt);
    vi.spyOn(this.child.duplex!, 'end');
    const subscribe = this.child.duplex!.subscribe.bind(this.child.duplex);
    vi.spyOn(this.child.duplex!, 'subscribe').mockImplementation(listener => subscribe(event => {
      if (event.type === 'stdout' && event.data.includes('result')) this.received();
      listener(event);
    }));
    return this.child;
  }
}

describe('CLI user submission evidence', () => {
  it('uses BaseExecutor raw duplex ACK and closes stdin once when the result outruns durable confirmation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tower-cli-delivery-'));
    const executor = new ControlledExecutor();
    const factory = vi.spyOn(executors, 'getExecutor').mockReturnValue(executor);

    const session = await new CliRuntimeDriver().open({ towerSessionId: 'controlled-raw', agentType: AgentType.CURSOR_AGENT, runtimeType: RuntimeType.CLI, variant: 'DEFAULT', workingDir: directory, env: ExecutionEnv.default(directory) });
    const events: string[] = [];
    try {
      const handle = await session.runTurn({ turnId: 'controlled-turn', prompt: 'English user prose', msgStore: new MsgStore(), onSubmitting: async () => { events.push('writing'); }, onSubmitted: async () => { events.push('ack'); await executor.result; events.push('result'); events.push('confirmed'); } }, {
        process: async event => { if (event.type === 'started') events.push('started'); },
        stream: event => { if (event.type === 'stdout') events.push('stdout') },
      });
      await handle.completion;
      expect(events.indexOf('writing')).toBeGreaterThan(events.indexOf('started'));
      expect(events.indexOf('confirmed')).toBeGreaterThan(events.indexOf('result'));
      expect(executor.child!.inputMode).toBe('raw'); expect(executor.child!.duplex!.end).toHaveBeenCalledTimes(1);
    } finally { await session.close(); factory.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  }, 15000);
});
