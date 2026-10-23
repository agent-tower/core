import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { ArrowUp, Paperclip, Loader2 } from 'lucide-react'
import { TaskPriority, WorkspaceKind, type ProjectGitCapability, type TeamRunMode } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useAttachments } from '@/hooks/use-attachments'
import { useRefreshProjectGitCapability } from '@/hooks/use-projects'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import { TeamRunCreateForm } from '@/components/team/TeamRunCreateForm'
import { SlashCommandPopover } from './SlashCommandPopover'
import { useSlashCommandMenu } from './useSlashCommandMenu'
import { TaskCreationOptions, type TaskProjectOption as ProjectOption, type TaskProviderOption as ProviderOption } from './TaskCreationOptions'

type CreateStep = 'idle' | 'creating-task' | 'creating-teamrun' | 'creating-workspace' | 'creating-session' | 'starting-session'
type CreateTaskMode = 'SOLO' | 'TEAM'
type WorkspaceMode = WorkspaceKind.WORKTREE | WorkspaceKind.MAIN_DIRECTORY
type CreateInputVariant = 'task' | 'conversation'

export interface CreateTaskInputProps {
  variant?: CreateInputVariant
  projects: ProjectOption[]
  providers: ProviderOption[]
  isProvidersLoading?: boolean
  onSubmit: (data: {
    title: string
    description: string
    projectId: string
    providerId: string
    mode: CreateTaskMode
    workspaceMode: WorkspaceMode
    teamRunMode: TeamRunMode
    teamTemplateId: string | null
    memberPresetIds: string[]
    attachmentLinks: string
    attachmentIds: string[]
    priority: TaskPriority
    baseBranch?: string | null
  }) => Promise<void>
  defaultProjectId?: string
  defaultProviderId?: string
  onProjectChange?: (projectId: string) => void
  createStep: CreateStep
  placeholder?: string
  submitLabel?: string
  pendingLabel?: string
  submitTitle?: string
}

const CREATE_STEP_LABEL: Record<CreateStep, string> = {
  idle: '',
  'creating-task': 'Creating Task...',
  'creating-teamrun': 'Creating TeamRun...',
  'creating-workspace': 'Creating Workspace...',
  'creating-session': 'Creating Session...',
  'starting-session': 'Starting Agent...',
}

export function CreateTaskInput({
  variant = 'task',
  projects,
  providers,
  isProvidersLoading,
  onSubmit,
  defaultProjectId = '',
  defaultProviderId = '',
  onProjectChange,
  createStep,
  placeholder,
  submitLabel,
  pendingLabel,
  submitTitle,
}: CreateTaskInputProps) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(defaultProjectId)
  const [providerChoiceId, setProviderId] = useState(defaultProviderId)
  const providerId = providers.some(provider => provider.id === providerChoiceId)
    ? providerChoiceId
    : providers.some(provider => provider.id === defaultProviderId) ? defaultProviderId : ''
  const [mode, setMode] = useState<CreateTaskMode>('SOLO')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(WorkspaceKind.WORKTREE)
  const [priority, setPriority] = useState<TaskPriority>(TaskPriority.NORMAL)
  const [baseBranchChoice, setBaseBranchChoice] = useState<{ projectId: string; value: string } | null>(null)
  const [detectedCapabilityByProjectId, setDetectedCapabilityByProjectId] = useState<Record<string, ProjectGitCapability>>({})
  const [teamRunMode, setTeamRunMode] = useState<TeamRunMode>('AUTO')
  const [teamTemplateId, setTeamTemplateId] = useState<string | null>(null)
  const [memberPresetIds, setMemberPresetIds] = useState<string[]>([])
  const [showTeamConfig, setShowTeamConfig] = useState(false)

  const inputContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { files: attachmentFiles, addFiles, removeFile, buildMarkdownLinks, getDoneAttachments, isUploading } = useAttachments()
  const refreshProjectGitCapability = useRefreshProjectGitCapability()
  const isConversationMode = variant === 'conversation'
  const supportsAttachments = variant === 'task' || variant === 'conversation'
  const effectiveSubmitLabel = submitLabel ?? (isConversationMode ? t('开始') : t('创建'))

  useEffect(() => {
    // Existing project selection follows the parent default when it changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjectId(defaultProjectId)
    setBaseBranchChoice(null)
    onProjectChange?.(defaultProjectId)
  }, [defaultProjectId, onProjectChange])
  const selectedProject = useMemo(() => projects.find(p => p.id === projectId), [projects, projectId])
  const selectedProvider = useMemo(() => providers.find(p => p.id === providerId), [providers, providerId])
  const baseBranch = baseBranchChoice?.projectId === projectId ? baseBranchChoice.value : selectedProject?.mainBranch
  const detectedCapability = projectId ? detectedCapabilityByProjectId[projectId] : undefined
  const selectedProjectIsGitRepo = (detectedCapability?.isGitRepo ?? selectedProject?.isGitRepo) !== false
  const selectedProjectWorktreeReady = (detectedCapability?.worktreeReady ?? selectedProject?.worktreeReady) !== false
  const selectedProjectSupportsWorktree = selectedProjectIsGitRepo && selectedProjectWorktreeReady
  const localProjectOnly = !isConversationMode && !selectedProjectSupportsWorktree
  const effectiveCreateMode: CreateTaskMode = localProjectOnly ? 'SOLO' : mode
  const effectiveWorkspaceMode: WorkspaceMode = localProjectOnly ? WorkspaceKind.MAIN_DIRECTORY : workspaceMode
  const selectedProjectGitReason = detectedCapability?.reason ?? selectedProject?.reason
  const slashCommandAgentType = isConversationMode || effectiveCreateMode === 'SOLO'
    ? selectedProvider?.agentType
    : null
  const slashCommandMenu = useSlashCommandMenu({
    agentType: slashCommandAgentType,
    workingDir: isConversationMode ? undefined : selectedProject?.repoPath,
    input: title,
    setInput: setTitle,
    textareaRef: inputRef,
    minHeight: 76,
    maxHeight: 220,
  })

  const isSubmitting = createStep !== 'idle'
  const hasTeamMembers = !!teamTemplateId || memberPresetIds.length > 0
  const canSubmit = !isSubmitting
    && !isUploading
    && title.trim().length > 0
    && (isConversationMode
      ? selectedProvider?.available === true
      : !!projectId && (effectiveCreateMode === 'SOLO' ? selectedProvider?.available === true : hasTeamMembers))

  useEffect(() => {
    if (!localProjectOnly) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode('SOLO')
    setWorkspaceMode(WorkspaceKind.MAIN_DIRECTORY)
    setShowTeamConfig(false)
  }, [localProjectOnly])

  useEffect(() => {
    if (localProjectOnly || isConversationMode) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkspaceMode(WorkspaceKind.WORKTREE)
  }, [isConversationMode, localProjectOnly, selectedProject?.id])

  const handleRefreshGitCapability = useCallback(async () => {
    if (!selectedProject || refreshProjectGitCapability.isPending) return
    const capability = await refreshProjectGitCapability.mutateAsync({ id: selectedProject.id })
    setDetectedCapabilityByProjectId(current => ({ ...current, [selectedProject.id]: capability }))
    if (capability.worktreeReady) {
      setMode('SOLO')
      setWorkspaceMode(WorkspaceKind.WORKTREE)
    }
  }, [refreshProjectGitCapability, selectedProject])

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    const attachmentLinks = supportsAttachments ? buildMarkdownLinks() : ''
    const attachmentIds = supportsAttachments ? getDoneAttachments().map((attachment) => attachment.id) : []
    try {
      const submission = onSubmit({
        title: title.trim(),
        description: '',
        projectId: isConversationMode ? '' : projectId,
        providerId,
        mode: isConversationMode ? 'SOLO' : effectiveCreateMode,
        workspaceMode: !isConversationMode && effectiveCreateMode === 'SOLO' ? effectiveWorkspaceMode : WorkspaceKind.WORKTREE,
        teamRunMode: isConversationMode ? 'AUTO' : teamRunMode,
        teamTemplateId: isConversationMode || localProjectOnly ? null : teamTemplateId,
        memberPresetIds: isConversationMode || localProjectOnly ? [] : memberPresetIds,
        attachmentLinks,
        attachmentIds,
        priority,
        baseBranch: isConversationMode ? undefined : effectiveCreateMode === 'TEAM' || effectiveWorkspaceMode === WorkspaceKind.WORKTREE ? baseBranch : null,
      })
      const clearSubmittedDraft = () => {
        setTitle(current => current === title ? '' : current)
        setPriority(current => current === priority ? TaskPriority.NORMAL : current)
        setBaseBranchChoice(current => current === baseBranchChoice ? null : current)
        if (supportsAttachments) for (const file of attachmentFiles) removeFile(file.tempId)
      }
      // Conversation submissions own an immutable recoverable list item before HTTP.
      if (isConversationMode) clearSubmittedDraft()
      await submission
      if (!isConversationMode) clearSubmittedDraft()
    } catch {
      // Conversation failures are recovered from the submitted message bubble.
    }
  }, [canSubmit, supportsAttachments, buildMarkdownLinks, getDoneAttachments, onSubmit, title, isConversationMode, projectId, providerId, effectiveCreateMode, effectiveWorkspaceMode, teamRunMode, localProjectOnly, teamTemplateId, memberPresetIds, attachmentFiles, removeFile, priority, baseBranch, baseBranchChoice])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashCommandMenu.handleKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit, slashCommandMenu])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (fileList && fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
    e.target.value = ''
  }, [addFiles])

  const handleProjectSelect = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId)
    setBaseBranchChoice(null)
    onProjectChange?.(nextProjectId)
  }, [onProjectChange])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!supportsAttachments) return
    const items = e.clipboardData.items
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles, supportsAttachments])

  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!supportsAttachments) return
    e.preventDefault()
    setIsDragOver(true)
  }, [supportsAttachments])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!supportsAttachments) return
    e.preventDefault()
    setIsDragOver(false)
  }, [supportsAttachments])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!supportsAttachments) return
    e.preventDefault()
    setIsDragOver(false)
    const fileList = e.dataTransfer.files
    if (fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
  }, [addFiles, supportsAttachments])

  return (
    <div className="w-full">
      {/* Input box — matches session input style */}
      <div
        ref={inputContainerRef}
        className={cn(
          'relative bg-background rounded-xl border transition-colors duration-200',
          'shadow-raised',
          'hover:border-ring/40 focus-within:border-ring/60',
          isDragOver
            ? 'border-foreground/40 bg-foreground/[0.02]'
            : 'border-border',
          isSubmitting && 'opacity-80',
        )}
        onDragOver={supportsAttachments ? handleDragOver : undefined}
        onDragLeave={supportsAttachments ? handleDragLeave : undefined}
        onDrop={supportsAttachments ? handleDrop : undefined}
      >
        {/* Attachment preview */}
        {supportsAttachments && attachmentFiles.length > 0 && (
          <div className="px-4 pt-3">
            <AttachmentPreview files={attachmentFiles} onRemove={removeFile} />
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={inputRef}
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={supportsAttachments ? handlePaste : undefined}
          placeholder={placeholder ? t(placeholder) : t('Describe your task...')}
          disabled={isSubmitting}
          autoFocus
          rows={1}
          className="w-full px-4 pt-4 pb-2 bg-transparent border-none focus:outline-none resize-none text-[15px] text-foreground placeholder:text-muted-foreground/80 leading-relaxed"
          style={{ minHeight: '76px', maxHeight: '220px', fieldSizing: 'content' } as React.CSSProperties}
        />

        {/* Drag overlay */}
        {supportsAttachments && isDragOver && (
          <div className="px-4 pb-2">
            <div className="flex items-center justify-center py-3 border border-dashed border-foreground/30 rounded-lg text-xs font-medium text-foreground/80">
              {t('Drop files here')}
            </div>
          </div>
        )}

        {/* Toolbar — attach + submit */}
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <div className="flex items-center gap-1">
            {supportsAttachments ? (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSubmitting || isUploading}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('Attach files')}
                >
                  <Paperclip size={18} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleFileInputChange}
                  className="hidden"
                />
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {supportsAttachments && isUploading && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin motion-reduce:[animation-duration:2.4s]" />
                {t('Uploading...')}
              </span>
            )}
            {isSubmitting && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin motion-reduce:[animation-duration:2.4s]" />
                {t(pendingLabel ?? CREATE_STEP_LABEL[createStep])}
              </span>
            )}
            {!isConversationMode && !isSubmitting && !isUploading && effectiveCreateMode === 'TEAM' && !hasTeamMembers && title.trim().length > 0 && (
              <span className="text-xs text-warning-ink">{t('请选择团队模板或追加成员')}</span>
            )}
            {canSubmit && (
              <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground select-none">
                <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded border border-border bg-muted/60 text-[11px] font-medium text-muted-foreground leading-none">⏎</kbd>
                {effectiveSubmitLabel}
              </span>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                'flex items-center justify-center size-8 rounded-lg transition-all duration-200',
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-raised'
                  : 'bg-muted text-muted-foreground cursor-not-allowed',
              )}
              title={submitTitle ? t(submitTitle) : t('Create & Start')}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
      <SlashCommandPopover
        open={Boolean(slashCommandAgentType) && slashCommandMenu.query !== null}
        anchorRef={inputContainerRef}
        commands={slashCommandMenu.filteredCommands}
        selectedIndex={slashCommandMenu.selectedIndex}
        query={slashCommandMenu.query ?? ''}
        hasCatalog={slashCommandMenu.allCommands.length > 0}
        compact
        onSelect={slashCommandMenu.applyCommand}
      />

      <TaskCreationOptions
        projects={projects}
        providers={providers}
        projectId={projectId}
        providerId={providerId}
        providerChanged={providerId !== defaultProviderId}
        isProvidersLoading={isProvidersLoading}
        mode={effectiveCreateMode}
        workspaceMode={effectiveWorkspaceMode}
        priority={priority}
        baseBranch={baseBranch}
        isConversation={isConversationMode}
        localProjectOnly={localProjectOnly}
        gitReason={selectedProjectGitReason}
        disabled={isSubmitting}
        refreshingGit={refreshProjectGitCapability.isPending}
        onProjectChange={handleProjectSelect}
        onProviderChange={setProviderId}
        onWorkspaceModeChange={setWorkspaceMode}
        onPriorityChange={setPriority}
        onBaseBranchChange={value => setBaseBranchChoice({ projectId, value })}
        onRefreshGit={handleRefreshGitCapability}
        onModeChange={nextMode => {
          if (isSubmitting || (nextMode === 'TEAM' && localProjectOnly)) return
          setMode(nextMode)
          setShowTeamConfig(nextMode === 'TEAM')
          if (nextMode === 'TEAM') setWorkspaceMode(WorkspaceKind.WORKTREE)
        }}
      />

      {selectedProvider && !selectedProvider.available ? (
        <p role="alert" className="mt-2 break-words px-2 text-xs leading-snug text-destructive-ink">
          {selectedProvider.reason ? t(selectedProvider.reason) : t('Agent executable is unavailable.')}
        </p>
      ) : null}

      {/* TeamRun configuration panel — muted secondary area below input */}
      {!isConversationMode && effectiveCreateMode === 'TEAM' && showTeamConfig && (
        <div className="mt-2.5 rounded-xl border border-border/60 bg-muted/40 p-3 animate-[fadeInUp_0.25s_cubic-bezier(0.16,1,0.3,1)]">
          <TeamRunCreateForm
            mode={teamRunMode}
            setMode={setTeamRunMode}
            selectedTemplateId={teamTemplateId}
            setSelectedTemplateId={setTeamTemplateId}
            selectedMemberPresetIds={memberPresetIds}
            setSelectedMemberPresetIds={setMemberPresetIds}
            disabled={isSubmitting}
            compact
          />
        </div>
      )}
    </div>
  )
}
