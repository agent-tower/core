import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('./services/tunnel.service.js', () => ({
  TunnelService: {
    isRunning: vi.fn(() => false),
    validateToken: vi.fn(() => true),
    stop: vi.fn(),
  },
}))

import { buildApp } from './app.js'

const originalWebDir = process.env.AGENT_TOWER_WEB_DIR

let tempWebDir = ''

describe('buildApp static web hosting', () => {
  beforeEach(() => {
    tempWebDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-web-'))
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
