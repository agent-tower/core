// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act, type ComponentType, type ReactNode, type SyntheticEvent } from 'react'
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
  useI18n: () => ({
    t: (source: string, values?: Record<string, unknown>) => Object.entries(values ?? {})
      .reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), source),
  }),
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

function withTimestamp<T extends LogEntry>(entry: T, timestamp: number): T {
  return { ...entry, timestamp }
}

function cursorEntry(processingStartedAt: number, lastOutputAt?: number): LogEntry {
  return {
    id: 'cursor',
    timestamp: Date.now(),
    type: LogType.Cursor,
    content: '',
    cursorActivity: { processingStartedAt, lastOutputAt },
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
    vi.useRealTimers()
  })

  it('renders thinking activity and timing details instead of a blinking cursor', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-07-16T12:00:00Z').getTime()
    vi.setSystemTime(now)

    await act(async () => {
      root.render(<LogStream logs={[cursorEntry(now - 65_000, now - 5_000)]} />)
    })

    const indicator = container.querySelector('.agent-thinking-shimmer')
    expect(indicator?.textContent).toBe('正在思考')
    const characters = Array.from(container.querySelectorAll<HTMLElement>('.agent-thinking-char'))
    expect(characters).toHaveLength(4)
    expect(characters.map((character) => character.style.animationDelay)).toEqual([
      '0ms',
      '45ms',
      '90ms',
      '135ms',
    ])
    expect(container.textContent).toContain('已处理 1 分 5 秒')
    expect(container.textContent).toContain('最后一次输出于 5 秒前')
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
    expect(assistantCall?.className).toContain('session-log-message-markdown')
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

  it('collapses completed processing details while keeping the final response visible', async () => {
    const onUserToggleDetails = vi.fn()
    const logs = [
      withTimestamp(userEntry('user-1', 'Implement this feature'), 1_000),
      withTimestamp(infoEntry('thinking-1', 'Planning the implementation'), 2_000),
      withTimestamp(successTool('tool-1', 'MCP tool call: agent-tower/list_room_messages'), 8_000),
      withTimestamp(assistantEntry('assistant-1', 'Intermediate progress'), 10_000),
      withTimestamp(assistantEntry('assistant-2', 'Final answer'), 12_000),
    ]

    await act(async () => {
      root.render(
        <LogStream
          logs={logs}
          isOutputActive={false}
          lastExitAt={14_000}
          onUserToggleDetails={onUserToggleDetails}
        />,
      )
    })

    expect(container.textContent).toContain('Final answer')
    expect(container.textContent).toContain('Implement this feature')

    const processedButton = Array.from(container.querySelectorAll('button')).find((button) => (
      button.textContent?.includes('已处理 13s')
    ))
    const processedContent = container.querySelector('[data-processed-content]')
    expect(processedButton).toBeDefined()
    expect(processedButton?.className).toContain('text-sm')
    expect(processedButton?.getAttribute('aria-expanded')).toBe('false')
    expect(processedContent?.getAttribute('aria-hidden')).toBe('true')
    expect(processedContent?.className).toContain('grid-rows-[0fr]')
    expect(processedContent?.textContent).toContain('Intermediate progress')
    expect(processedContent?.textContent).toContain('Planning the implementation')

    await act(async () => {
      processedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onUserToggleDetails).toHaveBeenCalledTimes(1)
    expect(processedButton?.getAttribute('aria-expanded')).toBe('true')
    expect(processedContent?.getAttribute('aria-hidden')).toBe('false')
    expect(processedContent?.className).toContain('grid-rows-[1fr]')
  })

  it('keeps the active turn expanded and collapses only earlier turns', async () => {
    const logs = [
      withTimestamp(userEntry('user-1', 'First request'), 1_000),
      withTimestamp(infoEntry('thinking-1', 'First internal details'), 2_000),
      withTimestamp(assistantEntry('assistant-1', 'First answer'), 5_000),
      withTimestamp(userEntry('user-2', 'Follow-up request'), 6_000),
      withTimestamp(infoEntry('thinking-2', 'Current internal details'), 7_000),
      withTimestamp(assistantEntry('assistant-2', 'Current answer'), 8_000),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive />)
    })

    expect(container.querySelectorAll('button[aria-expanded="false"]')).toHaveLength(1)
    expect(container.textContent).toContain('First answer')
    expect(container.textContent).toContain('Current internal details')
    const processedContent = container.querySelector('[data-processed-content]')
    expect(processedContent?.getAttribute('aria-hidden')).toBe('true')
    expect(processedContent?.textContent).toContain('First internal details')
  })

  it('auto-collapses the current turn when output changes from active to complete', async () => {
    const logs = [
      withTimestamp(userEntry('user-1', 'Request'), 1_000),
      withTimestamp(infoEntry('thinking-1', 'Details'), 2_000),
      withTimestamp(assistantEntry('assistant-1', 'Answer'), 3_000),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive />)
    })
    expect(container.textContent).toContain('Details')
    expect(container.querySelector('button[aria-expanded]')).toBeNull()
    expect(container.querySelector('[role="status"]')?.className).toContain('text-sm')

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive={false} lastExitAt={4_000} />)
    })

    expect(container.textContent).toContain('Answer')
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull()
    const processedContent = container.querySelector('[data-processed-content]')
    expect(processedContent?.getAttribute('aria-hidden')).toBe('true')
    expect(processedContent?.textContent).toContain('Details')
  })

  it('keeps a terminal error visible when there is no final assistant response', async () => {
    const logs = [
      withTimestamp(userEntry('user-1', 'Request'), 1_000),
      withTimestamp(infoEntry('info-1', 'Internal details'), 2_000),
      withTimestamp(errorEntry('error-1', 'Agent failed'), 3_000),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive={false} lastExitAt={4_000} />)
    })

    expect(container.textContent).toContain('Agent failed')
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull()
    const processedContent = container.querySelector('[data-processed-content]')
    expect(processedContent?.getAttribute('aria-hidden')).toBe('true')
    expect(processedContent?.textContent).toContain('Internal details')
  })

  it('shows a non-collapsible processing timer while the agent is running', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(11_000))
    const logs = [
      withTimestamp(userEntry('user-1', 'Request'), 1_000),
      withTimestamp(infoEntry('info-1', 'Working'), 2_000),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive />)
    })

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain('已处理 10s')
    expect(status?.className).toContain('text-sm')
    expect(container.querySelector('button[aria-expanded]')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(status?.textContent).toContain('已处理 12s')
  })

  it('keeps the persisted processing start when the virtual cursor is recreated', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(11_000))

    await act(async () => {
      root.render(<LogStream logs={[cursorEntry(1_000, 8_000)]} isOutputActive />)
    })

    expect(container.querySelector('[role="status"]')?.textContent).toContain('已处理 10s')
  })

  it('uses the persisted exit time for a completed text-only turn', async () => {
    const logs = [
      withTimestamp(userEntry('user-1', 'Question'), 1_000),
      withTimestamp(assistantEntry('assistant-1', 'Text-only answer'), 4_000),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive={false} lastExitAt={28_000} />)
    })

    expect(container.textContent).toContain('已处理 27s')
    expect(container.textContent).toContain('Text-only answer')
  })

  it('routes loopback links from session messages to Preview', async () => {
    const onOpenPreviewUrl = vi.fn()
    const content = '[Open app](http://localhost:4173/dashboard?from=agent#ready)'

    await act(async () => {
      root.render(
        <LogStream
          logs={[assistantEntry('assistant-preview', content)]}
          onOpenPreviewUrl={onOpenPreviewUrl}
        />,
      )
    })

    const call = findLastStreamdownCall(content)
    const Link = (call?.components as {
      a?: ComponentType<{
        href?: string
        children?: ReactNode
        onClick?: (event: SyntheticEvent) => void
      }>
    } | undefined)?.a
    expect(Link).toBeDefined()
    if (!Link) throw new Error('markdown link component not found')

    await act(async () => {
      root.render(<Link href="http://localhost:4173/dashboard?from=agent#ready">Open app</Link>)
    })
    const anchor = container.querySelector('a')
    expect(anchor).not.toBeNull()

    await act(async () => {
      anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    expect(onOpenPreviewUrl).toHaveBeenCalledWith('http://localhost:4173/dashboard?from=agent#ready')

    onOpenPreviewUrl.mockClear()
    await act(async () => {
      root.render(
        <Link href="https://example.com/docs" onClick={(event: SyntheticEvent) => event.preventDefault()}>
          Documentation
        </Link>,
      )
    })
    await act(async () => {
      container.querySelector('a')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onOpenPreviewUrl).not.toHaveBeenCalled()
  })
})
