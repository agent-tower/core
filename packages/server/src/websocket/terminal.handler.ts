import type { FastifyInstance } from 'fastify';
import { ProcessManager } from '../process/process.manager.js';

const processManager = new ProcessManager();

export async function registerTerminalWebSocket(app: FastifyInstance) {
  app.get<{ Params: { sessionId: string } }>(
    '/ws/terminal/:sessionId',
    { websocket: true },
    (socket, request) => {
      const { sessionId } = request.params;
      const pty = processManager.get(sessionId);

      if (!pty) {
        socket.send(JSON.stringify({ type: 'error', data: 'Session not found' }));
        socket.close();
        return;
      }

      // 从 PTY 接收输出并发送到 WebSocket
      const onData = pty.onData((data) => {
        socket.send(JSON.stringify({ type: 'output', data }));
      });

      const onExit = pty.onExit(({ exitCode }) => {
        socket.send(JSON.stringify({ type: 'exit', exitCode }));
        socket.close();
      });

      // 从 WebSocket 接收输入并发送到 PTY
      socket.on('message', (message: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const parsed = JSON.parse(message.toString());
          if (parsed.type === 'input' && parsed.data) {
            pty.write(parsed.data);
          } else if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            pty.resize(parsed.cols, parsed.rows);
          }
        } catch {
          // Ignore invalid messages
        }
      });

      socket.on('close', () => {
        onData.dispose();
        onExit.dispose();
      });
    }
  );
}
