import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(() => ({
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    onAny: vi.fn(),
  })),
}))

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

import { socketManager } from '../manager'

describe('socketManager', () => {
  beforeEach(() => {
    socketManager.disconnect()
    mockIo.mockClear()
  })

  afterEach(() => {
    socketManager.disconnect()
  })

  it('creates a socket connection without auth.token', () => {
    socketManager.getSocket()

    expect(mockIo).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({
        auth: expect.anything(),
      }),
    )
  })
})
