import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskGradientText } from '../TaskGradientText'
import { sidebarRowClass } from '../sidebar-styles'
import '@/index.css'

export function TaskGradientFixture() {
  const [selected, setSelected] = useState<number | null>(null)
  return (
    <main className="flex h-dvh max-w-[600px] flex-col bg-sidebar p-2 text-sm text-foreground">
      <h1 className="p-2">1,000 running tasks</h1>
      <div data-testid="task-scroll" className="min-h-0 flex-1 overflow-auto">
        {Array.from({ length: 1000 }, (_, index) => (
          <button key={index} className={`task-row ${sidebarRowClass(selected === index)}`} onClick={() => setSelected(index)} aria-current={selected === index || undefined}>
            <TaskGradientText text={`任务 ${index + 1}：保留渐变扫光 / English 👨‍👩‍👧‍👦 文本和截断测试`} variant="running" animate={selected !== index} className="task-title-running min-w-0 flex-1" />
            <span className="shrink-0 rounded bg-foreground/[0.05] px-1 py-0.5 text-[10px] font-medium leading-none">
              <TaskGradientText text="agent.." variant="project" className="text-indigo-600" />
            </span>
          </button>
        ))}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><TaskGradientFixture /></StrictMode>)
