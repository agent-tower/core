import { useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { useCreateWorkspace } from '@/hooks/use-workspaces'
import { useCreateSession, useStartSession } from '@/hooks/use-sessions'
import { queryKeys } from '@/hooks/query-keys'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import type { AgentType } from '@agent-tower/shared'

interface Agent {
  type: string
  name: string
  available: boolean
  version?: string
  error?: string
}

interface StartAgentDialogProps {
  isOpen: boolean
  onClose: () => void
  taskId: string
  taskTitle: string
  taskDescription: string
}

type StartStep = 'idle' | 'creating-workspace' | 'creating-session' | 'starting-session'

export function StartAgentDialog({
  isOpen,
  onClose,
  taskId,
  taskTitle,
  taskDescription,
}: StartAgentDialogProps) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [prompt, setPrompt] = useState('')
  const [step, setStep] = useState<StartStep>('idle')
  const [error, setError] = useState<string | null>(null)

  const queryClient = useQueryClient()
  const createWorkspace = useCreateWorkspace(taskId)
  const startSession = useStartSession()

  // 加载可用 agents
  useEffect(() => {
    if (!isOpen) return
    apiClient.get<{ agents: Agent[] }>('/demo/agents').then(res => {
      setAgents(res.agents)
      const available = res.agents.find(a => a.available)
      if (available) {
        setSelectedAgent(available.type)
      }
    })
  }, [isOpen])

  // 打开时用任务信息预填 prompt
  useEffect(() => {
    if (isOpen) {
      const parts = [taskTitle]
      if (taskDescription) parts.push(taskDescription)
      setPrompt(parts.join('\n\n'))
      setStep('idle')
      setError(null)
    }
  }, [isOpen, taskTitle, taskDescription])

  const isStarting = step !== 'idle'

  const handleStart = async () => {
    if (!selectedAgent || !prompt.trim()) return

    setError(null)

    try {
      // Step 1: 创建 Workspace
      setStep('creating-workspace')
      const workspace = await createWorkspace.mutateAsync({})

      // Step 2: 创建 Session
      setStep('creating-session')
      const session = await apiClient.post<{ id: string }>(
        `/workspaces/${workspace.id}/sessions`,
        { agentType: selectedAgent as AgentType, prompt: prompt.trim() },
      )

      // Step 3: 启动 Session
      setStep('starting-session')
      await startSession.mutateAsync(session.id)

      // 成功，invalidate workspaces 使 TaskDetail 发现新 session
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(taskId) })

      // 关闭对话框
      setStep('idle')
      onClose()
    } catch (err) {
      setStep('idle')
      setError(err instanceof Error ? err.message : '启动失败，请重试')
    }
  }

  const stepLabel: Record<StartStep, string> = {
    idle: '启动',
    'creating-workspace': '创建工作空间...',
    'creating-session': '创建会话...',
    'starting-session': '启动 Agent...',
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={isStarting ? () => {} : onClose}
      title="启动 Agent"
      action={
        <>
          <Button variant="outline" onClick={onClose} disabled={isStarting}>
            取消
          </Button>
          <Button
            onClick={handleStart}
            disabled={isStarting || !selectedAgent || !prompt.trim()}
          >
            {stepLabel[step]}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Agent 选择 */}
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-2">
            选择 Agent
          </label>
          <div className="flex gap-2 flex-wrap">
            {agents.length === 0 && (
              <span className="text-sm text-neutral-400">加载中...</span>
            )}
            {agents.map(agent => (
              <Button
                key={agent.type}
                variant={selectedAgent === agent.type ? 'default' : 'outline'}
                size="sm"
                disabled={!agent.available || isStarting}
                onClick={() => setSelectedAgent(agent.type)}
              >
                {agent.name}
                {agent.available && agent.version && ` (${agent.version})`}
                {!agent.available && ' (不可用)'}
              </Button>
            ))}
          </div>
        </div>

        {/* Prompt 输入 */}
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-2">
            任务描述
          </label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={5}
            disabled={isStarting}
            placeholder="描述你想让 Agent 完成的任务..."
            className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-300 focus:border-neutral-300 resize-none disabled:opacity-50 disabled:bg-neutral-50"
          />
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}
