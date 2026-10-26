// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskList } from '../TaskList'
import { DeleteTaskConfirmDialog } from '../DeleteTaskConfirmDialog'
import { SubtaskPanel } from '../SubtaskPanel'
import { UITaskStatus, type UITask } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({
  locale: 'en', t: (value: string, params: Record<string, unknown> = {}) => value.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? key)),
}) }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/desktop-titlebar', () => ({ useDesktopTitlebar: () => ({ preserveDesktopSearch: (path: string) => path }) }))
vi.mock('../TaskGradientText', () => ({ TaskGradientText: ({ text }: { text: string }) => <span>{text}</span> }))

const parent: UITask = { id: 'parent', projectId: 'project', title: 'Parent', status: UITaskStatus.Running, agent: '', branch: 'at/parent', description: '', subtaskCount: 1 }
const child: UITask = { id: 'child', projectId: 'project', parentTaskId: 'parent', title: 'Child', status: UITaskStatus.Review, agent: '', branch: 'at/child', description: '' }
const childPage = { data: [{ ...child, status: 'IN_REVIEW', updatedAt: 1 }], total: 1, page: 1, limit: 100, totalPages: 1 }
let root: Root
let container: HTMLDivElement
let client: QueryClient

function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  act(() => root.render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>))
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
function button(label: string) {
  return [...document.body.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label)
}
async function click(element: HTMLElement | undefined) {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.includes('/subtasks')) return Response.json(childPage)
    if (input.endsWith('/tasks/parent')) return Response.json({ id: 'parent', title: 'Parent', projectId: 'project', status: 'IN_PROGRESS' })
    return Response.json([])
  }))
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  client?.clear()
  vi.unstubAllGlobals()
})

describe('subtask navigation and confirmation', () => {
  it('keeps children out of top-level groups and expands without selecting the parent', async () => {
    const onSelect = vi.fn()
    const onCreate = vi.fn()
    mount(<TaskList tasks={[parent, child]} projects={[]} selectedTaskId={null} onSelectTask={onSelect}
      filterProjectId={null} setFilterProjectId={vi.fn()} onCreateSubtask={onCreate} />)
    expect(button('Child')).toBeUndefined()
    await click(button('Subtasks of Parent'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(button('Child')).toBeTruthy()
    await click(button('Child'))
    expect(onSelect).toHaveBeenCalledWith('child')
    await click(button('Subtasks of Parent'))
    expect(button('Child')).toBeUndefined()
    await act(async () => button('Parent')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })))
    await click(button('Create subtask'))
    expect(onCreate).toHaveBeenCalledWith('parent')
  })

  it('reveals a selected child outside the first child page and still lets the icon collapse it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...childPage, data: [], total: 101, totalPages: 2 })))
    mount(<TaskList tasks={[parent, child]} projects={[]} selectedTaskId="child" onSelectTask={vi.fn()}
      filterProjectId={null} setFilterProjectId={vi.fn()} />)
    await settle()
    expect(button('Child')).toBeTruthy()
    expect(button('Load more')).toBeTruthy()
    await click(button('Subtasks of Parent'))
    expect(button('Child')).toBeUndefined()
  })

  it('navigates from the parent panel to a child with its own status', async () => {
    const onSelect = vi.fn()
    mount(<SubtaskPanel task={{ ...parent, projectName: 'Project', projectColor: '', mainBranch: 'main' }} onSelectTask={onSelect} />)
    await settle()
    expect(button('ChildReview')).toBeTruthy()
    await click(button('ChildReview'))
    expect(onSelect).toHaveBeenCalledWith('child')
  })

  it('shows a backlink and no create-child action for a subtask', async () => {
    const onSelect = vi.fn()
    mount(<SubtaskPanel task={{ ...child, projectName: 'Project', projectColor: '', mainBranch: 'at/parent' }} onSelectTask={onSelect} onCreateSubtask={vi.fn()} />)
    await settle()
    await click(button('Parent task: Parent'))
    expect(onSelect).toHaveBeenCalledWith('parent')
    expect(button('Create subtask')).toBeUndefined()
  })

  it('waits for the actual child count and passes the reviewed deletion scope', async () => {
    const onConfirm = vi.fn()
    let resolve!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    mount(<DeleteTaskConfirmDialog isOpen onClose={vi.fn()} onConfirm={onConfirm} taskId="parent" taskTitle="Parent" workspaces={[]} />)
    expect(button('删除')?.disabled).toBe(true)
    await act(async () => resolve(Response.json({ ...childPage, total: 3 })))
    await settle()
    expect(document.body.textContent).toContain('its 3 subtasks')
    await click(button('Delete all'))
    expect(onConfirm).toHaveBeenCalledWith(3)
  })
})
