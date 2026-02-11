import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IPty } from 'node-pty';
import { AgentType } from '../types/index.js';
import { getExecutor, getAllExecutorsAvailability, ExecutionEnv } from '../executors/index.js';
import { sessionMsgStoreManager, createClaudeCodeParser, createCursorAgentParser } from '../output/index.js';

// Debug 日志开关
const DEBUG_DEMO = process.env.DEBUG_DEMO === 'true';

const startDemoSchema = z.object({
  agentType: z.nativeEnum(AgentType),
  prompt: z.string().min(1),
  workingDir: z.string().optional(),
  variant: z.string().optional(),
});

const sendMessageSchema = z.object({
  message: z.string().min(1),
});

// 简单的内存存储，用于 MVP 演示
const demoSessions = new Map<string, { agentType: AgentType; status: string }>();
const demoPtys = new Map<string, IPty>();

export async function demoRoutes(app: FastifyInstance) {
  // 快速启动 demo 会话（跳过 workspace/task 创建）
  app.post('/demo/start', async (request, reply) => {
    const body = startDemoSchema.parse(request.body);

    const executor = getExecutor(body.agentType, body.variant);
    if (!executor) {
      reply.code(400);
      return { error: `Unsupported agent type: ${body.agentType}` };
    }

    // 检查可用性
    const availability = await executor.getAvailabilityInfo();
    if (availability.type === 'NOT_FOUND') {
      reply.code(400);
      return { error: `Agent not available: ${availability.error || 'Not installed'}` };
    }

    // 生成简单的 session ID
    const sessionId = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const workingDir = body.workingDir || process.cwd();
      const env = ExecutionEnv.default(workingDir);

      const spawnResult = await executor.spawn({
        workingDir,
        prompt: body.prompt,
        env,
      });

      // 创建 MsgStore 并连接 PTY 输出
      const msgStore = sessionMsgStoreManager.create(sessionId, body.agentType, workingDir);

      // 根据 agent 类型创建解析器
      let parser: { processData(data: string): void; finish(): void } | null = null;
      if (body.agentType === AgentType.CLAUDE_CODE) {
        parser = createClaudeCodeParser(msgStore);
      } else if (body.agentType === AgentType.CURSOR_AGENT) {
        parser = createCursorAgentParser(msgStore, workingDir);
      }

      // 将 PTY 输出转发到 MsgStore 和解析器
      let ptyDataCount = 0;
      spawnResult.pty.onData((data) => {
        ptyDataCount++;
        const now = Date.now();
        if (DEBUG_DEMO) {
          console.log(`[Demo:PTY] #${ptyDataCount} t=${now} sessionId=${sessionId} len=${data.length} preview="${data.slice(0, 80).replace(/\n/g, '\\n')}..."`);
        }
        msgStore.pushStdout(data);
        if (parser) {
          parser.processData(data);
        }
      });

      // PTY 退出时标记 MsgStore 完成并清理状态
      spawnResult.pty.onExit(() => {
        if (parser) {
          parser.finish();
        }
        msgStore.pushFinished();
        // Update session status and clean up PTY reference
        const session = demoSessions.get(sessionId);
        if (session) {
          session.status = 'stopped';
        }
        demoPtys.delete(sessionId);
      });

      demoPtys.set(sessionId, spawnResult.pty);
      demoSessions.set(sessionId, {
        agentType: body.agentType,
        status: 'running',
      });

      reply.code(201);
      return {
        sessionId,
        agentType: body.agentType,
        status: 'running',
        pid: spawnResult.pid,
      };
    } catch (error) {
      reply.code(500);
      return {
        error: 'Failed to start agent',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // 发送消息到 demo 会话
  app.post<{ Params: { sessionId: string } }>(
    '/demo/:sessionId/message',
    async (request, reply) => {
      const { sessionId } = request.params;
      const body = sendMessageSchema.parse(request.body);

      const session = demoSessions.get(sessionId);
      if (!session) {
        reply.code(404);
        return { error: 'Session not found' };
      }

      const pty = demoPtys.get(sessionId);
      if (!pty) {
        reply.code(404);
        return { error: 'PTY not found' };
      }
      pty.write(body.message + '\n');
      return { success: true };
    }
  );

  // 停止 demo 会话
  app.post<{ Params: { sessionId: string } }>(
    '/demo/:sessionId/stop',
    async (request, reply) => {
      const { sessionId } = request.params;

      const session = demoSessions.get(sessionId);
      if (!session) {
        reply.code(404);
        return { error: 'Session not found' };
      }

      const pty = demoPtys.get(sessionId);
      if (pty) {
        pty.kill();
        demoPtys.delete(sessionId);
      }
      demoSessions.set(sessionId, { ...session, status: 'stopped' });

      return { success: true };
    }
  );

  // 获取可用的 agent 列表（带实际可用性检查）
  app.get('/demo/agents', async () => {
    const executorsInfo = await getAllExecutorsAvailability();

    const agents = executorsInfo.map(info => ({
      type: info.agentType,
      name: info.displayName,
      available: info.availability.type !== 'NOT_FOUND',
      availabilityType: info.availability.type,
      lastAuthTimestamp: info.availability.type === 'LOGIN_DETECTED'
        ? info.availability.lastAuthTimestamp
        : undefined,
      error: info.availability.type === 'NOT_FOUND'
        ? (info.availability as { error?: string }).error
        : undefined,
    }));

    return { agents };
  });
}
