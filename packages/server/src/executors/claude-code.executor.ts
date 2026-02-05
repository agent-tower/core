import { BaseExecutor } from './base.executor.js';
import { AgentType, AgentAvailability, ExecutorConfig } from '../types/index.js';
import { execAsync } from '../utils/index.js';

export class ClaudeCodeExecutor extends BaseExecutor {
  readonly agentType = AgentType.CLAUDE_CODE;
  readonly displayName = 'Claude Code';

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const { stdout } = await execAsync('claude --version');
      return { available: true, version: stdout.trim() };
    } catch {
      return { available: false, error: 'Claude Code CLI not installed' };
    }
  }

  getCommand(): string {
    return 'claude';
  }

  getArgs(config: ExecutorConfig): string[] {
    return ['--print', config.prompt];
  }
}
