/**
 * agent-tower 后端 API HTTP 客户端
 * MCP 服务器通过此客户端代理调用后端 REST API
 */

export class AgentTowerClient {
  constructor(private baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    let url = this.url(path);
    if (query) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }

    const resp = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
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

  async createWorkspace(taskId: string, branchName?: string) {
    return this.request<any>('POST', `/api/tasks/${taskId}/workspaces`, branchName ? { branchName } : {});
  }

  async getWorkspaceDiff(workspaceId: string) {
    return this.request<{ diff: string }>('GET', `/api/workspaces/${workspaceId}/diff`);
  }

  async mergeWorkspace(workspaceId: string) {
    return this.request<{ success: boolean; sha: string }>('POST', `/api/workspaces/${workspaceId}/merge`);
  }

  // ── Sessions ──

  async createSession(workspaceId: string, agentType: string, prompt: string, variant?: string) {
    return this.request<any>('POST', `/api/workspaces/${workspaceId}/sessions`, {
      agentType,
      prompt,
      ...(variant ? { variant } : {}),
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

  // ── System ──

  async getWorkspaceContext(cwdPath: string) {
    return this.request<any>('GET', '/api/system/workspace-context', undefined, { path: cwdPath });
  }
}
