import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const taskCleanupStartMock = vi.fn()
const taskCleanupStopMock = vi.fn()
const workspaceGitWatcherStartMock = vi.fn(() => Promise.resolve())
const workspaceGitWatcherStopMock = vi.fn()

vi.mock('./routes/index.js', () => ({
  registerRoutes: vi.fn(async () => {}),
}))

vi.mock('./socket/index.js', () => ({
  initializeSocket: vi.fn(async () => {}),
  closeSocket: vi.fn(async () => {}),
}))

vi.mock('./services/workspace.service.js', () => ({
  WorkspaceService: {
    pruneAllWorktrees: vi.fn(() => Promise.resolve()),
  },
}))

vi.mock('./core/container.js', () => ({
  getTaskCleanupService: vi.fn(() => ({
    start: taskCleanupStartMock,
    stop: taskCleanupStopMock,
  })),
  getWorkspaceGitWatcherService: vi.fn(() => ({
    start: workspaceGitWatcherStartMock,
    stop: workspaceGitWatcherStopMock,
  })),
}))

vi.mock('./services/tunnel.service.js', () => ({
  TunnelService: {
    isRunning: vi.fn(() => false),
    validateToken: vi.fn(() => true),
    validateHealthCheck: vi.fn(() => false),
    getHealthResponse: vi.fn(() => ({ ok: true })),
    stop: vi.fn(),
  },
}))

import { buildApp } from './app.js'

const originalWebDir = process.env.AGENT_TOWER_WEB_DIR

let tempWebDir = ''

describe('buildApp static web hosting', () => {
  beforeEach(() => {
    tempWebDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-web-'))
    taskCleanupStartMock.mockClear()
    taskCleanupStopMock.mockClear()
    workspaceGitWatcherStartMock.mockReset()
    workspaceGitWatcherStartMock.mockResolvedValue(undefined)
    workspaceGitWatcherStopMock.mockClear()
  })

  afterEach(() => {
    if (originalWebDir === undefined) {
      delete process.env.AGENT_TOWER_WEB_DIR
    } else {
      process.env.AGENT_TOWER_WEB_DIR = originalWebDir
    }

    if (tempWebDir) {
      fs.rmSync(tempWebDir, { recursive: true, force: true })
    }
  })

  it('does not serve the web app when AGENT_TOWER_WEB_DIR is unset', async () => {
    delete process.env.AGENT_TOWER_WEB_DIR

    const app = await buildApp()

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/',
      })

      expect(response.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('serves the web app when AGENT_TOWER_WEB_DIR is set', async () => {
    fs.writeFileSync(path.join(tempWebDir, 'index.html'), '<html><body>agent tower</body></html>', 'utf-8')
    process.env.AGENT_TOWER_WEB_DIR = tempWebDir

    const app = await buildApp()

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/',
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('agent tower')
    } finally {
      await app.close()
    }
  })
})

describe('buildApp startup services', () => {
  beforeEach(() => {
    delete process.env.AGENT_TOWER_WEB_DIR
    taskCleanupStartMock.mockClear()
    taskCleanupStopMock.mockClear()
    workspaceGitWatcherStartMock.mockReset()
    workspaceGitWatcherStartMock.mockResolvedValue(undefined)
    workspaceGitWatcherStopMock.mockClear()
  })

  afterEach(() => {
    if (originalWebDir === undefined) {
      delete process.env.AGENT_TOWER_WEB_DIR
    } else {
      process.env.AGENT_TOWER_WEB_DIR = originalWebDir
    }
  })

  it('does not block Fastify ready on workspace git watcher startup', async () => {
    let resolveWatcherStart!: () => void
    workspaceGitWatcherStartMock.mockReturnValue(new Promise<void>((resolve) => {
      resolveWatcherStart = resolve
    }))

    const app = await buildApp()

    try {
      await expect(app.ready()).resolves.toBe(app)
      expect(workspaceGitWatcherStartMock).toHaveBeenCalledTimes(1)
    } finally {
      resolveWatcherStart()
      await app.close()
    }
  })

  it('logs workspace git watcher startup failures without failing Fastify ready', async () => {
    workspaceGitWatcherStartMock.mockRejectedValue(new Error('watcher failed'))

    const app = await buildApp()
    const warnSpy = vi.spyOn(app.log, 'warn')

    try {
      await expect(app.ready()).resolves.toBe(app)
      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith('Workspace git watcher startup failed: watcher failed')
      })
    } finally {
      await app.close()
      warnSpy.mockRestore()
    }
  })
})
