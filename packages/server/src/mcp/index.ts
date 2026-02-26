#!/usr/bin/env node
/**
 * agent-tower MCP 服务器入口
 * 通过 stdio 传输与 MCP 客户端通信，代理调用 agent-tower 后端 API
 */
import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // 按优先级确定后端 URL
  let port: number | string = process.env.AGENT_TOWER_PORT ?? 12580;

  if (!process.env.AGENT_TOWER_PORT && !process.env.AGENT_TOWER_URL) {
    // 1. 尝试读取主服务写入的 port 文件
    const portFile = path.join(process.env.AGENT_TOWER_DATA_DIR || path.join(homedir(), '.agent-tower'), 'port');
    try {
      const saved = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
      if (!isNaN(saved)) port = saved;
    } catch {
      // port 文件不存在，继续尝试其他方式
    }

    // 2. 开发模式: 仅在 monorepo 环境下通过路径 hash 计算端口
    if (port === 12580) {
      try {
        const monorepoRoot = path.resolve(__dirname, '../../..');
        if (fs.existsSync(path.join(monorepoRoot, 'pnpm-workspace.yaml'))) {
          const { getDevPort } = await import('@agent-tower/shared/dev-port');
          port = getDevPort(monorepoRoot);
        }
      } catch {
        // 非 monorepo 环境，使用默认端口
      }
    }
  }
  const baseUrl = process.env.AGENT_TOWER_URL ?? `http://127.0.0.1:${port}`;

  console.error(`[agent-tower-mcp] Connecting to backend at ${baseUrl}`);

  const server = await createMcpServer(baseUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[agent-tower-mcp] MCP server started (stdio)');
}

main().catch((err) => {
  console.error('[agent-tower-mcp] Fatal error:', err);
  process.exit(1);
});
