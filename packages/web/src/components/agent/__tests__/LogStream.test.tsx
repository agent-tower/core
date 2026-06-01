// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'
import { LogStream } from '../LogStream'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string) => source }),
}))

function successTool(id: string, content: string): LogEntry {
  return {
    id,
    type: LogType.Tool,
    title: 'Tool ✓',
    content,
    tool: {
      action: 'tool',
      name: 'post_room_message',
      id,
      status: 'success',
    },
  }
}

function approvalTool(id: string): LogEntry {
  return {
    id,
    type: LogType.Tool,
    title: 'Tool (待审批)',
    content: 'MCP tool call: agent-tower/post_room_message',
    tool: {
      action: 'tool',
      name: 'post_room_message',
      id,
      status: 'pending_approval',
    },
  }
}

function getToolGroupButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button')).filter((button) => (
    button.textContent?.includes('工具调用')
  ))
}

describe('LogStream tool grouping', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('keeps successful tools grouped when their business text contains confirmation keywords', async () => {
    const logs: LogEntry[] = [
      successTool('tool-1', [
        'MCP tool call: agent-tower/list_room_messages',
        'Result: {"content":"用户需要确认选项"}',
      ].join('\n')),
      successTool('tool-2', 'MCP tool call: agent-tower/post_room_message'),
      successTool('tool-3', [
        'MCP tool call: agent-tower/post_room_message',
        'Arguments: {"content":"please confirm approval details"}',
      ].join('\n')),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })

    const groupButtons = getToolGroupButtons(container)
    expect(groupButtons).toHaveLength(1)
    expect(groupButtons[0].textContent).toContain('3')
    expect(groupButtons[0].textContent).toContain('MCP tool call: agent-tower/list_room')
    expect(groupButtons[0].textContent).toContain('MCP tool call: agent-tower/post_room')
  })

  it('still lifts tools with explicit pending approval status out of the execution group', async () => {
    const logs: LogEntry[] = [
      successTool('tool-1', 'MCP tool call: agent-tower/list_room_messages'),
      approvalTool('tool-2'),
      successTool('tool-3', 'MCP tool call: agent-tower/post_room_message'),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })

    const groupButtons = getToolGroupButtons(container)
    expect(groupButtons).toHaveLength(2)
    expect(groupButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('1'),
      expect.stringContaining('1'),
    ])
    expect(container.textContent).toContain('Tool')
    expect(container.textContent).toContain('MCP tool call: agent-tower/post_room_message')
  })
})
