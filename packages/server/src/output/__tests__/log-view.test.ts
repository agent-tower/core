import { describe, expect, it } from 'vitest'
import {
  LIGHT_TOOL_CONTENT_LIMIT,
  LIGHT_TOOL_PREVIEW_LIMIT,
  findEntryContents,
  toLightConversation,
  toLightEntry,
  toolContentPreview,
} from '../log-view.js'
import type { NormalizedEntry } from '../types.js'

function tool(id: string, content: string, metadata: NormalizedEntry['metadata'] = { action: 'file_read', toolName: 'Read', status: 'success' }): NormalizedEntry {
  return { id, timestamp: 1, entryType: 'tool_use', content, metadata }
}

const longOutput = 'x'.repeat(LIGHT_TOOL_CONTENT_LIMIT + 10)

describe('light log view', () => {
  it('shortens a long tool output to its title paragraph and records the full length', () => {
    const content = `Reading /repo/SPEC.md\n\n${longOutput}`
    const light = toLightEntry(tool('a', content))

    expect(light.content).toBe('Reading /repo/SPEC.md')
    expect(light.contentOmitted).toBe(content.length)
    expect(content.startsWith(light.content)).toBe(true)
  })

  it('keeps the ACP input block that tool labels parse', () => {
    const input = 'Input\n{"command":"ls -la","description":"List"}'
    const light = toLightEntry(tool('a', `${input}\n\nContent\n${longOutput}`))

    expect(light.content).toBe(input)
  })

  it('bounds the prefix when the output has no paragraph break', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')
    const preview = toolContentPreview(lines)

    expect(preview.length).toBeLessThanOrEqual(LIGHT_TOOL_PREVIEW_LIMIT)
    expect(lines.startsWith(preview)).toBe(true)
    expect(preview.endsWith('\n')).toBe(false)
  })

  it('skips leading blank lines when it looks for the title paragraph', () => {
    const content = `\n\nRunning: make\n\n${longOutput}`
    const light = toLightEntry(tool('a', content))

    expect(light.content).toBe('\n\nRunning: make')
    expect(content.startsWith(light.content)).toBe(true)
  })

  it('leaves short tool outputs and other entry types untouched (same object)', () => {
    const short = tool('a', 'Running: ls\n\nfile')
    const message: NormalizedEntry = { id: 'b', timestamp: 1, entryType: 'assistant_message', content: longOutput }
    const thinking: NormalizedEntry = { id: 'c', timestamp: 1, entryType: 'thinking', content: longOutput }

    expect(toLightEntry(short)).toBe(short)
    expect(toLightEntry(message)).toBe(message)
    expect(toLightEntry(thinking)).toBe(thinking)
  })

  it('drops toolContent and fileChanges, which the web client never reads', () => {
    const entry = tool('a', 'Edit file', {
      action: 'file_edit',
      status: 'success',
      toolContent: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
      fileChanges: [{ type: 'edit', path: 'a.ts', diff: '+new' }],
    })
    const light = toLightEntry(entry)

    expect(light.metadata).toEqual({ action: 'file_edit', status: 'success' })
    expect(light.contentOmitted).toBeUndefined()
  })

  it('never mutates the source entry or conversation', () => {
    const entry = tool('a', longOutput, { action: 'file_read', status: 'success', toolContent: [{ type: 'text', text: 'x' }] })
    const conversation = { sessionId: 's', seq: 9, entries: [entry] }
    const frozen = structuredClone(conversation)

    const light = toLightConversation(conversation)

    expect(conversation).toEqual(frozen)
    expect(light.seq).toBe(9)
    expect(light.entries[0]).not.toBe(entry)
  })

  it('answers each request on its own when entries share an ID', () => {
    const entries = [tool('dup', 'first'), tool('dup', 'second, longer'), tool('b', 'bee')]

    expect(findEntryContents(entries, [{ id: 'dup', length: 14 }, { id: 'dup', length: 5 }, { id: 'b' }, { id: 'missing' }, { id: 'dup', length: 14 }]))
      .toEqual([
        { id: 'dup', length: 14, content: 'second, longer' },
        { id: 'dup', length: 5, content: 'first' },
        { id: 'b', content: 'bee' },
      ])
    // Without a matching length the first entry with the ID answers.
    expect(findEntryContents(entries, [{ id: 'dup' }, { id: 'dup', length: 99 }]))
      .toEqual([{ id: 'dup', content: 'first' }, { id: 'dup', length: 99, content: 'first' }])
  })
})
