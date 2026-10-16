import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Button } from '@/design-system'
import { I18nProvider } from '@/lib/i18n'
import { ProjectBaseBranchSettings } from '../ProjectBaseBranchSettings'
import { SubmitChangesDialog } from '@/components/workspace/SubmitChangesDialog'
import '@/index.css'

// Isolated browser fixture: every API request is handled in memory.
let mainBranch = 'main'
let baseBranch = 'main'
const branches = ['main', 'develop', ...Array.from({ length: 1000 }, (_, index) => `feature/branch-${String(index).padStart(4, '0')}`), 'zz/last-branch']
globalThis.fetch = async (input, init) => {
  const pathname = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin).pathname
  if (pathname === '/api/app-settings') return Response.json({ locale: 'zh-CN' })
  if (pathname === '/api/projects/fixture/workspace-branches') return Response.json({
    mainBranch,
    branches,
    workspaces: [{ id: 'workspace', taskId: 'task', taskTitle: 'Task', branchName: 'feature/branch-0000', baseBranch }],
  })
  if (pathname === '/api/projects/fixture' && init?.method === 'PUT') {
    mainBranch = JSON.parse(String(init.body)).mainBranch
    return Response.json({ id: 'fixture', mainBranch })
  }
  if (pathname === '/api/workspaces/workspace/base-branch' && init?.method === 'PATCH') {
    baseBranch = JSON.parse(String(init.body)).baseBranch
    return Response.json({ id: 'workspace', baseBranch })
  }
  return Response.json({ error: 'Unexpected fixture request' }, { status: 404 })
}

function Fixture() {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState('')
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 p-6">
      <h1 className="text-xl font-medium">分支选择验收</h1>
      <section className="overflow-hidden rounded-xl border border-border bg-background p-5">
        <ProjectBaseBranchSettings projectId="fixture" />
      </section>
      <Button onClick={() => setOpen(true)}>打开任务合并确认</Button>
      <Button onClick={() => { if (!branches.includes('release/newly-created')) branches.push('release/newly-created') }}>模拟新增分支</Button>
      <output>{result}</output>
      <SubmitChangesDialog isOpen={open} onClose={() => setOpen(false)} projectId="fixture" workspaceId="workspace"
        branchName="feature/branch-0000" targetBranch={baseBranch} canMerge isPending={false}
        activeServices={[]} isCheckingServices={false} serviceCheckFailed={false}
        onBaseBranchSaved={() => setResult(`已返回审查：${baseBranch}`)}
        onConfirm={() => setResult('已确认合并')} />
    </main>
  )
}

window.localStorage.setItem('agent-tower.locale', 'zh-CN')
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}><I18nProvider><Fixture /></I18nProvider></QueryClientProvider>,
)
