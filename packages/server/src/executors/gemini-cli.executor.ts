import { BaseExecutor } from './base.executor.js';
import { AgentType, AgentAvailability, ExecutorConfig } from '../types/index.js';
import { execAsync } from '../utils/index.js';

export class GeminiCliExecutor extends BaseExecutor {
  readonly agentType = AgentType.GEMINI_CLI;
  readonly displayName = 'Gemini CLI';

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const { stdout } = await execAsync('gemini --version');
      return { available: true, version: stdout.trim() };
    } catch {
      return { available: false, error: 'Gemini CLI not installed' };
    }
  }

  getCommand(): string {
    return 'gemini';
  }

  getArgs(config: ExecutorConfig): string[] {
    return [config.prompt];
  }
}
