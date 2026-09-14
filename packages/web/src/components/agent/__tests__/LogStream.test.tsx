// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act, type ComponentType, type ReactNode, type SyntheticEvent } from 'react'
import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'
import { LogStream } from '../LogStream'
import { shouldAdjustScrollPositionOnItemSizeChange } from '../scrollAnchoring'

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

function warningEntry(id: string, content: string): LogEntry {
  return {
    id,
    type: LogType.Warning,
    title: 'Warning',
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

function thinkingEntry(id: string, content: string): LogEntry {
  return {
    id,
    type: LogType.Info,
    title: 'Thinking',
    content,
  }
}

function acpTool(id: string, title: string, content: string): LogEntry {
  return {
    id,
    type: LogType.Tool,
    title: `${title} ✓`,
    content,
    tool: {
      action: 'command_run',
      name: title,
      id,
      kind: 'execute',
      status: 'success',
    },
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

  it('keeps interleaved ACP thinking and tools in one generic execution group', async () => {
    const logs: LogEntry[] = [
      thinkingEntry('thinking-1', '**Identifying browser skill**'),
      acpTool('tool-1', 'Read agent-browser skill', 'Input\n{"path":"SKILL.md"}'),
      thinkingEntry('thinking-2', '**Planning network access**'),
      acpTool('tool-2', 'Open Google News', 'Output\nGoogle 新闻'),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })

    const [groupButton] = getToolGroupButtons(container)
    expect(groupButton).toBeDefined()
    expect(groupButton?.textContent).toContain('工具调用')
    expect(groupButton?.textContent).toContain('2')
    expect(groupButton?.textContent).not.toContain('Planning network access')
    expect(getToolGroupButtons(container)).toHaveLength(1)

    await act(async () => {
      groupButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Read agent-browser skill')
    expect(container.textContent).toContain('Open Google News')
    expect(container.textContent).toContain('Identifying browser skill')
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

  it('renders a non-blocking warning in pale yellow and outside 工具调用 groups', async () => {
    const logs: LogEntry[] = [
      successTool('tool-1', 'MCP tool call: agent-tower/list_room_messages'),
      warningEntry('warning-1', 'MCP server `agent-tower` failed to start: connection closed'),
      successTool('tool-2', 'MCP tool call: agent-tower/post_room_message'),
    ]

    await act(async () => {
      root.render(<LogStream logs={logs} />)
    })

    expect(getToolGroupButtons(container)).toHaveLength(2)
    const warning = Array.from(container.querySelectorAll('div')).find((element) => (
      element.classList.contains('bg-amber-50/70')
    ))
    expect(warning).toBeDefined()
    expect(warning?.classList.contains('border-amber-200')).toBe(true)
    expect(warning?.textContent).toContain('MCP server `agent-tower` failed to start')
    expect(warning?.className).not.toContain('red')
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
    expect(processedButton).toBeDefined()
    expect(processedButton?.className).toContain('text-sm')
    expect(processedButton?.getAttribute('aria-expanded')).toBe('false')
    // Collapsed detail rows are not mounted at all — that is what keeps long
    // sessions at O(viewport) instead of O(entries).
    expect(container.querySelectorAll('[data-processed-content]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Intermediate progress')
    expect(container.textContent).not.toContain('Planning the implementation')

    await act(async () => {
      processedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onUserToggleDetails).toHaveBeenCalledTimes(1)
    expect(processedButton?.getAttribute('aria-expanded')).toBe('true')
    const expandedContent = Array.from(container.querySelectorAll('[data-processed-content]'))
    expect(expandedContent.length).toBeGreaterThan(0)
    expect(expandedContent.map((row) => row.textContent).join(' ')).toContain('Intermediate progress')
    expect(container.textContent).toContain('Planning the implementation')
    expect(container.textContent).toContain('Final answer')

    await act(async () => {
      processedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(processedButton?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-processed-content]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Intermediate progress')
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
    // The collapsed earlier turn keeps its details unmounted.
    expect(container.querySelectorAll('[data-processed-content]')).toHaveLength(0)
    expect(container.textContent).not.toContain('First internal details')
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
    expect(container.querySelectorAll('[data-processed-content]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Details')
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
    expect(container.querySelectorAll('[data-processed-content]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Internal details')
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

  it('routes Codex inline visualization directives to the visualization handler', async () => {
    const onOpenVisualization = vi.fn()
    const content = '::codex-inline-vis{file="agent-tower-architecture.html"}'

    await act(async () => {
      root.render(
        <LogStream
          logs={[assistantEntry('assistant-visualization', content)]}
          onOpenVisualization={onOpenVisualization}
        />,
      )
    })

    const call = [...streamdownRenderCalls].reverse().find((item) => (
      typeof item.children === 'string'
      && item.children.includes('/__agent-tower/message-intent/codex-inline-vis')
    ))
    expect(call?.children).toContain('/__agent-tower/message-intent/codex-inline-vis')
    const Link = (call?.components as {
      a?: ComponentType<{
        href?: string
        children?: ReactNode
      }>
    } | undefined)?.a
    expect(Link).toBeDefined()
    if (!Link) throw new Error('markdown link component not found')

    await act(async () => {
      root.render(
        <Link href="/__agent-tower/message-intent/codex-inline-vis?file=agent-tower-architecture.html">
          agent-tower-architecture.html
        </Link>,
      )
    })
    const button = container.querySelector('button')
    expect(button?.textContent).toContain('agent-tower-architecture.html')
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onOpenVisualization).toHaveBeenCalledWith('agent-tower-architecture.html')
  })

  it('renders agent download directives as session-scoped download links', async () => {
    const content = '::agent-download{file="output/final-report.pdf"}'

    await act(async () => {
      root.render(
        <LogStream
          logs={[assistantEntry('assistant-download', content)]}
          downloadSessionId="session/1"
        />,
      )
    })

    const call = [...streamdownRenderCalls].reverse().find((item) => (
      typeof item.children === 'string'
      && item.children.includes('/__agent-tower/message-intent/agent-download')
    ))
    const Link = (call?.components as {
      a?: ComponentType<{
        href?: string
        children?: ReactNode
      }>
    } | undefined)?.a
    expect(Link).toBeDefined()
    if (!Link) throw new Error('markdown link component not found')

    await act(async () => {
      root.render(
        <Link href="/__agent-tower/message-intent/agent-download?file=output%2Ffinal-report.pdf">
          output/final-report.pdf
        </Link>,
      )
    })

    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toContain('/sessions/session%2F1/artifacts/download?path=output%2Ffinal-report.pdf')
    expect(anchor?.getAttribute('download')).toBe('final-report.pdf')
  })
})

// ============ Virtualization ============

const ROW_TEST_HEIGHT = 40

function createVirtualScrollElement(viewportHeight = 800): HTMLDivElement {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientHeight', { value: viewportHeight, configurable: true })
  Object.defineProperty(element, 'offsetHeight', { value: viewportHeight, configurable: true })
  Object.defineProperty(element, 'scrollHeight', { value: viewportHeight, configurable: true })
  element.scrollTop = 0
  return element
}

/**
 * happy-dom ships a no-op `ResizeObserver`, so the component's viewport
 * observation is driven manually to emulate `display: none` → visible.
 */
class ControllableResizeObserver {
  static instances: ControllableResizeObserver[] = []
  readonly targets = new Set<Element>()
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ControllableResizeObserver.instances.push(this)
  }

  observe = (target: Element) => { this.targets.add(target) }
  unobserve = (target: Element) => { this.targets.delete(target) }
  disconnect = () => { this.targets.clear() }

  /**
   * Delivers one resize batch. `include` mirrors what a browser does: it only
   * reports elements that are still rendered, so a test can leave stale
   * observations in place and still emit exactly the callbacks Chrome would.
   */
  emit = (include?: (target: Element) => boolean) => {
    const targets = [...this.targets].filter((target) => include?.(target) ?? true)
    if (targets.length === 0) return
    const entries = targets.map((target) => ({ target }) as ResizeObserverEntry)
    this.callback(entries, this as unknown as ResizeObserver)
  }
}

describe('LogStream virtualization', () => {
  let container: HTMLDivElement
  let root: Root
  let scrollElement: HTMLDivElement
  let scrollElementRef: { current: HTMLElement | null }
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect

  beforeEach(() => {
    streamdownRenderCalls.length = 0
    ControllableResizeObserver.instances.length = 0
    vi.stubGlobal('ResizeObserver', ControllableResizeObserver)
    // happy-dom has no layout engine, so give every element a deterministic box
    // for the virtualizer to measure.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: ROW_TEST_HEIGHT,
        width: 0,
        height: ROW_TEST_HEIGHT,
        toJSON: () => ({}),
      } as DOMRect
    }
    scrollElement = createVirtualScrollElement()
    scrollElementRef = { current: scrollElement }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
    vi.unstubAllGlobals()
    container.remove()
  })

  it('mounts only a window of rows for a long running turn', async () => {
    const logs = Array.from({ length: 200 }, (_, index) => (
      withTimestamp(infoEntry(`info-${index}`, `line ${index}`), 1_000 + index)
    ))

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive scrollElementRef={scrollElementRef} />)
    })

    const rows = container.querySelectorAll('[data-index]')
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.length).toBeLessThan(60)
    expect(container.textContent).toContain('line 0')
    expect(container.textContent).not.toContain('line 199')
  })

  it('does not mount collapsed history rows and windows them once expanded', async () => {
    const logs: LogEntry[] = [withTimestamp(userEntry('user-1', 'Request'), 1_000)]
    for (let index = 0; index < 60; index += 1) {
      logs.push(withTimestamp(successTool(`tool-${index}`, `tool output ${index}`), 2_000 + index))
      logs.push(withTimestamp(warningEntry(`warning-${index}`, `warning ${index}`), 3_000 + index))
    }
    logs.push(withTimestamp(assistantEntry('assistant-1', 'Final answer'), 9_000))

    await act(async () => {
      root.render(
        <LogStream
          logs={logs}
          isOutputActive={false}
          lastExitAt={10_000}
          scrollElementRef={scrollElementRef}
        />,
      )
    })

    // user + summary + final response; the 120 collapsed detail rows stay out of the DOM.
    expect(container.querySelectorAll('[data-index]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-processed-content]')).toHaveLength(0)

    const header = container.querySelector<HTMLElement>('[data-at-group-header]')
    expect(header).not.toBeNull()

    await act(async () => {
      header?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const expandedRows = container.querySelectorAll('[data-processed-content]')
    expect(expandedRows.length).toBeGreaterThan(5)
    expect(expandedRows.length).toBeLessThan(50)

    await act(async () => {
      header?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelectorAll('[data-processed-content]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-index]')).toHaveLength(3)
  })

  it('keeps row identity and measured height when the active turn completes', async () => {
    // The streaming answer is far taller than the 32px estimate. If the row is
    // treated as new when the turn completes, its measured height is dropped and
    // the layout below it collapses back to the estimate.
    const ANSWER_HEIGHT = 480
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const height = (this.textContent ?? '').includes('streaming answer') ? ANSWER_HEIGHT : ROW_TEST_HEIGHT
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: height,
        width: 0,
        height,
        toJSON: () => ({}),
      } as DOMRect
    }

    const logs: LogEntry[] = [withTimestamp(userEntry('user-1', 'Request'), 1_000)]
    for (let index = 0; index < 6; index += 1) {
      logs.push(withTimestamp(successTool(`tool-${index}`, `tool output ${index}`), 2_000 + index))
    }
    logs.push(withTimestamp(assistantEntry('assistant-1', 'streaming answer'), 3_000))

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive scrollElementRef={scrollElementRef} />)
    })

    // Running turn: user + summary + execution group + the streaming answer.
    const runningRow = container.querySelector<HTMLElement>('[data-at-row="item:assistant-1"]')
    expect(runningRow).not.toBeNull()
    const runningTrack = runningRow?.parentElement
    expect(runningTrack?.style.height).toBe(`${ROW_TEST_HEIGHT * 3 + ANSWER_HEIGHT}px`)

    await act(async () => {
      root.render(
        <LogStream
          logs={logs}
          isOutputActive={false}
          lastExitAt={10_000}
          scrollElementRef={scrollElementRef}
        />,
      )
    })

    // Completed turn: the same log is now the final row. Identity (same DOM
    // node, so local expand state survives) and the measured height must both
    // survive; the collapsed execution group is gone, so only two rows precede it.
    const completedRow = container.querySelector<HTMLElement>('[data-at-row="item:assistant-1"]')
    expect(completedRow).toBe(runningRow)
    const completedTrack = completedRow?.parentElement
    expect(completedTrack?.style.height).toBe(`${ROW_TEST_HEIGHT * 2 + ANSWER_HEIGHT}px`)
    expect(completedRow?.getAttribute('data-processed-content')).toBeNull()
    expect(scrollElement.scrollTop).toBe(0)
  })

  it('re-measures and returns to virtualization when a hidden viewport becomes visible', async () => {
    const logs = Array.from({ length: 200 }, (_, index) => (
      withTimestamp(infoEntry(`info-${index}`, `line ${index}`), 1_000 + index)
    ))

    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive scrollElementRef={scrollElementRef} />)
    })

    expect(container.querySelectorAll('[data-index]').length).toBeLessThan(60)
    expect(container.textContent).not.toContain('line 199')

    // The suite pins `getBoundingClientRect()` to a constant, so the virtualizer's
    // own rect observation cannot see the size change; only the component's own
    // viewport observation can bring the windowed rendering back.
    const observers = ControllableResizeObserver.instances.filter((observer) => observer.targets.has(scrollElement))
    expect(observers.length).toBeGreaterThan(0)

    // Hidden through CSS: the component stays mounted while the viewport loses
    // its box, so the fallback rendering takes over.
    Object.defineProperty(scrollElement, 'clientHeight', { value: 0, configurable: true })
    await act(async () => {
      observers.forEach((observer) => observer.emit())
    })
    expect(container.querySelectorAll('[data-index]')).toHaveLength(0)
    expect(container.textContent).toContain('line 199')

    // Visible again: without an observation there is no state update that could
    // leave the O(entries) fallback behind.
    Object.defineProperty(scrollElement, 'clientHeight', { value: 800, configurable: true })
    await act(async () => {
      observers.forEach((observer) => observer.emit())
    })
    expect(container.querySelectorAll('[data-index]').length).toBeGreaterThan(5)
    expect(container.querySelectorAll('[data-index]').length).toBeLessThan(60)
    expect(container.textContent).not.toContain('line 199')
  })

  it('tears the measured rows down instead of reusing them as fallback rows', async () => {
    // React repurposing a measured row as a fallback row strips `data-index`
    // while react-virtual's per-row ResizeObserver keeps observing the node:
    // its next callback warns ("Missing attribute name 'data-index={index}' on
    // measured element.") and drops that measurement.
    const warnings: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(' '))
    })

    try {
      const logs = Array.from({ length: 200 }, (_, index) => (
        withTimestamp(infoEntry(`info-${index}`, `line ${index}`), 1_000 + index)
      ))

      await act(async () => {
        root.render(<LogStream logs={logs} isOutputActive scrollElementRef={scrollElementRef} />)
      })

      const measuredRows = Array.from(container.querySelectorAll<HTMLElement>('[data-index]'))
      expect(measuredRows.length).toBeGreaterThan(5)
      const rowObserver = ControllableResizeObserver.instances.find((observer) => (
        measuredRows.some((row) => observer.targets.has(row))
      ))
      expect(rowObserver).toBeDefined()

      // Hidden through CSS: the viewport loses its box, so the component
      // switches to the fallback rendering while staying mounted.
      Object.defineProperty(scrollElement, 'clientHeight', { value: 0, configurable: true })
      await act(async () => {
        ControllableResizeObserver.instances
          .filter((observer) => observer.targets.has(scrollElement))
          .forEach((observer) => observer.emit())
      })

      expect(container.querySelectorAll('[data-index]')).toHaveLength(0)
      expect(container.textContent).toContain('line 199')

      // Every measured row must be gone from the document; none of them may
      // come back as a fallback row without `data-index`.
      expect(measuredRows.every((row) => !row.isConnected)).toBe(true)

      // A browser only reports elements that are still rendered, so this is the
      // exact callback batch react-virtual would receive after the switch.
      await act(async () => {
        rowObserver?.emit((target) => target.isConnected)
      })
      expect(warnings.filter((message) => message.includes('data-index'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

// ============ Scroll anchoring ============

/**
 * The virtualizer caches each row's measurement, so the predicate receives the
 * row's *pre-resize* box plus the size delta; the viewport top has to be read in
 * the same coordinate system, including the adjustments already compensated for
 * earlier rows in this measurement pass.
 */
function anchoringItem(start: number, end: number): VirtualItem {
  return { start, end } as VirtualItem
}

function anchoringInstance(scrollOffset: number, scrollAdjustments = 0) {
  return {
    getScrollOffset: () => scrollOffset,
    scrollAdjustments,
  } as unknown as Virtualizer<HTMLElement, Element>
}

/** The library default the custom policy replaces. */
function libraryDefaultPredicate(
  item: VirtualItem,
  instance: Virtualizer<HTMLElement, Element>,
): boolean {
  const coordinates = instance as unknown as { getScrollOffset: () => number; scrollAdjustments: number }
  return item.start < coordinates.getScrollOffset() + coordinates.scrollAdjustments
}

describe('LogStream scroll anchoring predicate', () => {
  it('compensates only rows that end above the viewport after the resize', () => {
    const instance = anchoringInstance(1_000)

    // Fully above before and after: the growth pushes everything below it down.
    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(200, 240), 40, instance)).toBe(true)
    // Crossing case: was above when last measured, grew into the viewport.
    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(960, 1_000), 80, instance)).toBe(false)
    // Touching the boundary keeps no visible pixel, so it counts as above.
    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(920, 960), 40, instance)).toBe(true)
    // Inside the viewport: growth must not move the reader.
    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(1_000, 1_040), 40, instance)).toBe(false)
    // Spanning row (long streaming message): the F1 regression.
    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(400, 1_800), 24, instance)).toBe(false)
    // Fully below the viewport.
    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(2_000, 2_040), 40, instance)).toBe(false)
  })

  it('treats shrink the same way, so a spanning row never drags the reader', () => {
    const instance = anchoringInstance(1_000)

    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(200, 240), -100, instance)).toBe(true)
    // F2: the same spanning row shrinks by thousands of pixels but still ends
    // below the viewport top, so nothing is compensated.
    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(400, 3_828), -2_500, instance)).toBe(false)
  })

  it('adds the adjustments already applied in this measurement pass to the boundary', () => {
    // The first row in the pass compensated +40, which the DOM has not reported
    // back through a scroll event yet.
    const pending = anchoringItem(880, 920)
    expect(shouldAdjustScrollPositionOnItemSizeChange(pending, 120, anchoringInstance(1_000, 40))).toBe(true)
    expect(shouldAdjustScrollPositionOnItemSizeChange(pending, 120, anchoringInstance(1_000, 0))).toBe(false)
  })

  it('disagrees with the library default exactly on viewport-crossing rows', () => {
    const spanning = anchoringItem(400, 1_800)
    const crossing = anchoringItem(960, 1_000)
    const instance = anchoringInstance(1_000)

    // Why the custom policy exists: the default compensates by +24px per resize,
    // dragging the reader into the text that just appeared below the fold.
    expect(libraryDefaultPredicate(spanning, instance)).toBe(true)
    expect(shouldAdjustScrollPositionOnItemSizeChange(spanning, 24, instance)).toBe(false)

    // Same disagreement on the crossing row, where the old predicate (pre-resize
    // `item.end <= scrollOffset`) also compensated.
    expect(libraryDefaultPredicate(crossing, instance)).toBe(true)
    expect(shouldAdjustScrollPositionOnItemSizeChange(crossing, 80, instance)).toBe(false)

    // Both agree on rows that genuinely sit above the viewport.
    const above = anchoringItem(200, 240)
    expect(libraryDefaultPredicate(above, instance)).toBe(true)
    expect(shouldAdjustScrollPositionOnItemSizeChange(above, 40, instance)).toBe(true)
  })

  it('pins the F1 drift at 0 for the custom policy and 96px for the library default', () => {
    // The F1 scenario from the controlled A/B (docs §14.5/§14.6): a 3428px row
    // whose top sits 250px above the viewport (start 160, viewport top 410)
    // grows by +24px four times. Every patch pushes the library default's reader
    // one patch further into the appended text; the custom policy must not move
    // them at all. The live guard against deleting the policy is the behavioral
    // F1 case below — this pins the magnitude and the predicate semantics.
    const VIEWPORT_TOP = 410
    const SPANNING_START = 160
    const SPANNING_END = 160 + 3_428
    const driftOf = (
      policy: (item: VirtualItem, delta: number, instance: Virtualizer<HTMLElement, Element>) => boolean,
    ) => {
      let offset = VIEWPORT_TOP
      return Array.from({ length: 4 }, (_, patch) => {
        const grown = anchoringItem(SPANNING_START, SPANNING_END + 24 * patch)
        if (policy(grown, 24, anchoringInstance(offset))) offset += 24
        return offset - VIEWPORT_TOP
      })
    }

    expect(driftOf(shouldAdjustScrollPositionOnItemSizeChange)).toEqual([0, 0, 0, 0])
    expect(driftOf((item, _delta, instance) => libraryDefaultPredicate(item, instance)))
      .toEqual([24, 48, 72, 96])
  })

  it('does not compensate a row that shrinks inside the viewport', () => {
    // Same rule in the other direction: a row with visible pixels keeps them.
    expect(shouldAdjustScrollPositionOnItemSizeChange(anchoringItem(1_000, 1_040), -24, anchoringInstance(1_000)))
      .toBe(false)
  })
})

describe('LogStream scroll anchoring on the real virtualizer', () => {
  let container: HTMLDivElement
  let root: Root
  let scrollElement: HTMLDivElement
  let scrollElementRef: { current: HTMLElement | null }
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
  /** Content marker → rendered height, so a single row can change size between measurements. */
  const rowHeights = new Map<string, number>()

  beforeEach(() => {
    ControllableResizeObserver.instances.length = 0
    rowHeights.clear()
    vi.stubGlobal('ResizeObserver', ControllableResizeObserver)
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const text = this.textContent ?? ''
      let height = ROW_TEST_HEIGHT
      for (const [marker, value] of rowHeights) {
        if (text.includes(marker)) {
          height = value
          break
        }
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: height,
        width: 0,
        height,
        toJSON: () => ({}),
      } as DOMRect
    }
    scrollElement = createVirtualScrollElement()
    scrollElementRef = { current: scrollElement }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
    vi.unstubAllGlobals()
    container.remove()
  })

  const renderStream = async (logs: LogEntry[]) => {
    await act(async () => {
      root.render(<LogStream logs={logs} isOutputActive scrollElementRef={scrollElementRef} />)
    })
  }

  const scrollTo = async (top: number) => {
    await act(async () => {
      scrollElement.scrollTop = top
      scrollElement.dispatchEvent(new Event('scroll'))
    })
  }

  /** Changes one row's measured height and re-runs the virtualizer's own resize observation. */
  const resizeRow = async (rowKey: string, marker: string, height: number) => {
    const node = container.querySelector(`[data-at-row="${rowKey}"]`)
    expect(node).not.toBeNull()
    rowHeights.set(marker, height)
    const observer = ControllableResizeObserver.instances.find((candidate) => candidate.targets.has(node as Element))
    expect(observer).toBeDefined()
    await act(async () => {
      observer?.emit()
    })
  }

  /** Changes several rows' heights in a single measurement pass (one commit). */
  const resizeRows = async (changes: Array<{ rowKey: string; marker: string; height: number }>) => {
    for (const change of changes) rowHeights.set(change.marker, change.height)
    const [first] = changes
    const node = container.querySelector(`[data-at-row="${first?.rowKey}"]`)
    expect(node).not.toBeNull()
    const observer = ControllableResizeObserver.instances.find((candidate) => candidate.targets.has(node as Element))
    expect(observer).toBeDefined()
    await act(async () => {
      observer?.emit()
    })
  }

  /** The row's offset in the virtualizer's track coordinates. */
  const rowTrackOffset = (rowKey: string) => {
    const node = container.querySelector<HTMLElement>(`[data-at-row="${rowKey}"]`)
    expect(node).not.toBeNull()
    const match = /translateY\((-?[\d.]+)px\)/.exec(node?.style.transform ?? '')
    expect(match).not.toBeNull()
    return Number(match?.[1])
  }

  /** Where the row actually sits in the viewport — what the reader sees. */
  const rowViewportOffset = (rowKey: string) => rowTrackOffset(rowKey) - scrollElement.scrollTop

  it('does not compensate a row that grows across the viewport top', async () => {
    const marked = new Set([21, 22, 23, 46])
    const logs = Array.from({ length: 200 }, (_, index) => withTimestamp(
      infoEntry(`info-${index}`, marked.has(index) ? `line ${index} MARK` : `line ${index}`),
      1_000 + index,
    ))

    await renderStream(logs)
    // A summary row precedes the items, so item N measures [40(N+1), 40(N+2)).
    await scrollTo(1_000)

    // A row below the viewport never moves the reader.
    await resizeRow('item:info-46', 'line 46 MARK', ROW_TEST_HEIGHT + 200)
    expect(scrollElement.scrollTop).toBe(1_000)

    // Row info-23 ends exactly at the viewport top before this resize and grows
    // into the viewport: moving the reader would hide the text it grew into.
    await resizeRow('item:info-23', 'line 23 MARK', ROW_TEST_HEIGHT + 80)
    expect(scrollElement.scrollTop).toBe(1_000)

    // Row info-22 lands exactly on the boundary (960 + 40): no visible pixel is
    // left above, so it is compensated.
    await resizeRow('item:info-22', 'line 22 MARK', ROW_TEST_HEIGHT + 40)
    expect(scrollElement.scrollTop).toBe(1_040)

    // Row info-21 is measured 120px taller while the +40 compensation has not
    // been reported back as a scroll event yet: the boundary must include it.
    await resizeRow('item:info-21', 'line 21 MARK', ROW_TEST_HEIGHT + 120)
    expect(scrollElement.scrollTop).toBe(1_160)
  })

  it('keeps the reader anchored while a viewport-spanning row grows', async () => {
    const SPANNING_HEIGHT = 3_428
    const logs: LogEntry[] = [
      withTimestamp(infoEntry('info-0', 'line 0'), 1_000),
      withTimestamp(infoEntry('info-1', 'line 1 ABOVE'), 1_001),
      withTimestamp(infoEntry('info-2', 'line 2'), 1_002),
      withTimestamp(infoEntry('info-tall', 'SPANNING ROW'), 1_003),
    ]
    for (let index = 0; index < 60; index += 1) {
      logs.push(withTimestamp(infoEntry(`info-${10 + index}`, `line ${10 + index}`), 2_000 + index))
    }
    rowHeights.set('SPANNING ROW', SPANNING_HEIGHT)

    await renderStream(logs)
    // A summary row precedes the items: the spanning row starts at 4 * 40 = 160
    // and ends at 160 + 3428; scrolling to 410 leaves its top 250px above the
    // viewport top, exactly like the F1 regression scenario.
    await scrollTo(410)
    expect(container.querySelector('[data-at-row="item:info-tall"]')).not.toBeNull()

    // F1: four growths while the row's top sits above the viewport. The library
    // default compensates +24px each time (96px of drift, dragging the reader
    // into the appended text); deleting the custom policy must fail here.
    for (let step = 1; step <= 4; step += 1) {
      await resizeRow('item:info-tall', 'SPANNING ROW', SPANNING_HEIGHT + 24 * step)
      expect(scrollElement.scrollTop).toBe(410)
    }

    // A row that is fully above the viewport still compensates its growth, so
    // the visible content keeps its position.
    await resizeRow('item:info-1', 'line 1 ABOVE', ROW_TEST_HEIGHT + 40)
    expect(scrollElement.scrollTop).toBe(450)
  })

  it('keeps the reader anchored while a viewport-spanning row shrinks', async () => {
    const SPANNING_HEIGHT = 3_428
    const logs: LogEntry[] = [
      withTimestamp(infoEntry('info-0', 'line 0'), 1_000),
      withTimestamp(infoEntry('info-1', 'line 1'), 1_001),
      withTimestamp(infoEntry('info-2', 'line 2'), 1_002),
      withTimestamp(infoEntry('info-tall', 'SPANNING ROW'), 1_003),
    ]
    for (let index = 0; index < 60; index += 1) {
      logs.push(withTimestamp(infoEntry(`info-${10 + index}`, `line ${10 + index}`), 2_000 + index))
    }
    rowHeights.set('SPANNING ROW', SPANNING_HEIGHT)

    await renderStream(logs)
    await scrollTo(410)
    expect(rowViewportOffset('item:info-tall')).toBe(160 - 410)

    // F2: the same spanning row collapses by 2592px, but its post-resize end
    // (996) is still below the viewport top (410), so it keeps visible pixels
    // and nothing is compensated. The library default would drag the reader up
    // by the whole shrink.
    await resizeRow('item:info-tall', 'SPANNING ROW', SPANNING_HEIGHT - 2_592)
    expect(scrollElement.scrollTop).toBe(410)
    expect(rowViewportOffset('item:info-tall')).toBe(160 - 410)
  })

  it('compensates four rows growing in one commit and keeps visible rows still', async () => {
    const marked = new Set([17, 18, 19, 20])
    const logs = Array.from({ length: 200 }, (_, index) => withTimestamp(
      infoEntry(`info-${index}`, marked.has(index) ? `line ${index} MARK` : `line ${index}`),
      1_000 + index,
    ))

    await renderStream(logs)
    await scrollTo(1_000)
    const visibleBefore = rowViewportOffset('item:info-30')

    // F3: one commit, four rows above the viewport, +88px each (+352px total).
    // Every one of them still ends above the viewport top after growing
    // (40 * (index + 2) + 88 <= 1000), so each compensates its own delta.
    await resizeRows([17, 18, 19, 20].map((index) => ({
      rowKey: `item:info-${index}`,
      marker: `line ${index} MARK`,
      height: ROW_TEST_HEIGHT + 88,
    })))

    expect(scrollElement.scrollTop).toBe(1_000 + 352)
    // The reader keeps their place: the compensation equals the total growth,
    // so the visible row has the same offset relative to the viewport.
    await scrollTo(scrollElement.scrollTop)
    expect(rowViewportOffset('item:info-30')).toBe(visibleBefore)
  })

  it('does not compensate a row that resizes inside the viewport', async () => {
    const logs = Array.from({ length: 200 }, (_, index) => withTimestamp(
      infoEntry(`info-${index}`, index === 30 ? 'line 30 MARK' : `line ${index}`),
      1_000 + index,
    ))

    await renderStream(logs)
    await scrollTo(1_000)
    const visibleBefore = rowViewportOffset('item:info-30')

    // Growth inside the viewport: the row keeps its visible pixels, so the
    // reader must not be moved.
    await resizeRow('item:info-30', 'line 30 MARK', ROW_TEST_HEIGHT + 200)
    expect(scrollElement.scrollTop).toBe(1_000)
    expect(rowViewportOffset('item:info-30')).toBe(visibleBefore)

    // Shrink inside the viewport: same rule.
    await resizeRow('item:info-30', 'line 30 MARK', ROW_TEST_HEIGHT - 16)
    expect(scrollElement.scrollTop).toBe(1_000)
    expect(rowViewportOffset('item:info-30')).toBe(visibleBefore)
  })

  it('does not drift the anchor across ten rapid appends', async () => {
    let logs = Array.from({ length: 60 }, (_, index) => withTimestamp(
      infoEntry(`info-${index}`, `line ${index}`),
      1_000 + index,
    ))

    await renderStream(logs)
    await scrollTo(1_000)
    const anchor = container.querySelector('[data-at-row="item:info-30"]')
    const anchorOffset = rowViewportOffset('item:info-30')

    // F4: ten appends arrive back to back with no scroll event in between. Text
    // appended below the viewport must not move the reader, however many rows
    // arrive, and must not push the stream out of its windowed rendering.
    for (let step = 0; step < 10; step += 1) {
      logs = [...logs, withTimestamp(infoEntry(`appended-${step}`, `appended ${step}`), 5_000 + step)]
      await renderStream(logs)
    }

    expect(scrollElement.scrollTop).toBe(1_000)
    expect(rowViewportOffset('item:info-30')).toBe(anchorOffset)
    expect(container.querySelector('[data-at-row="item:info-30"]')).toBe(anchor)
    expect(container.querySelectorAll('[data-index]').length).toBeLessThan(60)
  })
})
