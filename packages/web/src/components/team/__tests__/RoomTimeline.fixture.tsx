import { Profiler, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RoomMessage, TeamRun } from '@agent-tower/shared'
import { socketManager } from '@/lib/socket/manager'
import { I18nProvider } from '@/lib/i18n'
import { RoomTimeline } from '../RoomTimeline'
import '@/index.css'

// A browser fixture with the real room, Markdown, queries and scrolling. All
// transport is local, so typing/sending here cannot touch a user's running team.
const socket = { connected: false, on() {}, off() {}, emit() {} }
socketManager.connect = () => socket as unknown as ReturnType<typeof socketManager.connect>
socketManager.getSocket = () => socket as unknown as ReturnType<typeof socketManager.getSocket>
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
  if (!url.pathname.startsWith('/api/')) return originalFetch(input, init)
  if (url.pathname === '/api/providers') return Response.json([])
  if (url.pathname === '/api/app-settings') return Response.json({ locale: 'en' })
  if (url.pathname === '/api/translation-settings') return Response.json({ enabled: false })
  return Response.json({ items: [], nextCursor: null })
}

const count = Number(new URLSearchParams(location.search).get('count') ?? 500)
const compact = new URLSearchParams(location.search).has('compact')
const history = (id: string): RoomMessage[] => Array.from({ length: count }, (_, index) => ({
  id: `${id}-${index}`, teamRunId: id, senderType: index % 4 === 0 ? 'user' : 'agent',
  kind: 'chat', visibility: 'PUBLIC', mentions: [], attachmentIds: [],
  content: `Message ${index}\n\n**Review update** for \`packages/web\`: task selection and team input.\n\n- Render only visible messages\n- Keep input responsive\n\n${index % 7 === 0 ? 'Additional detail. '.repeat(150) : 'Ready for review.'}`,
  createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, index)).toISOString(),
}))
const rooms = [history('room-a'), history('room-b')]
const metrics: { commits: number[]; longTasks: number[] } = { commits: [], longTasks: [] }
Object.assign(window, { roomMetrics: metrics, roomFixture: { count, compact } })
const observer = new PerformanceObserver(list => metrics.longTasks.push(...list.getEntries().map(entry => entry.duration)))
observer.observe({ type: 'longtask', buffered: true })

export function Fixture() {
  const [selected, setSelected] = useState(0)
  const [messages, setMessages] = useState(rooms)
  const id = selected === 0 ? 'room-a' : 'room-b'
  const teamRun: TeamRun = { id, taskId: id, mode: 'AUTO', heartbeatTimeoutMinutes: 10, members: [], invocations: [], workRequests: [] }
  return <div className="flex h-dvh flex-col bg-background text-foreground">
    <nav className="flex shrink-0 gap-4 p-2">
      <button onClick={() => setSelected(0)}>Task A</button>
      <button onClick={() => setSelected(1)}>Task B</button>
      <button onClick={() => setMessages(current => current.map((room, index) => index === selected ? [...room, {
        ...room[room.length - 1], id: `${id}-${room.length}`, content: `New message ${room.length}`,
        createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, room.length)).toISOString(),
      }] : room))}>Append reply</button>
    </nav>
    <div className="min-h-0 flex-1">
      <Profiler id="room" onRender={(_id, _phase, duration) => metrics.commits.push(duration)}>
        <RoomTimeline key={id} teamRun={teamRun} messages={messages[selected]} compactComposer={compact} onSendMessage={async input => {
          setMessages(current => current.map((room, index) => index === selected ? [...room, {
            ...room[0], id: crypto.randomUUID(), content: input.content, senderType: 'user', createdAt: new Date().toISOString(),
          }] : room))
        }} />
      </Profiler>
    </div>
  </div>
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider><Fixture /></I18nProvider>
  </QueryClientProvider>,
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount()
    observer.disconnect()
    window.fetch = originalFetch
  })
}
