// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskHandoffPanel } from '../TaskHandoffPanel'
import { queryKeys } from '@/hooks/query-keys'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (s: string) => s }) }))
vi.mock('streamdown', () => ({ Streamdown: ({ children }: { children: ReactNode }) => <div data-markdown>{children}</div> }))
vi.mock('@/lib/streamdown-components', () => ({ streamdownComponents: {} }))
let root: Root
let container: HTMLDivElement
let client: QueryClient
let content: string
let writes: { oldString: string; newString: string }[]

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
function button(text: string) { return [...container.querySelectorAll('button')].find(b => b.textContent === text)! }
async function click(text: string) { await act(async () => button(text).click()); await settle() }
function render(readOnly = false) {
  act(() => root.render(<QueryClientProvider client={client}><TaskHandoffPanel key="task" taskId="task" readOnly={readOnly} /></QueryClientProvider>))
}
async function type(value: string) {
  await act(async () => {
    const input = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  sessionStorage.clear()
  content = '## Progress\nOriginal note'
  writes = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body))
      writes.push(patch)
      if (patch.oldString !== content) return Response.json({ code: 'HANDOFF_TEXT_NOT_FOUND', error: 'Changed' }, { status: 409 })
      content = patch.newString
    }
    return Response.json({ taskId: 'task', content })
  }))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  client.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('task handoff editing', () => {
  it('saves exact Markdown and returns to reading the saved note', async () => {
    render(); await settle()
    await click('编辑')
    await type('## Progress\nCompleted ✅\n$&')
    await click('Save')
    expect(writes).toEqual([{ oldString: '## Progress\nOriginal note', newString: '## Progress\nCompleted ✅\n$&' }])
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).toContain('Completed ✅')
    expect(sessionStorage.getItem('task-handoff-draft:task')).toBeNull()
  })

  it('keeps drafts across remote updates, failed saves and panel switches', async () => {
    render(); await settle()
    await click('编辑')
    await type('My unsaved work')
    content = 'Agent updated the note'
    await act(async () => { client.setQueryData(queryKeys.tasks.handoff('task'), { taskId: 'task', content }) })
    await settle()
    expect(container.querySelector('textarea')!.value).toBe('My unsaved work')
    expect(container.textContent).toContain('Your draft is preserved')
    await click('Save')
    expect(container.querySelector('textarea')!.value).toBe('My unsaved work')
    act(() => root.render(null))
    render(); await settle()
    expect(container.querySelector('textarea')!.value).toBe('My unsaved work')
    await click('Cancel')
    expect(container.textContent).toContain('Agent updated the note')
  })

  it('shows archived content without edit controls, including when a draft exists', async () => {
    sessionStorage.setItem('task-handoff-draft:task', JSON.stringify({ base: content, content: 'Old draft' }))
    render(true); await settle()
    expect(container.textContent).toContain('Original note')
    expect(container.querySelector('textarea')).toBeNull()
    expect(button('编辑')).toBeUndefined()
    expect(button('Save')).toBeUndefined()
    expect(button('Copy')).toBeTruthy()
  })

  it('clears the submitted draft when saving completes after the panel closes', async () => {
    render(); await settle()
    await click('编辑')
    await type('Saved while closed')
    let finish!: () => void
    vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        await new Promise<void>(resolve => { finish = resolve })
        content = 'Saved while closed'
      }
      return Response.json({ taskId: 'task', content })
    }))
    await click('Save')
    act(() => root.render(null))
    await act(async () => finish())
    await settle()
    render(); await settle()
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).toContain('Saved while closed')
  })
});
