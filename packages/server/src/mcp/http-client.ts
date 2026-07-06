/**
 * agent-tower 后端 API HTTP 客户端
 * MCP 服务器通过此客户端代理调用后端 REST API
 */

export class AgentTowerClient {
  private invocationIdOverride?: string;
  private internalApiToken?: string;

  constructor(private baseUrl: string) {}

  setInvocationId(invocationId: string | undefined): void {
    this.invocationIdOverride = invocationId;
  }

  setInternalApiToken(token: string | undefined): void {
    this.internalApiToken = token;
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
      headers['x-agent-tower-invocation-id'] = invocationId;
    }
    if (this.internalApiToken) {
      headers['x-agent-tower-internal-token'] = this.internalApiToken;
    }

    const resp = await fetch(url, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`API ${method} ${path} failed (${resp.status}): ${text}`);
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

  async createTask(projectId: string, input: { title: string; description?: string; priority?: number }) {
    return this.request<any>('POST', `/api/projects/${projectId}/tasks`, input);
  }

  async getTask(taskId: string) {
    return this.request<any>('GET', `/api/tasks/${taskId}`);
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
