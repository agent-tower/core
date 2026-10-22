import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUuid } from '../uuid'

afterEach(() => vi.unstubAllGlobals())

describe('browser UUID generation', () => {
  it('uses the native UUID generator when available', () => {
    const id = '71499ffd-97d9-409d-8096-d56e164f10cf'
    const randomUUID = vi.fn(() => id)
    const getRandomValues = vi.fn()
    vi.stubGlobal('crypto', { randomUUID, getRandomValues })

    expect(createUuid()).toBe(id)
    expect(randomUUID).toHaveBeenCalledOnce()
    expect(getRandomValues).not.toHaveBeenCalled()
  })

  it.each([
    [0x00, '00000000-0000-4000-8000-000000000000'],
    [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ] as const)('preserves random bits and sets UUID v4 version/variant for byte %s', (byte, expected) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(byte))
    vi.stubGlobal('crypto', { getRandomValues })

    expect(createUuid()).toBe(expected)
    expect(getRandomValues).toHaveBeenCalledOnce()
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16)
  })

  it('generates distinct valid UUIDs with getRandomValues when randomUUID is absent', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })

    const ids = Array.from({ length: 256 }, () => createUuid())
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
