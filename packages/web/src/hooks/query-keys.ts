/**
 * TanStack Query Key 集中管理
 * 所有 query key 统一在此定义，避免硬编码字符串
 */

export const queryKeys = {
  projects: {
    all: ['projects'] as const,
    list: (params?: Record<string, unknown>) =>
      ['projects', 'list', params] as const,
    detail: (id: string) => ['projects', 'detail', id] as const,
  },

  tasks: {
    all: ['tasks'] as const,
    list: (projectId: string, params?: Record<string, unknown>) =>
      ['tasks', 'list', projectId, params] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
    stats: (projectId: string) => ['tasks', 'stats', projectId] as const,
  },

  workspaces: {
    all: ['workspaces'] as const,
    list: (taskId: string) => ['workspaces', 'list', taskId] as const,
    detail: (id: string) => ['workspaces', 'detail', id] as const,
    diff: (id: string) => ['workspaces', 'diff', id] as const,
    gitStatus: (id: string) => ['workspaces', 'gitStatus', id] as const,
  },

  sessions: {
    all: ['sessions'] as const,
    detail: (id: string) => ['sessions', 'detail', id] as const,
  },

  files: {
    all: ['files'] as const,
    tree: (workingDir: string, dirPath: string) =>
      ['files', 'tree', workingDir, dirPath] as const,
    content: (workingDir: string, filePath: string) =>
      ['files', 'content', workingDir, filePath] as const,
  },

  git: {
    all: ['git'] as const,
    changes: (workingDir: string) => ['git', 'changes', workingDir] as const,
    diff: (workingDir: string, filePath: string, type: string) =>
      ['git', 'diff', workingDir, filePath, type] as const,
    log: (workingDir: string) => ['git', 'log', workingDir] as const,
    commitFiles: (workingDir: string, hash: string) =>
      ['git', 'commitFiles', workingDir, hash] as const,
    commitDiff: (workingDir: string, hash: string, filePath: string) =>
      ['git', 'commitDiff', workingDir, hash, filePath] as const,
  },

  profiles: {
    all: ['profiles'] as const,
    defaults: ['profiles', 'defaults'] as const,
    agent: (agentType: string) => ['profiles', 'agent', agentType] as const,
    variant: (agentType: string, variant: string) =>
      ['profiles', 'variant', agentType, variant] as const,
  },

  tunnel: {
    status: ['tunnel', 'status'] as const,
  },

  notifications: {
    settings: ['notifications', 'settings'] as const,
  },
}
