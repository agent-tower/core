import { describe, expect, it } from 'vitest';
import { buildAgentTowerMcpEnvConfigOverrides } from '../codex.executor.js';
import { ExecutionEnv } from '../execution-env.js';

describe('CodexExecutor TeamRun MCP env overrides', () => {
  it('projects TeamRun identity env into Codex MCP server config overrides', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
    });

    expect(buildAgentTowerMcpEnvConfigOverrides(env)).toEqual([
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_SESSION_ID="session-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_INVOCATION_ID="invocation-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_MEMBER_ID="member-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_SESSION_ID="session-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_INVOCATION_ID="invocation-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_MEMBER_ID="member-1"',
    ]);
  });

  it('omits MCP identity overrides for non-TeamRun sessions', () => {
    const env = ExecutionEnv.default('/tmp/worktree');

    expect(buildAgentTowerMcpEnvConfigOverrides(env)).toEqual([]);
  });

  it('only projects TeamRun identity env keys', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      OPENAI_API_KEY: 'provider-secret',
    });

    expect(buildAgentTowerMcpEnvConfigOverrides(env)).toEqual([
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
    ]);
  });
});
