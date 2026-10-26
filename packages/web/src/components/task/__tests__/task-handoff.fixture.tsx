import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n'
import { Button } from '@/design-system'
import { WorkspacePanel, type WorkspacePanelHandle } from '@/components/workspace/WorkspacePanel'
import { queryKeys } from '@/hooks/query-keys'
import { TaskHandoffPanel } from '../TaskHandoffPanel'
import '@/index.css'

// Real panel, query hooks and Markdown renderer against an isolated in-memory API.
let content = '## 当前进展\n已完成交接笔记的读写接口，正在验证右侧面板。\n\n## 关键决策\n- 每个任务一份 Markdown，详细过程保留在现有会话中。\n- AI 使用精确文本替换更新笔记。\n\n## 下一步\n1. 检查人工编辑和 Agent 更新同时发生时的表现。\n2. 验证移动端入口。'
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
globalThis.fetch = async (input, init) => {
  const pathname = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin).pathname
  if (pathname === '/api/app-settings') return Response.json({ locale: 'zh-CN' })
  if (pathname.endsWith('/handoff')) {
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body))
      if (patch.oldString !== content) return Response.json({ code: 'HANDOFF_TEXT_NOT_FOUND', error: 'Read the latest note' }, { status: 409 })
      content = patch.newString
    }
    return Response.json({ taskId: 'handoff-fixture', content })
  }
  return Response.json({ error: 'Unexpected fixture request' }, { status: 404 })
}

export function Fixture() {
  const panel = useRef<WorkspacePanelHandle | null>(null)
  const [readOnly, setReadOnly] = useState(false)
  const mobile = new URLSearchParams(location.search).has('mobile')
  useEffect(() => { panel.current?.setTab('handoff') }, [])
  return <main className="mx-auto flex h-dvh max-w-3xl flex-col bg-background">
    <div className="flex shrink-0 flex-wrap gap-2 border-b border-border p-3">
      <Button size="sm" onClick={() => {
        content += '\n\n## Agent 补充\n已完成浏览器验证。'
        void client.invalidateQueries({ queryKey: queryKeys.tasks.handoff('handoff-fixture') })
      }}>模拟 Agent 更新</Button>
      <Button size="sm" onClick={() => setReadOnly(!readOnly)}>切换只读</Button>
    </div>
    <div className="min-h-0 flex-1">
      <WorkspacePanel tabRef={panel} variant={mobile ? 'tabs' : 'rail'} hideChanges={mobile} gitAvailable={false} readOnly={readOnly}
        handoff={<TaskHandoffPanel key="handoff-fixture" taskId="handoff-fixture" readOnly={readOnly} />} />
    </div>
  </main>
}

localStorage.setItem('agent-tower.locale', 'zh-CN')
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter><Fixture /></MemoryRouter></I18nProvider></QueryClientProvider>)
