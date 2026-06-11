import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { ArrowUp, Bot, Paperclip, Loader2, ChevronDown, Check, GitBranch } from 'lucide-react'
import { WorkspaceKind, type TeamRunMode } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import { TeamRunCreateForm } from '@/components/team/TeamRunCreateForm'

type CreateStep = 'idle' | 'creating-task' | 'creating-teamrun' | 'creating-workspace' | 'creating-session' | 'starting-session'
type CreateTaskMode = 'SOLO' | 'TEAM'
type WorkspaceMode = WorkspaceKind.WORKTREE | WorkspaceKind.MAIN_DIRECTORY

interface ProjectOption {
  id: string
  name: string
  color?: string
}

interface ProviderOption {
  id: string
  name: string
  available: boolean
}

export interface CreateTaskInputProps {
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
  }) => Promise<void>
  defaultProjectId?: string
  defaultProviderId?: string
  onProjectChange?: (projectId: string) => void
  createStep: CreateStep
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
  projects,
  providers,
  isProvidersLoading,
  onSubmit,
  defaultProjectId = '',
  defaultProviderId = '',
  onProjectChange,
  createStep,
}: CreateTaskInputProps) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(defaultProjectId)
  const [providerId, setProviderId] = useState(defaultProviderId)
  const [mode, setMode] = useState<CreateTaskMode>('SOLO')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(WorkspaceKind.WORKTREE)
  const [teamRunMode, setTeamRunMode] = useState<TeamRunMode>('AUTO')
  const [teamTemplateId, setTeamTemplateId] = useState<string | null>(null)
  const [memberPresetIds, setMemberPresetIds] = useState<string[]>([])
  const [showTeamConfig, setShowTeamConfig] = useState(false)

  const [showProjectMenu, setShowProjectMenu] = useState(false)
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const [showWorkspaceModeMenu, setShowWorkspaceModeMenu] = useState(false)

  const projectMenuRef = useRef<HTMLDivElement>(null)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const workspaceModeMenuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { files: attachmentFiles, addFiles, removeFile, clear: clearAttachments, buildMarkdownLinks, isUploading } = useAttachments()

  useEffect(() => {
    setProjectId(defaultProjectId)
    onProjectChange?.(defaultProjectId)
  }, [defaultProjectId, onProjectChange])
  useEffect(() => { setProviderId(defaultProviderId) }, [defaultProviderId])

  useEffect(() => {
    if (!showProjectMenu) return
    const handler = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setShowProjectMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showProjectMenu])

  useEffect(() => {
    if (!showProviderMenu) return
    const handler = (e: MouseEvent) => {
      if (providerMenuRef.current && !providerMenuRef.current.contains(e.target as Node)) {
        setShowProviderMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showProviderMenu])

  useEffect(() => {
    if (!showWorkspaceModeMenu) return
    const handler = (e: MouseEvent) => {
      if (workspaceModeMenuRef.current && !workspaceModeMenuRef.current.contains(e.target as Node)) {
        setShowWorkspaceModeMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showWorkspaceModeMenu])

  const selectedProject = useMemo(() => projects.find(p => p.id === projectId), [projects, projectId])
  const selectedProvider = useMemo(() => providers.find(p => p.id === providerId), [providers, providerId])
  const selectedWorkspaceModeLabel = workspaceMode === WorkspaceKind.MAIN_DIRECTORY ? t('本地模式') : t('工作树模式')

  const isSubmitting = createStep !== 'idle'
  const hasTeamMembers = !!teamTemplateId || memberPresetIds.length > 0
  const canSubmit = !isSubmitting && !isUploading && title.trim().length > 0 && !!projectId && (mode === 'TEAM' ? hasTeamMembers : !!providerId)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    const attachmentLinks = buildMarkdownLinks()
    try {
      await onSubmit({
        title: title.trim(),
        description: '',
        projectId,
        providerId,
        mode,
        workspaceMode: mode === 'SOLO' ? workspaceMode : WorkspaceKind.WORKTREE,
        teamRunMode,
        teamTemplateId,
        memberPresetIds,
        attachmentLinks,
      })
      setTitle('')
      clearAttachments()
    } catch {
      // Complete failure — preserve input for retry
    }
  }, [canSubmit, title, projectId, providerId, mode, workspaceMode, teamRunMode, teamTemplateId, memberPresetIds, onSubmit, buildMarkdownLinks, clearAttachments])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (fileList && fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
    e.target.value = ''
  }, [addFiles])

  const handleProjectSelect = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId)
    onProjectChange?.(nextProjectId)
    setShowProjectMenu(false)
  }, [onProjectChange])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
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
  }, [addFiles])

  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const fileList = e.dataTransfer.files
    if (fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
  }, [addFiles])

  return (
    <div className="w-full">
      {/* Input box — matches session input style */}
      <div
        className={cn(
          'relative bg-background rounded-xl border shadow-sm transition-all duration-200',
          'hover:shadow-md focus-within:shadow-md focus-within:border-ring/60',
          isDragOver ? 'border-info bg-info/5 shadow-md' : 'border-border',
          isSubmitting && 'opacity-80',
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Attachment preview */}
        {attachmentFiles.length > 0 && (
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
          onPaste={handlePaste}
          placeholder={t('Describe your task...')}
          disabled={isSubmitting}
          autoFocus
          rows={1}
          className="w-full px-4 pt-4 pb-2 bg-transparent border-none focus:outline-none resize-none text-sm text-foreground placeholder-muted-foreground/70 leading-relaxed"
          style={{ minHeight: '72px', maxHeight: '200px', fieldSizing: 'content' } as React.CSSProperties}
        />

        {/* Drag overlay */}
        {isDragOver && (
          <div className="px-4 pb-2">
            <div className="flex items-center justify-center py-3 border-2 border-dashed border-border rounded-lg text-sm text-muted-foreground">
              {t('Drop files here')}
            </div>
          </div>
        )}

        {/* Toolbar — attach + submit */}
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isSubmitting || isUploading}
              className="p-2 text-muted-foreground/70 hover:text-muted-foreground hover:bg-accent rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
          </div>

          <div className="flex items-center gap-2">
            {isUploading && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                {t('Uploading...')}
              </span>
            )}
            {isSubmitting && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                {t(CREATE_STEP_LABEL[createStep])}
              </span>
            )}
            {!isSubmitting && !isUploading && mode === 'TEAM' && !hasTeamMembers && title.trim().length > 0 && (
              <span className="text-[11px] text-warning">{t('请选择团队模板或追加成员')}</span>
            )}
            {canSubmit && (
              <span className="hidden sm:inline text-[11px] text-muted-foreground/60 select-none">
                ⏎ {t('创建')}
              </span>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                'p-2 rounded-lg transition-all duration-200',
                canSubmit
                  ? 'bg-primary text-primary-foreground shadow-md hover:bg-primary/90'
                  : 'bg-transparent text-muted-foreground/50 cursor-not-allowed',
              )}
              title={t('Create & Start')}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Control row — chips aligned to card edges */}
      <div className="flex items-center flex-wrap gap-1.5 mt-2.5">
        {/* Project selector */}
        <div className="relative" ref={projectMenuRef}>
          <button
            type="button"
            onClick={() => { if (!isSubmitting) setShowProjectMenu(v => !v) }}
            disabled={isSubmitting}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
              'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed',
              selectedProject ? 'text-foreground/80' : 'text-muted-foreground/70',
            )}
          >
            <span
              className="size-2 rounded-full shrink-0"
              style={{ backgroundColor: selectedProject?.color ?? 'var(--muted-foreground)' }}
            />
            <span className="max-w-[120px] truncate">{selectedProject?.name ?? t('Project')}</span>
            <ChevronDown size={12} className={cn('text-muted-foreground/70 transition-transform', showProjectMenu && 'rotate-180')} />
          </button>

          {showProjectMenu && (
            <div className="absolute top-full left-0 mt-1 w-52 bg-background border border-border rounded-lg shadow-lg shadow-black/5 py-1 max-h-[240px] overflow-y-auto z-50">
              {projects.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleProjectSelect(p.id)}
                  className="flex items-center w-full px-3 py-2 text-xs text-left hover:bg-muted/50 transition-colors"
                >
                  <span
                    className="size-2 rounded-full shrink-0 mr-2"
                    style={{ backgroundColor: p.color ?? 'var(--muted-foreground)' }}
                  />
                  <span className={cn('truncate flex-1', p.id === projectId ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {p.name}
                  </span>
                  <Check size={14} className={cn('ml-2 shrink-0', p.id === projectId ? 'opacity-100' : 'opacity-0')} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Provider selector (Solo mode only) */}
        {mode === 'SOLO' && (
          <div className="relative" ref={providerMenuRef}>
            <button
              type="button"
              onClick={() => { if (!isSubmitting) setShowProviderMenu(v => !v) }}
              disabled={isSubmitting}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
                'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed',
                selectedProvider ? 'text-foreground/80' : 'text-muted-foreground/70',
              )}
            >
              <Bot size={14} className="text-muted-foreground" />
              <span className="max-w-[120px] truncate">{selectedProvider?.name ?? (isProvidersLoading ? t('Loading...') : t('Agent'))}</span>
              <ChevronDown size={12} className={cn('text-muted-foreground/70 transition-transform', showProviderMenu && 'rotate-180')} />
            </button>

            {showProviderMenu && (
              <div className="absolute top-full left-0 mt-1 w-52 bg-background border border-border rounded-lg shadow-lg shadow-black/5 py-1 max-h-[240px] overflow-y-auto z-50">
                {providers.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!p.available}
                    onClick={() => { setProviderId(p.id); setShowProviderMenu(false) }}
                    className={cn(
                      'flex items-center w-full px-3 py-2 text-xs text-left hover:bg-muted/50 transition-colors',
                      !p.available && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    <Check size={14} className={cn('mr-2 shrink-0', p.id === providerId ? 'opacity-100' : 'opacity-0')} />
                    <span className={cn('truncate', p.id === providerId ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                      {p.name}{!p.available ? t(' (unavailable)') : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Workspace mode selector (Solo mode only) */}
        {mode === 'SOLO' && (
          <div className="relative" ref={workspaceModeMenuRef}>
            <button
              type="button"
              onClick={() => { if (!isSubmitting) setShowWorkspaceModeMenu(v => !v) }}
              disabled={isSubmitting}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
                'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed',
                'text-foreground/80',
              )}
            >
              <GitBranch size={14} className="text-muted-foreground" />
              <span className="max-w-[96px] truncate">{selectedWorkspaceModeLabel}</span>
              <ChevronDown size={12} className={cn('text-muted-foreground/70 transition-transform', showWorkspaceModeMenu && 'rotate-180')} />
            </button>

            {showWorkspaceModeMenu && (
              <div className="absolute top-full left-0 mt-1 w-40 bg-background border border-border rounded-lg shadow-lg shadow-black/5 py-1 z-50">
                <button
                  type="button"
                  onClick={() => { setWorkspaceMode(WorkspaceKind.WORKTREE); setShowWorkspaceModeMenu(false) }}
                  className="flex items-center w-full px-3 py-2 text-xs text-left hover:bg-muted/50 transition-colors"
                >
                  <Check size={14} className={cn('mr-2 shrink-0', workspaceMode === WorkspaceKind.WORKTREE ? 'opacity-100' : 'opacity-0')} />
                  <span className={cn('truncate', workspaceMode === WorkspaceKind.WORKTREE ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {t('工作树模式')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setWorkspaceMode(WorkspaceKind.MAIN_DIRECTORY); setShowWorkspaceModeMenu(false) }}
                  className="flex items-center w-full px-3 py-2 text-xs text-left hover:bg-muted/50 transition-colors"
                >
                  <Check size={14} className={cn('mr-2 shrink-0', workspaceMode === WorkspaceKind.MAIN_DIRECTORY ? 'opacity-100' : 'opacity-0')} />
                  <span className={cn('truncate', workspaceMode === WorkspaceKind.MAIN_DIRECTORY ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {t('本地模式')}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Solo / Team segmented control */}
        <div className="ml-auto inline-flex items-center rounded-lg border border-border/70 bg-muted/50 p-0.5">
          <button
            type="button"
            onClick={() => {
              if (isSubmitting || mode === 'SOLO') return
              setMode('SOLO')
              setShowTeamConfig(false)
            }}
            disabled={isSubmitting}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              mode === 'SOLO'
                ? 'bg-background text-foreground font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground/80',
            )}
            title={t('Switch to Solo Agent')}
          >
            {t('单人')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (isSubmitting || mode === 'TEAM') return
              setMode('TEAM')
              setShowWorkspaceModeMenu(false)
              setWorkspaceMode(WorkspaceKind.WORKTREE)
              setShowTeamConfig(true)
            }}
            disabled={isSubmitting}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              mode === 'TEAM'
                ? 'bg-background text-foreground font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground/80',
            )}
            title={t('Switch to TeamRun')}
          >
            {t('团队')}
          </button>
        </div>
      </div>

      {mode === 'SOLO' && workspaceMode === WorkspaceKind.MAIN_DIRECTORY && (
        <div className="mt-2">
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
            {t('Agent 将直接修改项目主目录；不会自动提交，也不能使用 Merge、Rebase 或冲突解决流程。')}
          </div>
        </div>
      )}

      {/* TeamRun configuration panel — muted secondary area below input */}
      {mode === 'TEAM' && showTeamConfig && (
        <div className="mt-2 rounded-xl bg-muted/50 px-4 pt-3 pb-4">
          <div className="mb-2.5">
            <span className="text-[11px] font-medium text-muted-foreground">{t('团队协作配置')}</span>
          </div>
          <TeamRunCreateForm
            mode={teamRunMode}
            setMode={setTeamRunMode}
            selectedTemplateId={teamTemplateId}
            setSelectedTemplateId={setTeamTemplateId}
            selectedMemberPresetIds={memberPresetIds}
            setSelectedMemberPresetIds={setMemberPresetIds}
            disabled={isSubmitting}
          />
        </div>
      )}
    </div>
  )
}
