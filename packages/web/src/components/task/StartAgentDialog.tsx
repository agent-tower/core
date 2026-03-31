import { useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { useCreateWorkspace } from '@/hooks/use-workspaces'
import { useStartSession } from '@/hooks/use-sessions'
import { useProviders } from '@/hooks/use-providers'
import { queryKeys } from '@/hooks/query-keys'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'

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
  const { t } = useI18n()
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [prompt, setPrompt] = useState('')
  const [step, setStep] = useState<StartStep>('idle')
  const [error, setError] = useState<string | null>(null)

  const queryClient = useQueryClient()
  const createWorkspace = useCreateWorkspace(taskId)
  const startSession = useStartSession()
  const { data: providersData, isLoading } = useProviders()

  // 打开时选择第一个可用的 provider
  useEffect(() => {
    if (!isOpen || !providersData) return
    const available = providersData.find(p => p.availability.type !== 'NOT_FOUND')
    if (available) {
      setSelectedProviderId(available.provider.id)
    }
  }, [isOpen, providersData])

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
    if (!selectedProviderId || !prompt.trim()) return

    setError(null)

    try {
      // Step 1: 创建 Workspace
      setStep('creating-workspace')
      const workspace = await createWorkspace.mutateAsync({})

      // Step 2: 创建 Session (使用 providerId)
      setStep('creating-session')
      const session = await apiClient.post<{ id: string }>(
        `/workspaces/${workspace.id}/sessions`,
        { providerId: selectedProviderId, prompt: prompt.trim() },
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
      setError(err instanceof Error ? err.message : t('启动失败，请重试'))
    }
  }

  const stepLabel: Record<StartStep, string> = {
    idle: t('启动'),
    'creating-workspace': t('创建工作空间...'),
    'creating-session': t('创建会话...'),
    'starting-session': t('启动 Agent...'),
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={isStarting ? () => {} : onClose}
      title={t('启动 Agent')}
      action={
        <>
          <Button variant="outline" onClick={onClose} disabled={isStarting}>
            {t('取消')}
          </Button>
          <Button
            onClick={handleStart}
            disabled={isStarting || !selectedProviderId || !prompt.trim()}
          >
            {stepLabel[step]}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Provider 选择 */}
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-2">
            {t('选择 Provider')}
          </label>
          <div className="flex gap-2 flex-wrap">
            {isLoading && (
              <span className="text-sm text-neutral-400">{t('加载中...')}</span>
            )}
            {providersData?.map(({ provider, availability }) => {
              const isAvailable = availability.type !== 'NOT_FOUND'
              return (
                <Button
                  key={provider.id}
                  variant={selectedProviderId === provider.id ? 'default' : 'outline'}
                  size="sm"
                  disabled={!isAvailable || isStarting}
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  {provider.name}
                  {!isAvailable && t(' (不可用)')}
                </Button>
              )
            })}
          </div>
        </div>

        {/* Prompt 输入 */}
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-2">
            {t('任务描述')}
          </label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={5}
            disabled={isStarting}
            placeholder={t('描述你想让 Agent 完成的任务...')}
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
