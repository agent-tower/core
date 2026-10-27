import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentType, TaskStatus, canCreateSubtask, isTaskInSubtree, type TaskBoardItem } from '@agent-tower/shared'
import { I18nProvider } from '@/lib/i18n'
import { Button } from '@/design-system'
import { WorkspacePanel, type WorkspacePanelHandle } from '@/components/workspace/WorkspacePanel'
import { useTaskBoard, useDeleteTask } from '@/hooks/use-tasks'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'
import { TaskList } from '../TaskList'
import { SubtaskPanel } from '../SubtaskPanel'
import { CreateTaskInput } from '../CreateTaskInput'
import { DeleteTaskConfirmDialog } from '../DeleteTaskConfirmDialog'
import { adaptTaskBoardItemForList, adaptTaskBoardItemForDetail } from '../adapters'
import '@/index.css'

// Production components and hooks with an isolated API; no live tasks or processes.
const project = { id: 'project', name: '三级任务验收', color: 'text-blue-500', repoPath: '/fixture', mainBranch: 'main', isGitRepo: false, worktreeReady: false }
let tasks: TaskBoardItem[] = [
  { id: 'root', projectId: project.id, title: '主任务：实现账户管理', status: TaskStatus.DONE, ancestorIds: [], subtaskCount: 1, updatedAt: 1 },
  { id: 'child', projectId: project.id, title: '子任务：实现用户登录', status: TaskStatus.IN_REVIEW, parentTaskId: 'root', ancestorIds: ['root'], subtaskCount: 1, updatedAt: 1 },
  { id: 'grandchild', projectId: project.id, title: '孙任务：验证登录失败后的提示与重试', status: TaskStatus.IN_PROGRESS, parentTaskId: 'child', ancestorIds: ['root', 'child'], subtaskCount: 0, updatedAt: 1 },
  { id: 'other', projectId: project.id, title: '独立任务：整理文档', status: TaskStatus.TODO, ancestorIds: [], updatedAt: 1 },
]
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
const page = (data: TaskBoardItem[]) => ({ data, total: data.length, page: 1, limit: 100, totalPages: 1 })
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.pathname === '/api/app-settings') return Response.json({ locale: 'zh-CN' })
  if (url.pathname === '/api/task-board') return Response.json(page(tasks))
  if (url.pathname === '/api/projects/project/tasks' && init?.method === 'POST') {
    const data = JSON.parse(String(init.body))
    const parent = tasks.find(task => task.id === data.parentTaskId)
    if (!parent || !canCreateSubtask(parent)) return Response.json({ error: 'Tasks support at most three levels' }, { status: 400 })
    const created: TaskBoardItem = { id: `created-${tasks.length}`, projectId: project.id, title: data.title, parentTaskId: parent.id,
      ancestorIds: [...(parent.ancestorIds ?? []), parent.id], status: TaskStatus.TODO, subtaskCount: 0, updatedAt: Date.now() }
    tasks = [...tasks.map(task => task.id === parent.id ? { ...task, subtaskCount: (task.subtaskCount ?? 0) + 1 } : task), created]
    return Response.json(created, { status: 201 })
  }
  if (url.pathname.includes('/tasks/')) {
    const id = url.pathname.split('/')[3]
    const task = tasks.find(task => task.id === id)
    if (url.pathname.endsWith('/cleanup')) return Response.json({ taskId: id, status: 'COMPLETED' })
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 })
    if (url.pathname.endsWith('/subtasks')) return Response.json(page(tasks.filter(task => task.parentTaskId === id)))
    if (url.pathname.endsWith('/deletion-scope')) return Response.json({ descendantCount: tasks.filter(task => task.id !== id && isTaskInSubtree(task, id)).length })
    if (url.pathname.endsWith('/workspaces')) return Response.json([])
    if (init?.method === 'DELETE') {
      const descendants = tasks.filter(task => task.id !== id && isTaskInSubtree(task, id)).length
      if (Number(url.searchParams.get('expectedSubtaskCount')) !== descendants) return Response.json({ error: 'Subtasks changed' }, { status: 409 })
      tasks = tasks.filter(task => !isTaskInSubtree(task, id))
      tasks = tasks.map(task => ({ ...task, subtaskCount: tasks.filter(child => child.parentTaskId === task.id).length }))
      return new Response(null, { status: 204 })
    }
    return Response.json({ ...task, project, workspaces: [] })
  }
  if (url.pathname === '/api/team-templates' || url.pathname === '/api/member-presets' || url.pathname.includes('slash-command')) return Response.json([])
  return Response.json({ error: 'Unexpected fixture request' }, { status: 404 })
}

export function Fixture() {
  const [selectedId, setSelectedId] = useState('grandchild')
  const [parentId, setParentId] = useState<string>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const panel = useRef<WorkspacePanelHandle | null>(null)
  const mobile = new URLSearchParams(location.search).has('mobile')
  const board = useTaskBoard()
  const remove = useDeleteTask()
  const rows = board.data?.data ?? []
  const selected = rows.find(task => task.id === selectedId)
  const parent = rows.find(task => task.id === parentId)
  const hasSelection = Boolean(selected)
  useEffect(() => { panel.current?.setTab('subtasks') }, [selectedId, parentId, hasSelection])
  return <main className="flex h-dvh min-w-0 flex-col bg-background">
    <div className="flex shrink-0 flex-wrap gap-2 border-b border-border p-2">
      <Button size="sm" onClick={() => { setSelectedId('root'); setParentId(undefined) }}>查看主任务</Button>
      <Button size="sm" onClick={() => { setSelectedId('grandchild'); setParentId(undefined) }}>定位孙任务</Button>
      <Button size="sm" disabled={!selected} onClick={() => setDeleteOpen(true)}>删除当前任务</Button>
    </div>
    <div className={mobile ? 'flex min-h-0 flex-1 flex-col' : 'flex min-h-0 flex-1'}>
      <div className={mobile ? 'h-[45%] min-h-0' : 'min-h-0 shrink-0'}>
        <TaskList tasks={rows.map(task => adaptTaskBoardItemForList(task, project))} projects={[]}
          width={mobile ? '100%' : 400} selectedTaskId={selectedId}
          onSelectTask={id => { setSelectedId(id); setParentId(undefined) }} onCreateSubtask={setParentId}
          filterProjectId={null} setFilterProjectId={() => {}} onDeleteTask={(id, count) => remove.mutate({ id, expectedSubtaskCount: count })} />
      </div>
      <div className="min-h-0 min-w-0 flex-1 border-l border-border">
        {parent ? <div className="p-3"><CreateTaskInput parentTask={{ ...parent, baseBranch: null }} projects={[project]} providers={[{ id: 'provider', name: 'Codex 验收', agentType: AgentType.CODEX, available: true }]}
          defaultProjectId={project.id} defaultProviderId="provider" createStep="idle" onSubmit={async data => {
            const created = await apiClient.post<TaskBoardItem>(`/projects/${project.id}/tasks`, { title: data.title, parentTaskId: data.parentTaskId })
            await client.invalidateQueries({ queryKey: queryKeys.tasks.all })
            setParentId(undefined)
            setSelectedId(created.id)
          }} /></div> : selected && <WorkspacePanel tabRef={panel} variant={mobile ? 'tabs' : 'rail'} hideChanges={mobile} gitAvailable={false}
            subtasks={<SubtaskPanel key={selected.id} task={adaptTaskBoardItemForDetail(selected, project)} onSelectTask={setSelectedId} onCreateSubtask={setParentId} />} />}
      </div>
    </div>
    {selected && <DeleteTaskConfirmDialog isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} taskId={selected.id} taskTitle={selected.title} workspaces={[]}
      onConfirm={async count => {
        await remove.mutateAsync({ id: selected.id, expectedSubtaskCount: count })
        setDeleteOpen(false)
      }} />}
  </main>
}

localStorage.setItem('agent-tower.locale', 'zh-CN')
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter><Fixture /></MemoryRouter></I18nProvider></QueryClientProvider>)
