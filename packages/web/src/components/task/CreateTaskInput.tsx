import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { ArrowUp, FolderOpen, Bot, Paperclip, Users, Loader2, ChevronDown, Check } from 'lucide-react'
import type { TeamRunMode } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import { TeamRunCreateForm } from '@/components/team/TeamRunCreateForm'

type CreateStep = 'idle' | 'creating-task' | 'creating-teamrun' | 'creating-workspace' | 'creating-session' | 'starting-session'
type CreateTaskMode = 'SOLO' | 'TEAM'

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
    teamRunMode: TeamRunMode
    teamTemplateId: string | null
    memberPresetIds: string[]
    attachmentLinks: string
  }) => Promise<void>
  defaultProjectId?: string
  defaultProviderId?: string
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
  createStep,
}: CreateTaskInputProps) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(defaultProjectId)
  const [providerId, setProviderId] = useState(defaultProviderId)
  const [mode, setMode] = useState<CreateTaskMode>('SOLO')
  const [teamRunMode, setTeamRunMode] = useState<TeamRunMode>('AUTO')
  const [teamTemplateId, setTeamTemplateId] = useState<string | null>(null)
  const [memberPresetIds, setMemberPresetIds] = useState<string[]>([])
  const [showTeamConfig, setShowTeamConfig] = useState(false)

  const [showProjectMenu, setShowProjectMenu] = useState(false)
  const [showProviderMenu, setShowProviderMenu] = useState(false)

  const projectMenuRef = useRef<HTMLDivElement>(null)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { files: attachmentFiles, addFiles, removeFile, clear: clearAttachments, buildMarkdownLinks, isUploading } = useAttachments()

  useEffect(() => { setProjectId(defaultProjectId) }, [defaultProjectId])
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

  const selectedProject = useMemo(() => projects.find(p => p.id === projectId), [projects, projectId])
  const selectedProvider = useMemo(() => providers.find(p => p.id === providerId), [providers, providerId])

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
  }, [canSubmit, title, projectId, providerId, mode, teamRunMode, teamTemplateId, memberPresetIds, onSubmit, buildMarkdownLinks, clearAttachments])

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
          'relative bg-white rounded-xl border shadow-sm transition-all duration-200',
          'hover:shadow-md focus-within:shadow-md focus-within:border-neutral-300',
          isDragOver ? 'border-blue-400 bg-blue-50/50 shadow-md' : 'border-neutral-200',
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
          rows={1}
          className="w-full px-4 pt-4 pb-2 bg-transparent border-none focus:outline-none resize-none text-sm text-neutral-900 placeholder-neutral-400 leading-relaxed"
          style={{ minHeight: '72px', maxHeight: '200px', fieldSizing: 'content' } as React.CSSProperties}
        />

        {/* Drag overlay */}
        {isDragOver && (
          <div className="px-4 pb-2">
            <div className="flex items-center justify-center py-3 border-2 border-dashed border-neutral-300 rounded-lg text-sm text-neutral-500">
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
              className="p-2 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
              <span className="flex items-center gap-1.5 text-xs text-neutral-500">
                <Loader2 size={14} className="animate-spin" />
                {t('Uploading...')}
              </span>
            )}
            {isSubmitting && (
              <span className="flex items-center gap-1.5 text-xs text-neutral-500">
                <Loader2 size={14} className="animate-spin" />
                {t(CREATE_STEP_LABEL[createStep])}
              </span>
            )}
            {!isSubmitting && !isUploading && mode === 'TEAM' && !hasTeamMembers && title.trim().length > 0 && (
              <span className="text-[11px] text-amber-600">{t('请选择团队模板或追加成员')}</span>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                'p-2 rounded-lg transition-all duration-200',
                canSubmit
                  ? 'bg-neutral-900 text-white shadow-md hover:bg-black'
                  : 'bg-transparent text-neutral-300 cursor-not-allowed',
              )}
              title={t('Create & Start')}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Control options — below input box */}
      <div className="flex items-center flex-wrap gap-1 mt-3 px-1">
        {/* Project selector */}
        <div className="relative" ref={projectMenuRef}>
          <button
            type="button"
            onClick={() => { if (!isSubmitting) setShowProjectMenu(v => !v) }}
            disabled={isSubmitting}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
              'hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed',
              selectedProject ? 'text-neutral-700' : 'text-neutral-400',
            )}
          >
            <FolderOpen size={14} />
            <span className="max-w-[120px] truncate">{selectedProject?.name ?? t('Project')}</span>
            <ChevronDown size={12} className={cn('transition-transform', showProjectMenu && 'rotate-180')} />
          </button>

          {showProjectMenu && (
            <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-neutral-200 rounded-lg shadow-lg shadow-neutral-200/50 py-1 max-h-[240px] overflow-y-auto z-50">
              {projects.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setProjectId(p.id); setShowProjectMenu(false) }}
                  className="flex items-center w-full px-3 py-2 text-xs text-left hover:bg-neutral-50 transition-colors"
                >
                  <Check size={14} className={cn('mr-2 shrink-0', p.id === projectId ? 'opacity-100' : 'opacity-0')} />
                  <span className={cn('truncate', p.id === projectId ? 'text-neutral-900 font-medium' : 'text-neutral-600')}>
                    {p.name}
                  </span>
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
                'hover:bg-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed',
                selectedProvider ? 'text-neutral-700' : 'text-neutral-400',
              )}
            >
              <Bot size={14} />
              <span className="max-w-[120px] truncate">{selectedProvider?.name ?? (isProvidersLoading ? t('Loading...') : t('Agent'))}</span>
              <ChevronDown size={12} className={cn('transition-transform', showProviderMenu && 'rotate-180')} />
            </button>

            {showProviderMenu && (
              <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-neutral-200 rounded-lg shadow-lg shadow-neutral-200/50 py-1 max-h-[240px] overflow-y-auto z-50">
                {providers.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!p.available}
                    onClick={() => { setProviderId(p.id); setShowProviderMenu(false) }}
                    className={cn(
                      'flex items-center w-full px-3 py-2 text-xs text-left hover:bg-neutral-50 transition-colors',
                      !p.available && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    <Check size={14} className={cn('mr-2 shrink-0', p.id === providerId ? 'opacity-100' : 'opacity-0')} />
                    <span className={cn('truncate', p.id === providerId ? 'text-neutral-900 font-medium' : 'text-neutral-600')}>
                      {p.name}{!p.available ? t(' (unavailable)') : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Team mode toggle — tab trigger connected to panel below */}
        <button
          type="button"
          onClick={() => {
            if (isSubmitting) return
            const next = mode === 'SOLO' ? 'TEAM' : 'SOLO'
            setMode(next)
            if (next === 'TEAM') setShowTeamConfig(true)
            else setShowTeamConfig(false)
          }}
          disabled={isSubmitting}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            mode === 'TEAM'
              ? 'text-blue-600 bg-neutral-50 rounded-t-lg rounded-b-none'
              : 'text-neutral-500 hover:text-neutral-700 hover:bg-neutral-50 rounded-lg',
          )}
          title={mode === 'SOLO' ? t('Switch to TeamRun') : t('Switch to Solo Agent')}
        >
          <Users size={14} />
          <span>{t('团队协作')}</span>
        </button>
      </div>

      {/* TeamRun configuration panel */}
      {mode === 'TEAM' && showTeamConfig && (
        <div className="rounded-b-xl rounded-tr-xl bg-neutral-50 px-4 pt-3 pb-4">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11px] font-medium text-neutral-500">{t('团队协作配置')}</span>
            <button
              type="button"
              onClick={() => {
                setMode('SOLO')
                setShowTeamConfig(false)
              }}
              className="text-[11px] text-neutral-400 hover:text-neutral-600 transition-colors"
            >
              {t('切换回单 Agent')}
            </button>
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
