/**
 * agent-tower 后端 API HTTP 客户端
 * MCP 服务器通过此客户端代理调用后端 REST API
 */
import type {
  CreateTaskInput,
  TaskHandoff,
  UpdateTaskHandoffInput,
  WorkspaceBackgroundServiceDto,
  WorkspaceBackgroundServiceInputResponse,
  WorkspaceBackgroundServiceLogsResponse,
  WorkspaceBackgroundServicesResponse,
} from '@agent-tower/shared';
import {
  INTERNAL_API_INVOCATION_ID_HEADER,
  INTERNAL_API_SESSION_ID_HEADER,
  INTERNAL_API_TOKEN_HEADER,
} from '../utils/internal-api-token.js';
import { AGENT_API_CREDENTIAL_HEADER } from '../utils/agent-api-credential.js';

export class AgentTowerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly apiMessage: string,
  ) {
    super(`[${code}] ${apiMessage}`);
    this.name = 'AgentTowerApiError';
  }
}

export class AgentTowerClient {
  private invocationIdOverride?: string;
  private sessionIdOverride?: string;
  private internalApiToken?: string;
  private agentApiCredential?: string;

  constructor(private baseUrl: string) {}

  setInvocationId(invocationId: string | undefined): void {
    this.invocationIdOverride = invocationId;
  }

  setSessionId(sessionId: string | undefined): void {
    this.sessionIdOverride = sessionId;
  }

  setInternalApiToken(token: string | undefined): void {
    this.internalApiToken = token;
  }

  setAgentApiCredential(credential: string | undefined): void {
    this.agentApiCredential = credential;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    let url = this.url(path);
    if (query) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    const invocationId = this.invocationIdOverride ?? process.env.AGENT_TOWER_INVOCATION_ID;
    if (invocationId) {
      headers[INTERNAL_API_INVOCATION_ID_HEADER] = invocationId;
    }
    const sessionId = this.sessionIdOverride ?? process.env.AGENT_TOWER_SESSION_ID;
    if (sessionId) {
      headers[INTERNAL_API_SESSION_ID_HEADER] = sessionId;
    }
    if (this.agentApiCredential) {
      headers[AGENT_API_CREDENTIAL_HEADER] = this.agentApiCredential;
    } else if (this.internalApiToken) {
      headers[INTERNAL_API_TOKEN_HEADER] = this.internalApiToken;
    }

    const resp = await fetch(url, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let payload: { error?: unknown; code?: unknown } = {};
      try {
        payload = JSON.parse(text) as { error?: unknown; code?: unknown };
      } catch {
        // Non-JSON upstream errors are mapped to a stable generic code.
      }
      const code = typeof payload.code === 'string' ? payload.code : 'HTTP_ERROR';
      const message = typeof payload.error === 'string'
        ? payload.error
        : `API ${method} ${path} failed (${resp.status})`;
      throw new AgentTowerApiError(resp.status, code, message);
    }

    // 204 No Content
    if (resp.status === 204) return undefined as T;

    return resp.json() as Promise<T>;
  }

  // ── Projects ──

  async listProjects(params?: { page?: number; limit?: number }) {
    const query: Record<string, string> = {};
    if (params?.page) query.page = String(params.page);
    if (params?.limit) query.limit = String(params.limit);
    return this.request<any>('GET', '/api/projects', undefined, query);
  }

  // ── Tasks ──

  async listTasks(projectId: string, params?: { status?: string; limit?: number; page?: number }) {
    const query: Record<string, string> = {};
    if (params?.status) query.status = params.status;
    if (params?.limit) query.limit = String(params.limit);
    if (params?.page) query.page = String(params.page);
    return this.request<any>('GET', `/api/projects/${projectId}/tasks`, undefined, query);
  }

  async createTask(projectId: string, input: CreateTaskInput) {
    return this.request<any>('POST', `/api/projects/${projectId}/tasks`, input);
  }

  async getTask(taskId: string) {
    return this.request<any>('GET', `/api/tasks/${taskId}`);
  }

  async getTaskHandoff(taskId: string): Promise<TaskHandoff> {
    return this.request<TaskHandoff>('GET', `/api/tasks/${encodeURIComponent(taskId)}/handoff`);
  }

  async updateTaskHandoff(taskId: string, input: UpdateTaskHandoffInput): Promise<TaskHandoff> {
    return this.request<TaskHandoff>('PATCH', `/api/tasks/${encodeURIComponent(taskId)}/handoff`, input);
  }

  async updateTask(taskId: string, input: { title?: string; description?: string; priority?: number }) {
    return this.request<any>('PUT', `/api/tasks/${taskId}`, input);
  }

  async updateTaskStatus(taskId: string, status: string) {
    return this.request<any>('PATCH', `/api/tasks/${taskId}/status`, { status });
  }

  async deleteTask(taskId: string) {
    return this.request<void>('DELETE', `/api/tasks/${taskId}`);
  }

  // ── Workspaces ──

  async createWorkspace(taskId: string, input: { branchName?: string; workspaceKind?: string } = {}) {
    return this.request<any>('POST', `/api/tasks/${taskId}/workspaces`, input);
  }

  async getWorkspaceDiff(workspaceId: string) {
    return this.request<{ diff: string }>('GET', `/api/workspaces/${workspaceId}/diff`);
  }

  async mergeWorkspace(workspaceId: string) {
    return this.request<{ success: boolean; sha: string }>('POST', `/api/workspaces/${workspaceId}/merge`);
  }

  async listMergeableWorkspaces(teamRunId: string) {
    return this.request<any>('GET', `/api/team-runs/${teamRunId}/mergeable-workspaces`);
  }

  async mergeAllMemberWorkspaces(teamRunId: string, input: {
    workspaceIds?: string[];
    dryRun?: boolean;
    stopOnConflict?: boolean;
  } = {}) {
    return this.request<any>('POST', `/api/team-runs/${teamRunId}/merge-members`, input);
  }

  async recordWorkspaceVerdict(workspaceId: string, input: {
    kind: 'REVIEW' | 'TEST';
    verdict: 'APPROVED' | 'CHANGES_REQUESTED' | 'PASSED' | 'FAILED';
    reviewedSha: string;
    reason?: string;
  }) {
    return this.request<any>('POST', `/api/workspaces/${workspaceId}/verdicts`, input);
  }

  async startWorkspaceService(workspaceId: string, serviceName: string, input: {
    command: string;
    args?: string[];
    relativeCwd?: string;
  }): Promise<WorkspaceBackgroundServiceDto> {
    return this.request<WorkspaceBackgroundServiceDto>(
      'PUT',
      `/api/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceName)}`,
      input,
    );
  }

  async listWorkspaceServices(workspaceId: string): Promise<WorkspaceBackgroundServicesResponse> {
    return this.request<WorkspaceBackgroundServicesResponse>(
      'GET',
      `/api/workspaces/${encodeURIComponent(workspaceId)}/services`,
    );
  }

  async getWorkspaceServiceLogs(workspaceId: string, serviceName: string, params: {
    afterSeq?: number;
    runtimeInstanceId?: string;
    limit?: number;
  } = {}): Promise<WorkspaceBackgroundServiceLogsResponse> {
    const query: Record<string, string> = {};
    if (params.afterSeq !== undefined) query.afterSeq = String(params.afterSeq);
    if (params.runtimeInstanceId !== undefined) query.runtimeInstanceId = params.runtimeInstanceId;
    if (params.limit !== undefined) query.limit = String(params.limit);
    return this.request<WorkspaceBackgroundServiceLogsResponse>(
      'GET',
      `/api/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceName)}/logs`,
      undefined,
      query,
    );
  }

  async sendWorkspaceServiceInput(
    workspaceId: string,
    serviceName: string,
    data: string,
  ): Promise<WorkspaceBackgroundServiceInputResponse> {
    return this.request<WorkspaceBackgroundServiceInputResponse>(
      'POST',
      `/api/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceName)}/input`,
      { data },
    );
  }

  async controlWorkspaceService(
    workspaceId: string,
    serviceName: string,
    action: 'stop' | 'restart',
  ): Promise<WorkspaceBackgroundServiceDto> {
    return this.request<WorkspaceBackgroundServiceDto>(
      'POST',
      `/api/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceName)}/${action}`,
    );
  }

  // ── Providers ──

  async listProviders() {
    return this.request<any[]>('GET', '/api/providers');
  }

  // ── Sessions ──

  async createSession(workspaceId: string, prompt: string, providerId: string) {
    return this.request<any>('POST', `/api/workspaces/${workspaceId}/sessions`, {
      prompt,
      providerId,
    });
  }

  async startSession(sessionId: string) {
    return this.request<any>('POST', `/api/sessions/${sessionId}/start`);
  }

  async stopSession(sessionId: string) {
    return this.request<any>('POST', `/api/sessions/${sessionId}/stop`);
  }

  async sendMessage(sessionId: string, message: string) {
    return this.request<any>('POST', `/api/sessions/${sessionId}/message`, { message });
  }

  // ── Team Room ──

  async createRoomMessage(teamRunId: string, input: {
    content: string;
    mentions?: Array<{
      memberId: string;
      label?: string;
      ifBusy?: 'queue' | 'cancel_current_and_start';
      cancelQueued?: boolean;
      target?: {
        kind: 'WORKSPACE_COMMIT';
        purpose: 'REVIEW' | 'TEST';
        sourceWorkspaceId: string;
        headSha: string;
        branchName: string;
        planItemId?: string | null;
      } | null;
    }>;
    attachmentIds?: string[];
    artifactRefs?: string[];
    kind?: 'chat' | 'work_request' | 'artifact' | 'review' | 'decision' | 'system';
    senderType?: 'user' | 'agent' | 'system';
    senderId?: string | null;
    senderInvocationId?: string | null;
  }) {
    return this.request<any>('POST', `/api/team-runs/${teamRunId}/messages`, input);
  }

  async createPrivateRoomMessage(teamRunId: string, input: {
    content: string;
    recipientMemberIds: string[];
    target?: {
      kind: 'WORKSPACE_COMMIT';
      purpose: 'REVIEW' | 'TEST';
      sourceWorkspaceId: string;
      headSha: string;
      branchName: string;
      planItemId?: string | null;
    } | null;
    attachmentIds?: string[];
    artifactRefs?: string[];
    ifBusy?: 'queue' | 'cancel_current_and_start';
    cancelQueued?: boolean;
    senderType?: 'user' | 'agent' | 'system';
    senderId?: string | null;
    senderInvocationId?: string | null;
  }) {
    return this.request<any>('POST', `/api/team-runs/${teamRunId}/private-messages`, input);
  }

  async listRoomMessages(teamRunId: string, params?: { limit?: number }) {
    const query: Record<string, string> = {};
    if (params?.limit) query.limit = String(params.limit);
    return this.request<any[]>('GET', `/api/team-runs/${teamRunId}/messages`, undefined, query);
  }

  async getTeamTaskInput(teamRunId: string, view: 'preview' | 'full' = 'preview') {
    return this.request<import('@agent-tower/shared').AgentTeamTaskInput>('GET', `/api/team-runs/${teamRunId}/task-input`, undefined, { view });
  }

  async getRoomMessage(teamRunId: string, messageId: string) {
    return this.request<any>('GET', `/api/team-runs/${teamRunId}/messages/${messageId}`);
  }

  async listTeamMembers(teamRunId: string) {
    return this.request<any[]>('GET', `/api/team-runs/${teamRunId}/members`);
  }

  async listMemberWorkRequests(teamRunId: string, memberId: string) {
    return this.request<any>('GET', `/api/team-runs/${teamRunId}/members/${memberId}/work-requests`);
  }

  async approveWorkRequest(workRequestId: string, input: {
    teamRunId?: string;
    requesterMemberId?: string;
  } = {}) {
    return this.request<any>('POST', `/api/team-runs/work-requests/${workRequestId}/approve`, input);
  }

  async rejectWorkRequest(workRequestId: string, input: {
    teamRunId?: string;
    requesterMemberId?: string;
  } = {}) {
    return this.request<any>('POST', `/api/team-runs/work-requests/${workRequestId}/reject`, input);
  }

  async cancelWorkRequest(workRequestId: string, input: {
    teamRunId?: string;
    requesterMemberId?: string;
  } = {}) {
    return this.request<any>('POST', `/api/team-runs/work-requests/${workRequestId}/cancel`, input);
  }

  async stopMemberWork(teamRunId: string, memberId: string, input: {
    cancelQueued?: boolean;
  } = {}) {
    return this.request<any>('POST', `/api/team-runs/${teamRunId}/members/${memberId}/stop`, {
      cancelQueued: input.cancelQueued,
    });
  }

  // ── System ──

  async getWorkspaceContext(cwdPath: string, sessionId?: string) {
    return this.request<any>(
      'GET',
      '/api/system/workspace-context',
      undefined,
      {
        path: cwdPath,
        ...(sessionId ? { sessionId } : {}),
      }
    );
  }
}
