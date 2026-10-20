import { GeminiParser } from '../output/gemini-parser.js';
import { AgentType } from '../types/index.js';
import {
  createClaudeCodeParser,
  createCodexParser,
  createCursorAgentParser,
  type MsgStore,
} from '../output/index.js';
import type { OutputParser } from '../pipeline/agent-pipeline.js';

export function createCliParser(
  agentType: AgentType,
  workingDir: string,
  msgStore: MsgStore,
  control?: { message(value: unknown): void; failed(error: unknown): void },
): OutputParser | null {
  if (agentType === AgentType.CLAUDE_CODE) {
    return createClaudeCodeParser(msgStore, control);
  }
  if (agentType === AgentType.CURSOR_AGENT) {
    return createCursorAgentParser(msgStore, workingDir);
  }
  if (agentType === AgentType.CODEX) {
    return createCodexParser(msgStore);
  }
  if (agentType === AgentType.GEMINI_CLI) return new GeminiParser(msgStore);
  return null;
}
