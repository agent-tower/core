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
import { TaskStatus } from '@agent-tower/shared'
import { adaptTaskBoardItemForList } from '../adapters'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({
  locale: 'en', t: (value: string, params: Record<string, unknown> = {}) => value.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? key)),
}) }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/desktop-titlebar', () => ({ useDesktopTitlebar: () => ({ preserveDesktopSearch: (path: string) => path }) }))
vi.mock('../TaskGradientText', () => ({ TaskGradientText: ({ text }: { text: string }) => <span>{text}</span> }))

const parent: UITask = { id: 'parent', projectId: 'project', title: 'Parent', status: UITaskStatus.Running, agent: '', branch: 'at/parent', description: '', subtaskCount: 1 }
const child: UITask = { id: 'child', projectId: 'project', parentTaskId: 'parent', ancestorIds: ['parent'], subtaskCount: 1, title: 'Child', status: UITaskStatus.Review, agent: '', branch: 'at/child', description: '' }
const grandchild: UITask = { ...child, id: 'grandchild', title: 'Grandchild', parentTaskId: 'child', ancestorIds: ['parent', 'child'], subtaskCount: 0 }
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
    if (input.includes('/tasks/child/subtasks')) return Response.json({ ...childPage, data: [{ ...grandchild, status: 'IN_REVIEW', updatedAt: 1 }] })
    if (input.endsWith('/tasks/child')) return Response.json({ ...child, status: 'IN_REVIEW' })
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
  it('groups a collapsed parent by descendant activity and edits its own status', async () => {
    const task = adaptTaskBoardItemForList({
      id: 'parent', projectId: 'project', title: 'Parent', status: TaskStatus.DONE,
      displayStatus: TaskStatus.IN_PROGRESS, runningDescendantCount: 2, reviewDescendantCount: 1,
      subtaskCount: 1, updatedAt: 1,
    })
    const onChange = vi.fn()
    mount(<TaskList tasks={[task]} projects={[]} selectedTaskId={null} onSelectTask={vi.fn()}
      filterProjectId={null} setFilterProjectId={vi.fn()} onTaskStatusChange={onChange} />)
    expect(button('Parent')?.closest('[data-task-group-status]')?.getAttribute('data-task-group-status')).toBe('Running')
    expect(button('Parent')?.title).toContain('Own status: Done')
    expect(button('Parent')?.title).toContain('2 running, 1 in review')
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/subtasks'))).toBe(false)

    await act(async () => button('Parent')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })))
    expect(document.body.textContent).toContain('Own status: Done')
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(options.some(option => option.textContent === 'Done')).toBe(false)
    await click(options.find(option => option.textContent === 'Running'))
    expect(onChange).toHaveBeenCalledWith('parent', UITaskStatus.Running)
  })

  it('shows the aggregated status of a child even when its grandchildren are not loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ...childPage, data: [{ ...childPage.data[0], status: 'DONE', displayStatus: 'IN_PROGRESS', runningDescendantCount: 1 }],
    })))
    mount(<SubtaskPanel task={{ ...parent, projectName: 'Project', projectColor: '', mainBranch: 'main' }} onSelectTask={vi.fn()} />)
    await settle()
    expect(button('ChildRunning')).toBeTruthy()
    expect(button('ChildDone')).toBeUndefined()
  })

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

  it('shows a backlink, grandchildren and a create action for a child task', async () => {
    const onSelect = vi.fn()
    mount(<SubtaskPanel task={{ ...child, projectName: 'Project', projectColor: '', mainBranch: 'at/parent' }} onSelectTask={onSelect} onCreateSubtask={vi.fn()} />)
    await settle()
    await click(button('Parent task: Parent'))
    expect(onSelect).toHaveBeenCalledWith('parent')
    expect(button('Create subtask')).toBeTruthy()
    expect(button('GrandchildReview')).toBeTruthy()
  })

  it('reveals a grandchild beyond both child pages and creates only under its parent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...childPage, data: [], total: 101, totalPages: 2 })))
    const onCreate = vi.fn()
    const onSelect = vi.fn()
    mount(<TaskList tasks={[parent, child, grandchild]} projects={[]} selectedTaskId="grandchild" onSelectTask={onSelect}
      filterProjectId={null} setFilterProjectId={vi.fn()} onCreateSubtask={onCreate} />)
    await settle()
    expect(button('Child')).toBeTruthy()
    expect(button('Grandchild')).toBeTruthy()
    await click(button('Grandchild'))
    expect(onSelect).toHaveBeenCalledWith('grandchild')
    await act(async () => button('Grandchild')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })))
    expect(button('Create subtask')).toBeUndefined()
    await act(async () => button('Child')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })))
    await click(button('Create subtask'))
    expect(onCreate).toHaveBeenCalledWith('child')
    await click(button('Subtasks of Child'))
    expect(button('Grandchild')).toBeUndefined()
    expect(button('Child')).toBeTruthy()
  })

  it('keeps the parent link but hides creation and child loading for a grandchild', async () => {
    mount(<SubtaskPanel task={{ ...grandchild, projectName: 'Project', projectColor: '', mainBranch: 'at/child' }} onSelectTask={vi.fn()} onCreateSubtask={vi.fn()} />)
    await settle()
    expect(button('Parent task: Child')).toBeTruthy()
    expect(button('Create subtask')).toBeUndefined()
    expect(document.body.textContent).toContain('Tasks support at most three levels')
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/grandchild/subtasks'))).toBe(false)
  })

  it('waits for the actual child count and passes the reviewed deletion scope', async () => {
    const onConfirm = vi.fn()
    let resolve!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    mount(<DeleteTaskConfirmDialog isOpen onClose={vi.fn()} onConfirm={onConfirm} taskId="parent" taskTitle="Parent" workspaces={[]} />)
    expect(button('删除')?.disabled).toBe(true)
    await act(async () => resolve(Response.json({ descendantCount: 3 })))
    await settle()
    expect(document.body.textContent).toContain('all 3 descendants')
    await click(button('Delete all'))
    expect(onConfirm).toHaveBeenCalledWith(3)
  })
})
