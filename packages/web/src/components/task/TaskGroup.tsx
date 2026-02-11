import { memo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { IconReview, IconRunning, IconPending, IconDone } from '../agent/Icons'
import type { UITask, UIProject } from './types'
import { UITaskStatus } from './types'

interface TaskGroupProps {
  title: string
  tasks: UITask[]
  status: UITaskStatus
  defaultOpen: boolean
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  projects: UIProject[]
  /** 当前有 Agent 正在运行的任务 ID 集合 */
  activeTaskIds?: Set<string>
}

export const TaskGroup = memo(function TaskGroup({
  title,
  tasks,
  status,
  defaultOpen,
  selectedTaskId,
  onSelectTask,
  projects,
  activeTaskIds,
}: TaskGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  if (tasks.length === 0) return null

  const isReview = status === UITaskStatus.Review

  return (
    <div className="mb-2">
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className="flex items-center w-full px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50 transition-colors"
      >
        <span className="mr-2 text-neutral-400">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="flex-1 text-left">{title}</span>
        {isReview ? (
          <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-bold rounded-full animate-hop">
            {tasks.length}
          </span>
        ) : (
          <span className="text-xs text-neutral-400 font-normal">({tasks.length})</span>
        )}
      </button>

      {isOpen && (
        <div className="flex flex-col mt-1">
          {tasks.map(task => {
            const project = projects.find(p => p.id === task.projectId)
            const isSelected = selectedTaskId === task.id
            const isAgentActive = activeTaskIds?.has(task.id) ?? false

            return (
              <button
                key={task.id}
                onClick={() => onSelectTask(task.id)}
                className={`flex items-start pl-8 pr-4 py-3 text-sm w-full text-left transition-all border-l-2 group
                  ${isSelected
                    ? 'bg-neutral-100 border-neutral-800'
                    : 'border-transparent hover:bg-neutral-50 hover:border-neutral-200'
                  }`}
              >
                <div className={`mt-0.5 mr-3 flex-shrink-0 ${status === UITaskStatus.Running ? 'text-blue-600' : 'text-neutral-500'}`}>
                  {status === UITaskStatus.Review && <IconReview className={isSelected ? "text-amber-600" : "text-neutral-500"} />}
                  {status === UITaskStatus.Running && <IconRunning className="animate-pulse" />}
                  {status === UITaskStatus.Pending && <IconPending />}
                  {status === UITaskStatus.Done && <IconDone className="text-neutral-400" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="mb-0.5">
                    <span className={`font-medium mr-1 ${project?.color || 'text-neutral-500'}`}>
                      {project?.name}
                    </span>
                    <span className="text-neutral-400">/</span>
                    <span className={`ml-1 ${isSelected ? 'text-neutral-900' : 'text-neutral-700'}`}>
                      {task.title}
                    </span>
                    {isAgentActive && (
                      <span className="relative inline-flex h-2 w-2 ml-1.5 align-middle">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                      </span>
                    )}
                  </div>
                  {/* Task Description: visible, 2 lines max */}
                  <p className={`text-xs line-clamp-2 leading-relaxed ${isSelected ? 'text-neutral-500' : 'text-neutral-400 group-hover:text-neutral-500'}`}>
                    {task.description}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})
