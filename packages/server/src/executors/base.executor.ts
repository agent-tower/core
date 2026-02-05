import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { AgentType, AgentAvailability, ExecutorConfig } from '../types/index.js';

export interface SpawnResult {
  pid: number;
  pty: IPty;
}

export abstract class BaseExecutor {
  abstract readonly agentType: AgentType;
  abstract readonly displayName: string;

  abstract checkAvailability(): Promise<AgentAvailability>;
  abstract getCommand(): string;
  abstract getArgs(config: ExecutorConfig): string[];

  async spawn(config: ExecutorConfig): Promise<SpawnResult> {
    const shell = pty.spawn(this.getCommand(), this.getArgs(config), {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: config.workingDir,
      env: { ...process.env, ...config.env } as Record<string, string>,
    });

    return { pid: shell.pid, pty: shell };
  }

  sendMessage(ptyInstance: IPty, message: string): void {
    ptyInstance.write(message + '\n');
  }
}
