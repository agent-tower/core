import type { FastifyInstance } from 'fastify';
import { AgentType } from '../types/index.js';

export async function systemRoutes(app: FastifyInstance) {
  // 健康检查
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // 获取可用的 AI 代理列表
  app.get('/agents', async () => {
    return {
      agents: [
        { type: AgentType.CLAUDE_CODE, name: 'Claude Code', available: false },
        { type: AgentType.GEMINI_CLI, name: 'Gemini CLI', available: false },
      ],
    };
  });
}
