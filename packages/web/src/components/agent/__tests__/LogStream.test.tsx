// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'
import { LogStream } from '../LogStream'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { streamdownRenderCalls, mermaidPlugin } = vi.hoisted(() => ({
  streamdownRenderCalls: [] as Array<Record<string, unknown>>,
  mermaidPlugin: () => null,
}))

vi.mock('streamdown', () => ({
  Streamdown: (props: Record<string, unknown>) => {
    streamdownRenderCalls.push(props)
    return props.children
  },
}))

vi.mock('@streamdown/mermaid', () => ({
  mermaid: mermaidPlugin,
}))

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

function errorEntry(id: string, content: string): LogEntry {
  return {
    id,
    type: LogType.Error,
    title: 'Error',
    content,
  }
}

function infoEntry(id: string, content: string): LogEntry {
  return {
    id,
    type: LogType.Info,
    content,
  }
}

function userEntry(id: string, content: string): LogEntry {
  return {
    id,
    type: LogType.User,
    content,
  }
}

function assistantEntry(id: string, content: string): LogEntry {
  return {
    id,
    type: LogType.Assistant,
    content,
  }
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function findLastStreamdownCall(content: string) {
  for (let index = streamdownRenderCalls.length - 1; index >= 0; index -= 1) {
    const call = streamdownRenderCalls[index]
    if (call?.children === content) return call
  }
  return undefined
}

async function findMermaidStreamdownCall(content: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const call = findLastStreamdownCall(content)
    if (call?.plugins) return call

    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  return findLastStreamdownCall(content)
}

describe('LogStream tool grouping', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    streamdownRenderCalls.length = 0
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

  it('renders a single error log as error block, not inside a 工具调用 group', async () => {
    const logs: LogEntry[] = [
      errorEntry('err-1', 'Session terminated unexpectedly'),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })

    expect(getToolGroupButtons(container)).toHaveLength(0)
    expect(container.textContent).toContain('Session terminated unexpectedly')
  })

  it('renders multiple consecutive error logs as error blocks, not grouped under 工具调用', async () => {
    const logs: LogEntry[] = [
      errorEntry('err-1', 'Error: connection refused'),
      errorEntry('err-2', 'Error: timeout exceeded'),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })

    expect(getToolGroupButtons(container)).toHaveLength(0)
    expect(container.textContent).toContain('Error: connection refused')
    expect(container.textContent).toContain('Error: timeout exceeded')
  })

  it('keeps error logs separate from adjacent tool logs in grouping', async () => {
    const logs: LogEntry[] = [
      successTool('tool-1', 'MCP tool call: agent-tower/list_room_messages'),
      errorEntry('err-1', 'Error: something went wrong'),
      successTool('tool-2', 'MCP tool call: agent-tower/post_room_message'),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })

    // tools before and after the error should be in separate groups
    expect(getToolGroupButtons(container)).toHaveLength(2)
    expect(container.textContent).toContain('Error: something went wrong')
  })

  it('renders info error text as normal log text, not inside a 工具调用 group', async () => {
    const logs: LogEntry[] = [
      infoEntry('info-1', 'System initialized with model: Auto'),
      infoEntry('info-2', 'Error: provider request failed'),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })

    expect(getToolGroupButtons(container)).toHaveLength(0)
    expect(container.textContent).toContain('System initialized with model: Auto')
    expect(container.textContent).toContain('Error: provider request failed')
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

  it('does not attach mermaid plugins for regular assistant markdown', async () => {
    const logs: LogEntry[] = [
      assistantEntry('assistant-1', 'Regular **markdown** response'),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })
    await flushEffects()

    const assistantCall = streamdownRenderCalls.find((props) => props.children === logs[0].content)
    expect(assistantCall?.plugins).toBeUndefined()
    expect(assistantCall?.controls).toBeUndefined()
  })

  it('attaches mermaid plugins and controls for assistant markdown diagrams', async () => {
    const content = '```mermaid\nflowchart TD\n  A --> B\n```'
    const logs: LogEntry[] = [
      assistantEntry('assistant-1', content),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })
    await flushEffects()

    const assistantCall = await findMermaidStreamdownCall(content)
    expect(assistantCall?.plugins).toEqual({ mermaid: mermaidPlugin })
    expect(assistantCall?.controls).toMatchObject({
      mermaid: {
        download: true,
        copy: true,
        fullscreen: true,
        panZoom: true,
      },
    })
  })

  it('attaches mermaid plugins and controls for user markdown diagrams', async () => {
    const content = '~~~MERMAID\nsequenceDiagram\n  A->>B: hi\n~~~'
    const logs: LogEntry[] = [
      userEntry('user-1', content),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })
    await flushEffects()

    const userCall = await findMermaidStreamdownCall(content)
    expect(userCall?.plugins).toEqual({ mermaid: mermaidPlugin })
    expect(userCall?.controls).toMatchObject({
      mermaid: {
        download: true,
        copy: true,
        fullscreen: true,
        panZoom: true,
      },
    })
  })
})
