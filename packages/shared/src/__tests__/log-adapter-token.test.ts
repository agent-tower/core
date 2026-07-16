/**
 * LogAdapter Token 转换测试
 * Property 4: LogAdapter Token 转换正确性
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { normalizedEntryToLogEntry } from '../log-adapter.js'
import type { NormalizedEntry } from '../log-adapter.js'

function makeTokenUsageEntry(
  totalTokens: number,
  modelContextWindow?: number
): NormalizedEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'token_usage_info',
    content: `Tokens: ${totalTokens}`,
    metadata: {
      tokenUsage: { totalTokens, modelContextWindow },
    },
  }
}

describe('Feature: token-usage-display, Property 4: LogAdapter Token 转换正确性', () => {
  it('should convert token_usage_info NormalizedEntry to LogEntry with tokenUsage', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.option(fc.nat(), { nil: undefined }),
        (totalTokens, modelContextWindow) => {
          const entry = makeTokenUsageEntry(totalTokens, modelContextWindow)
          const logEntry = normalizedEntryToLogEntry(entry)

          expect(logEntry).not.toBeNull()
          expect(logEntry!.timestamp).toBe(entry.timestamp)
          expect(logEntry!.tokenUsage).toBeDefined()
          expect(logEntry!.tokenUsage!.totalTokens).toBe(totalTokens)
          expect(logEntry!.tokenUsage!.modelContextWindow).toBe(modelContextWindow)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('should return null when tokenUsage metadata is missing', () => {
    const entry: NormalizedEntry = {
      id: 'test-1',
      timestamp: Date.now(),
      entryType: 'token_usage_info',
      content: '',
    }
    const logEntry = normalizedEntryToLogEntry(entry)
    expect(logEntry).toBeNull()
  })

  it('should default totalTokens to 0 when undefined', () => {
    const entry: NormalizedEntry = {
      id: 'test-2',
      timestamp: Date.now(),
      entryType: 'token_usage_info',
      content: '',
      metadata: {
        tokenUsage: {},
      },
    }
    const logEntry = normalizedEntryToLogEntry(entry)
    expect(logEntry).not.toBeNull()
    expect(logEntry!.tokenUsage!.totalTokens).toBe(0)
    expect(logEntry!.tokenUsage!.modelContextWindow).toBeUndefined()
  })
})
