import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const taskCleanupStartMock = vi.fn()
const taskCleanupStopMock = vi.fn()
const memberHeartbeatStartMock = vi.fn()
const memberHeartbeatStopMock = vi.fn()

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
  getEventBus: vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), off: vi.fn() })),
  getSessionManager: vi.fn(() => ({})),
  getTaskCleanupService: vi.fn(() => ({
    start: taskCleanupStartMock,
    stop: taskCleanupStopMock,
  })),
}))

vi.mock('./services/member-heartbeat-scheduler.js', () => ({
  MemberHeartbeatScheduler: vi.fn(function () {
    return {
      start: memberHeartbeatStartMock,
      stop: memberHeartbeatStopMock,
    };
  }),
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

vi.mock('./utils/index.js', () => ({
  initializeDatabaseRuntime: vi.fn(async () => {}),
}))

vi.mock('./services/database-maintenance.service.js', () => ({
  runStartupDataMigrations: vi.fn(async () => {}),
}))

import { buildApp } from './app.js'

const originalWebDir = process.env.AGENT_TOWER_WEB_DIR

let tempWebDir = ''

describe('buildApp static web hosting', () => {
  beforeEach(() => {
    tempWebDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-web-'))
    taskCleanupStartMock.mockClear()
    taskCleanupStopMock.mockClear()
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
  })

  afterEach(() => {
    if (originalWebDir === undefined) {
      delete process.env.AGENT_TOWER_WEB_DIR
    } else {
      process.env.AGENT_TOWER_WEB_DIR = originalWebDir
    }
  })

  it('starts and stops the task cleanup worker with the app lifecycle', async () => {
    const app = await buildApp()

    await expect(app.ready()).resolves.toBe(app)
    expect(taskCleanupStartMock).toHaveBeenCalledTimes(1)

    await app.close()
    expect(taskCleanupStopMock).toHaveBeenCalledTimes(1)
  })
})
