import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { ArrowUp, Bot, Paperclip, Loader2, ChevronDown, Check, GitBranch, Folder, Users } from 'lucide-react'
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
          'relative bg-background rounded-xl border transition-all duration-200',
          'shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
          'hover:border-foreground/15 hover:shadow-[0_2px_6px_rgba(0,0,0,0.05)]',
          'focus-within:border-foreground/25 focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.06)]',
          isDragOver
            ? 'border-info/40 bg-info/5 ring-2 ring-info/15'
            : 'border-border',
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
          className="w-full px-4 pt-4 pb-2 bg-transparent border-none focus:outline-none resize-none text-[15px] text-foreground placeholder:text-muted-foreground/80 leading-relaxed"
          style={{ minHeight: '76px', maxHeight: '220px', fieldSizing: 'content' } as React.CSSProperties}
        />

        {/* Drag overlay */}
        {isDragOver && (
          <div className="px-4 pb-2">
            <div className="flex items-center justify-center py-3 border border-dashed border-info/40 rounded-lg text-xs font-medium text-info">
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
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-muted-foreground/80 select-none">
                <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded border border-border bg-muted/60 text-[10px] font-medium text-muted-foreground leading-none">⏎</kbd>
                {t('创建')}
              </span>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                'flex items-center justify-center size-8 rounded-lg transition-all duration-200',
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
              title={t('Create & Start')}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>

      {/* Control row — chips aligned to card edges */}
      <div className="flex items-center flex-wrap gap-1.5 mt-2.5 px-0.5">
        {/* Project selector */}
        <div className="relative" ref={projectMenuRef}>
          <button
            type="button"
            onClick={() => { if (!isSubmitting) setShowProjectMenu(v => !v) }}
            disabled={isSubmitting}
            className={cn(
              'flex items-center gap-1.5 px-2 h-7 rounded-md text-xs font-medium transition-colors',
              'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed',
              selectedProject ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <Folder
              size={14}
              className="shrink-0"
              style={{ color: selectedProject?.color ?? 'var(--muted-foreground)' }}
            />
            <span className="max-w-[120px] truncate">{selectedProject?.name ?? t('Project')}</span>
            <ChevronDown size={12} className={cn('text-muted-foreground transition-transform', showProjectMenu && 'rotate-180')} />
          </button>

          {showProjectMenu && (
            <div className="absolute top-full left-0 mt-1.5 w-56 bg-popover border border-border rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.06)] py-1 max-h-[240px] overflow-y-auto z-50">
              {projects.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleProjectSelect(p.id)}
                  className="flex items-center w-full px-3 py-2 text-xs text-left hover:bg-accent transition-colors"
                >
                  <span
                    className="size-2 rounded-full shrink-0 mr-2"
                    style={{ backgroundColor: p.color ?? 'var(--muted-foreground)' }}
                  />
                  <span className={cn('truncate flex-1', p.id === projectId ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {p.name}
                  </span>
                  <Check size={14} className={cn('ml-2 shrink-0 text-foreground', p.id === projectId ? 'opacity-100' : 'opacity-0')} />
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
                'flex items-center gap-1.5 px-2 h-7 rounded-md text-xs font-medium transition-colors',
                'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed',
                selectedProvider ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <Bot size={14} className="text-muted-foreground" />
              <span className="max-w-[120px] truncate">{selectedProvider?.name ?? (isProvidersLoading ? t('Loading...') : t('Agent'))}</span>
              <ChevronDown size={12} className={cn('text-muted-foreground transition-transform', showProviderMenu && 'rotate-180')} />
            </button>

            {showProviderMenu && (
              <div className="absolute top-full left-0 mt-1.5 w-56 bg-popover border border-border rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.06)] py-1 max-h-[240px] overflow-y-auto z-50">
                {providers.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!p.available}
                    onClick={() => { setProviderId(p.id); setShowProviderMenu(false) }}
                    className={cn(
                      'flex items-center w-full px-3 py-2 text-xs text-left hover:bg-accent transition-colors',
                      !p.available && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    <Check size={14} className={cn('mr-2 shrink-0 text-foreground', p.id === providerId ? 'opacity-100' : 'opacity-0')} />
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
                'flex items-center gap-1.5 px-2 h-7 rounded-md text-xs font-medium transition-colors',
                'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed text-foreground',
              )}
            >
              <GitBranch size={14} className="text-muted-foreground" />
              <span className="max-w-[96px] truncate">{selectedWorkspaceModeLabel}</span>
              <ChevronDown size={12} className={cn('text-muted-foreground transition-transform', showWorkspaceModeMenu && 'rotate-180')} />
            </button>

            {showWorkspaceModeMenu && (
              <div className="absolute top-full left-0 mt-1.5 w-44 bg-popover border border-border rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.06)] py-1 z-50">
                <button
                  type="button"
                  onClick={() => { setWorkspaceMode(WorkspaceKind.WORKTREE); setShowWorkspaceModeMenu(false) }}
                  className="flex items-center w-full px-3 py-2 text-xs text-left hover:bg-accent transition-colors"
                >
                  <Check size={14} className={cn('mr-2 shrink-0 text-foreground', workspaceMode === WorkspaceKind.WORKTREE ? 'opacity-100' : 'opacity-0')} />
                  <span className={cn('truncate', workspaceMode === WorkspaceKind.WORKTREE ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {t('工作树模式')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { setWorkspaceMode(WorkspaceKind.MAIN_DIRECTORY); setShowWorkspaceModeMenu(false) }}
                  className="flex items-center w-full px-3 py-2 text-xs text-left hover:bg-accent transition-colors"
                >
                  <Check size={14} className={cn('mr-2 shrink-0 text-foreground', workspaceMode === WorkspaceKind.MAIN_DIRECTORY ? 'opacity-100' : 'opacity-0')} />
                  <span className={cn('truncate', workspaceMode === WorkspaceKind.MAIN_DIRECTORY ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {t('本地模式')}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Team mode toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={mode === 'TEAM'}
          onClick={() => {
            if (isSubmitting) return
            if (mode === 'TEAM') {
              setMode('SOLO')
              setShowTeamConfig(false)
            } else {
              setMode('TEAM')
              setShowWorkspaceModeMenu(false)
              setWorkspaceMode(WorkspaceKind.WORKTREE)
              setShowTeamConfig(true)
            }
          }}
          disabled={isSubmitting}
          className={cn(
            'ml-auto flex items-center gap-2 h-7 pl-2 pr-2 rounded-md text-xs font-medium transition-colors',
            'hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            mode === 'TEAM' ? 'text-foreground' : 'text-muted-foreground',
          )}
          title={t('启用团队模式')}
        >
          <Users size={14} className={mode === 'TEAM' ? 'text-foreground' : 'text-muted-foreground'} />
          <span>{t('团队模式')}</span>
          <span
            className={cn(
              'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
              mode === 'TEAM' ? 'bg-primary' : 'bg-border',
            )}
          >
            <span
              className={cn(
                'inline-block size-3 rounded-full bg-background shadow-sm transition-transform',
                mode === 'TEAM' ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </span>
        </button>
      </div>

      {mode === 'SOLO' && workspaceMode === WorkspaceKind.MAIN_DIRECTORY && (
        <div className="mt-2.5">
          <div className="rounded-lg border border-warning/25 bg-warning/8 px-3 py-2 text-xs leading-relaxed text-warning/90">
            {t('Agent 将直接修改项目主目录；不会自动提交，也不能使用 Merge、Rebase 或冲突解决流程。')}
          </div>
        </div>
      )}

      {/* TeamRun configuration panel — muted secondary area below input */}
      {mode === 'TEAM' && showTeamConfig && (
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
