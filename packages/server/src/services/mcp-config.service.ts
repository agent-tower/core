import path from 'node:path';
import type { McpConfigResponse, McpConfigRuntimeMode } from '@agent-tower/shared';
import { getDefaultDataDir } from '../utils/data-dir.js';

const SERVER_NAME = 'agent-tower';

function resolveRuntimeMode(env: NodeJS.ProcessEnv): McpConfigRuntimeMode {
  return env.AGENT_TOWER_DESKTOP_RUNTIME_MODE === 'packaged' ? 'desktop-packaged' : 'workspace';
}

function resolveMcpEntry(env: NodeJS.ProcessEnv, fallbackDir: string): string {
  return env.AGENT_TOWER_MCP_ENTRY || path.resolve(fallbackDir, 'mcp/index.js');
}

function buildConfigJson(command: string, args: string[], env: Record<string, string>): string {
  const serverConfig = {
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  return JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: serverConfig,
    },
  }, null, 2);
}

export function buildMcpConfigResponse(options: {
  env?: NodeJS.ProcessEnv
  serverDistDir: string
}): McpConfigResponse {
  const env = options.env ?? process.env;
  const runtimeMode = resolveRuntimeMode(env);
  const mcpEntry = resolveMcpEntry(env, options.serverDistDir);
  const command = runtimeMode === 'desktop-packaged'
    ? env.AGENT_TOWER_NODE_RUNTIME || process.execPath
    : env.AGENT_TOWER_DESKTOP_NODE || process.execPath;
  const configEnv: Record<string, string> = {
    AGENT_TOWER_DATA_DIR: env.AGENT_TOWER_DATA_DIR || getDefaultDataDir(),
  };

  if (runtimeMode === 'desktop-packaged') {
    configEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  const args = [mcpEntry];
  const configJson = buildConfigJson(command, args, configEnv);

  return {
    serverName: SERVER_NAME,
    runtimeMode,
    command,
    args,
    env: configEnv,
    config: JSON.parse(configJson) as McpConfigResponse['config'],
    configJson,
  };
}
