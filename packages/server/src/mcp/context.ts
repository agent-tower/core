/**
 * 工作空间上下文检测
 * 启动时根据 cwd 查询后端，判断当前目录是否在某个 workspace 的 worktree 中
 */
import type { AgentTowerClient } from './http-client.js';

export interface McpContext {
  projectId: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  workspaceBranch: string;
  teamRunId?: string;
  memberId?: string;
  invocationId?: string;
}

export async function fetchContext(client: AgentTowerClient): Promise<McpContext | null> {
  try {
    const result = await client.getWorkspaceContext(process.cwd());
    if (!result) return null;
    return {
      projectId: result.projectId,
      projectName: result.projectName,
      taskId: result.taskId,
      taskTitle: result.taskTitle,
      workspaceId: result.workspaceId,
      workspaceBranch: result.workspaceBranch,
      ...(process.env.AGENT_TOWER_TEAM_RUN_ID ? { teamRunId: process.env.AGENT_TOWER_TEAM_RUN_ID } : {}),
      ...(process.env.AGENT_TOWER_MEMBER_ID ? { memberId: process.env.AGENT_TOWER_MEMBER_ID } : {}),
      ...(process.env.AGENT_TOWER_INVOCATION_ID ? { invocationId: process.env.AGENT_TOWER_INVOCATION_ID } : {}),
    };
  } catch {
    return null;
  }
}
