import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentType } from '@agent-tower/shared'
import { I18nProvider } from '@/lib/i18n'
import { CreateTaskInput } from '../CreateTaskInput'
import '@/index.css'

// Real creation form with in-memory data. No task, session or agent is started.
globalThis.fetch = async input => {
  const pathname = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin).pathname
  if (pathname === '/api/app-settings') return Response.json({ locale: 'zh-CN' })
  if (pathname.endsWith('/workspace-branches')) return Response.json({ mainBranch: pathname.includes('/second/') ? 'release' : 'main', branches: ['main', 'develop', 'release', 'feature/task-base-branch-selection-with-a-long-name'], workspaces: [] })
  if (pathname === '/api/team-templates') return Response.json([{ id: 'template', name: '开发团队', members: [], heartbeatTimeoutMinutes: 10 }])
  if (pathname === '/api/member-presets' || pathname === '/api/providers' || pathname.includes('slash-command')) return Response.json([])
  return Response.json({ error: 'Unexpected fixture request' }, { status: 404 })
}

export function Fixture() {
  const [result, setResult] = useState('')
  return <main className="mx-auto max-w-5xl p-4 sm:p-6">
    <CreateTaskInput
      projects={[{ id: 'fixture', name: 'agent-tower', mainBranch: 'main', repoPath: '/fixture' }, { id: 'second', name: 'Second project', mainBranch: 'release' }, { id: 'local', name: 'Local project', isGitRepo: false, worktreeReady: false }]}
      providers={[{ id: 'provider', name: 'Codex 自建 GPT-6', agentType: AgentType.CODEX, available: true }]}
      defaultProjectId="fixture" defaultProviderId="provider" createStep="idle"
      onSubmit={async value => setResult(JSON.stringify(value))} />
    <output className="mt-6 block break-all text-xs" data-submission>{result}</output>
  </main>
}
window.localStorage.setItem('agent-tower.locale', 'zh-CN')
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter><Fixture /></MemoryRouter></I18nProvider></QueryClientProvider>)
