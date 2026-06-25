import { useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { useCreateWorkspace } from '@/hooks/use-workspaces'
import { useStartSession } from '@/hooks/use-sessions'
import { useProviders } from '@/hooks/use-providers'
import { queryKeys } from '@/hooks/query-keys'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { AgentLogo } from '@/components/agent'
import { useI18n } from '@/lib/i18n'
import { WorkspaceKind } from '@agent-tower/shared'

interface StartAgentDialogProps {
  isOpen: boolean
  onClose: () => void
  onStarted?: () => void
  taskId: string
  taskTitle: string
  taskDescription: string
  taskPrompt?: string
  projectIsGitRepo?: boolean
}

type StartStep = 'idle' | 'creating-workspace' | 'creating-session' | 'starting-session'
type WorkspaceMode = WorkspaceKind.WORKTREE | WorkspaceKind.MAIN_DIRECTORY

export function StartAgentDialog({
  isOpen,
  onClose,
  onStarted,
  taskId,
  taskTitle,
  taskDescription,
  taskPrompt,
  projectIsGitRepo = true,
}: StartAgentDialogProps) {
  const { t } = useI18n()
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [prompt, setPrompt] = useState('')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(WorkspaceKind.WORKTREE)
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
      setPrompt(taskPrompt?.trim() || parts.join('\n\n'))
      setWorkspaceMode(projectIsGitRepo ? WorkspaceKind.WORKTREE : WorkspaceKind.MAIN_DIRECTORY)
      setStep('idle')
      setError(null)
    }
  }, [isOpen, projectIsGitRepo, taskTitle, taskDescription, taskPrompt])

  useEffect(() => {
    if (!projectIsGitRepo) {
      setWorkspaceMode(WorkspaceKind.MAIN_DIRECTORY)
    }
  }, [projectIsGitRepo])

  const isStarting = step !== 'idle'

  const handleStart = async () => {
    if (!selectedProviderId || !prompt.trim()) return

    setError(null)

    try {
      // Step 1: 创建 Workspace
      setStep('creating-workspace')
      const workspace = await createWorkspace.mutateAsync({
        workspaceKind: projectIsGitRepo ? workspaceMode : WorkspaceKind.MAIN_DIRECTORY,
      })

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
      onStarted?.()
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
  const providerOptions = (providersData ?? []).map(({ provider, availability }) => {
    const isAvailable = availability.type !== 'NOT_FOUND'
    return {
      value: provider.id,
      label: isAvailable ? provider.name : `${provider.name}${t(' (不可用)')}`,
      icon: <AgentLogo agentType={provider.agentType} className="size-4" />,
      disabled: !isAvailable,
    }
  })
  const worktreeModeHint = t('工作树隔离改动，支持 TeamRun、Merge、Rebase 和冲突解决。')
  const mainDirectoryModeHint = t('本地模式会直接修改项目主目录，不会自动提交，也不能使用 Merge、Rebase 或冲突解决。')
  const nonGitProjectModeHint = t('非 Git 项目只能使用本地模式。')
  const workspaceModeOptions = [
    { value: WorkspaceKind.WORKTREE, label: t('工作树模式'), description: worktreeModeHint, disabled: !projectIsGitRepo },
    { value: WorkspaceKind.MAIN_DIRECTORY, label: t('本地模式'), description: mainDirectoryModeHint },
  ]

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
        <div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-2">
                {t('Agent')}
              </label>
              <Select
                value={selectedProviderId}
                onChange={setSelectedProviderId}
                options={providerOptions}
                placeholder={isLoading ? t('加载中...') : t('选择 Agent')}
                disabled={isStarting || isLoading}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-2">
                {t('模式')}
              </label>
              {!projectIsGitRepo ? (
                <Tooltip side="bottom" className="w-full" content={nonGitProjectModeHint}>
                  <div
                    tabIndex={0}
                    aria-label={nonGitProjectModeHint}
                    className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <Select
                      value={workspaceMode}
                      onChange={(value) => setWorkspaceMode(value as WorkspaceMode)}
                      options={workspaceModeOptions}
                      disabled
                    />
                  </div>
                </Tooltip>
              ) : (
                <Select
                  value={workspaceMode}
                  onChange={(value) => setWorkspaceMode(value as WorkspaceMode)}
                  options={workspaceModeOptions}
                  disabled={isStarting}
                />
              )}
            </div>
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
