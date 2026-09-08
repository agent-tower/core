import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getTerminalManager } from '../core/container.js';

const createTerminalSchema = z.object({
  socketId: z.string().min(1),
  cwd: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

export async function terminalRoutes(app: FastifyInstance) {
  /**
   * POST /api/terminals — Create a new standalone terminal
   *
   * Body: { socketId: string, cwd?: string, cols?: number, rows?: number }
   * Response: { terminalId: string, pid: number, cwd: string }
   */
  app.post('/terminals', async (request, reply) => {
    const body = createTerminalSchema.parse(request.body);
    const terminalManager = await getTerminalManager();

    try {
      const info = await terminalManager.create(body.socketId, {
        cwd: body.cwd,
        cols: body.cols,
        rows: body.rows,
      });

      reply.code(201);
      return info;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Terminal limit')) {
        reply.code(429);
        return { error: error.message };
      }
      reply.code(500);
      return {
        error: 'Failed to create terminal',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * DELETE /api/terminals/:terminalId — Destroy a standalone terminal
   */
  app.delete<{ Params: { terminalId: string } }>(
    '/terminals/:terminalId',
    async (request, reply) => {
      const { terminalId } = request.params;
      const terminalManager = await getTerminalManager();

      if (!terminalManager.has(terminalId)) {
        reply.code(404);
        return { error: 'Terminal not found' };
      }

      await terminalManager.destroy(terminalId);
      return { success: true };
    }
  );
}
