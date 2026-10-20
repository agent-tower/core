import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const taskCleanupStartMock = vi.fn()
const taskCleanupStopMock = vi.fn()
const memberHeartbeatStartMock = vi.fn()
const memberHeartbeatStopMock = vi.fn()
const backgroundReconcileMock = vi.fn(async () => {})
const backgroundShutdownMock = vi.fn(async () => {})
const deliveryStartMock = vi.fn(async () => {})
const deliveryShutdownMock = vi.fn(async () => {})
const translationStartMock = vi.fn(async () => {})
const translationShutdownMock = vi.fn(async () => {})

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
  getSessionManager: vi.fn(() => ({ startConversationQueue: vi.fn(async () => {}), stopConversationQueue: vi.fn() })),
  destroyApplicationProcesses: vi.fn(async () => {
    await Promise.all([backgroundShutdownMock(), translationShutdownMock(), deliveryShutdownMock()])
  }),
  getMessageDeliveryService: vi.fn(() => ({ start: deliveryStartMock, shutdown: deliveryShutdownMock })),
  getTranslationService: vi.fn(() => ({
    start: translationStartMock,
    shutdown: translationShutdownMock,
  })),
  getTaskCleanupService: vi.fn(() => ({
    start: taskCleanupStartMock,
    stop: taskCleanupStopMock,
  })),
  getWorkspaceBackgroundService: vi.fn(() => ({
    reconcile: backgroundReconcileMock,
    shutdown: backgroundShutdownMock,
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
import { initializeSocket } from './socket/index.js'

const originalWebDir = process.env.AGENT_TOWER_WEB_DIR

let tempWebDir = ''

beforeEach(() => {
  deliveryStartMock.mockClear()
  deliveryShutdownMock.mockClear()
  translationStartMock.mockClear()
  translationShutdownMock.mockClear()
  vi.mocked(initializeSocket).mockClear()
})

describe('buildApp static web hosting', () => {
  beforeEach(() => {
    tempWebDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-web-'))
    taskCleanupStartMock.mockClear()
    taskCleanupStopMock.mockClear()
    backgroundReconcileMock.mockClear()
    backgroundShutdownMock.mockClear()
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
    expect(backgroundReconcileMock).toHaveBeenCalledOnce()
    expect(backgroundShutdownMock).toHaveBeenCalledOnce()
    expect(translationStartMock).toHaveBeenCalledOnce()
    expect(translationShutdownMock).toHaveBeenCalledOnce()
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

  it('waits for translation recovery before starting socket and other app services', async () => {
    let finishRecovery!: () => void
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve })
    translationStartMock.mockImplementationOnce(() => recovery)
    const app = await buildApp()
    const ready = app.ready()

    try {
      await vi.waitFor(() => expect(translationStartMock).toHaveBeenCalledOnce())
      expect(initializeSocket).not.toHaveBeenCalled()
      expect(taskCleanupStartMock).not.toHaveBeenCalled()
      finishRecovery()
      await expect(ready).resolves.toBe(app)
      expect(initializeSocket).toHaveBeenCalledOnce()
    } finally {
      finishRecovery()
      await ready
      await app.close()
    }
    expect(translationShutdownMock).toHaveBeenCalledOnce()
  })

  it('waits for translation request cleanup before completing app close', async () => {
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve })
    translationShutdownMock.mockImplementationOnce(() => cleanup)
    const app = await buildApp()
    await app.ready()
    let closed = false
    const closing = app.close().then(() => { closed = true })

    try {
      await vi.waitFor(() => expect(translationShutdownMock).toHaveBeenCalledOnce())
      expect(closed).toBe(false)
    } finally {
      finishCleanup()
      await closing
    }
    expect(closed).toBe(true)
  })
  it('waits for durable delivery reconciliation before Socket and conversation scheduling', async () => {
    let finish!: () => void
    deliveryStartMock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const app = await buildApp()
    const ready = app.ready()
    try {
      await vi.waitFor(() => expect(deliveryStartMock).toHaveBeenCalledOnce())
      expect(translationStartMock).toHaveBeenCalledOnce()
      expect(initializeSocket).not.toHaveBeenCalled()
      finish(); await ready
    } finally { finish(); await ready; await app.close() }
    expect(deliveryShutdownMock).toHaveBeenCalledOnce()
  })

})
