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
  },

  sessions: {
    all: ['sessions'] as const,
    detail: (id: string) => ['sessions', 'detail', id] as const,
  },
}
