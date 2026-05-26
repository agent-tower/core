import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, ChevronUp, ChevronDown, Upload } from 'lucide-react'
import type {
  Attachment,
  MemberPreset,
  TeamMemberCapabilities,
  TeamMemberSessionPolicy,
  TeamMemberTriggerPolicy,
  TeamTemplate,
  WorkspacePolicy,
} from '@agent-tower/shared'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Modal } from '@/components/ui/modal'
import { Select } from '@/components/ui/select'
import { AVATAR_PRESETS } from '@/components/team/avatar-presets'
import { MemberAvatar } from '@/components/team/MemberAvatar'
import { useProviders } from '@/hooks/use-providers'
import {
  useCreateMemberPreset,
  useCreateTeamTemplate,
  useDeleteMemberPreset,
  useDeleteTeamTemplate,
  useMemberPresets,
  useTeamTemplates,
  useUpdateMemberPreset,
  useUpdateTeamTemplate,
} from '@/hooks/use-team-run'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'
const MAX_AVATAR_UPLOAD_BYTES = 2 * 1024 * 1024
const EMPTY_MEMBER_PRESETS: MemberPreset[] = []
const EMPTY_TEAM_TEMPLATES: TeamTemplate[] = []
type ProviderRow = NonNullable<ReturnType<typeof useProviders>['data']>[number]
const EMPTY_PROVIDER_ROWS: ProviderRow[] = []

type EditorTab = 'presets' | 'templates'
type EditorMode = 'create' | 'edit'

interface MemberPresetFormState {
  name: string
  aliasesText: string
  providerId: string
  rolePrompt: string
  capabilities: TeamMemberCapabilities
  workspacePolicy: WorkspacePolicy
  triggerPolicy: TeamMemberTriggerPolicy
  sessionPolicy: TeamMemberSessionPolicy
  avatar: string
}

interface TeamTemplateFormState {
  name: string
  memberPresetIds: string[]
}

const CAPABILITY_FIELDS: Array<{ key: keyof TeamMemberCapabilities; label: string }> = [
  { key: 'readRoom', label: '读房间' },
  { key: 'postRoomMessage', label: '发房间消息' },
  { key: 'mentionMembers', label: '提及成员' },
  { key: 'stopMemberWork', label: '停止成员工作' },
  { key: 'markReadyForReview', label: '标记可审查' },
  { key: 'readFiles', label: '读文件' },
  { key: 'writeFiles', label: '写文件' },
  { key: 'runCommands', label: '运行命令' },
  { key: 'readDiff', label: '读 diff' },
  { key: 'mergeWorkspace', label: '合并工作区' },
]

const DEFAULT_CAPABILITIES: TeamMemberCapabilities = {
  readRoom: false,
  postRoomMessage: false,
  mentionMembers: false,
  stopMemberWork: false,
  markReadyForReview: false,
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  readDiff: false,
  mergeWorkspace: false,
}

const WORKSPACE_POLICY_OPTIONS: Array<{ value: WorkspacePolicy; label: string }> = [
  { value: 'none', label: '无' },
  { value: 'shared', label: '共享' },
  { value: 'dedicated', label: '独占' },
]

const WORKSPACE_POLICY_LABELS: Record<WorkspacePolicy, string> = {
  none: '无',
  shared: '共享',
  dedicated: '独占',
}

const TRIGGER_POLICY_OPTIONS: Array<{ value: TeamMemberTriggerPolicy; label: string }> = [
  { value: 'MENTION_ONLY', label: '仅提及' },
  { value: 'USER_MESSAGES', label: '所有用户消息' },
]

const TRIGGER_POLICY_LABELS: Record<TeamMemberTriggerPolicy, string> = {
  MENTION_ONLY: '仅提及',
  USER_MESSAGES: '所有用户消息',
}

const SESSION_POLICY_OPTIONS: Array<{ value: TeamMemberSessionPolicy; label: string }> = [
  { value: 'new_per_request', label: '每次新会话' },
  { value: 'resume_last', label: '复用上次会话' },
]

const SESSION_POLICY_LABELS: Record<TeamMemberSessionPolicy, string> = {
  new_per_request: '每次新会话',
  resume_last: '复用上次会话',
}

function createBlankMemberPresetForm(): MemberPresetFormState {
  return {
    name: '',
    aliasesText: '',
    providerId: '',
    rolePrompt: '',
    capabilities: { ...DEFAULT_CAPABILITIES },
    workspacePolicy: 'none',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'new_per_request',
    avatar: '',
  }
}

function memberPresetToForm(preset: MemberPreset): MemberPresetFormState {
  return {
    name: preset.name,
    aliasesText: preset.aliases.join(', '),
    providerId: preset.providerId,
    rolePrompt: preset.rolePrompt,
    capabilities: { ...DEFAULT_CAPABILITIES, ...preset.capabilities },
    workspacePolicy: preset.workspacePolicy,
    triggerPolicy: preset.triggerPolicy,
    sessionPolicy: preset.sessionPolicy,
    avatar: preset.avatar ?? '',
  }
}

function createBlankTemplateForm(): TeamTemplateFormState {
  return {
    name: '',
    memberPresetIds: [],
  }
}

function teamTemplateToForm(template: TeamTemplate): TeamTemplateFormState {
  return {
    name: template.name,
    memberPresetIds: template.members?.map(member => member.memberPresetId) ?? [],
  }
}

function getInstanceLabel(name: string, index: number, ids: string[], id: string): string {
  const totalForId = ids.filter(item => item === id).length
  if (totalForId <= 1) return name

  const instanceNumber = ids.slice(0, index + 1).filter(item => item === id).length
  return `${name} #${instanceNumber}`
}

function parseAliasesText(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]/)
        .map(item => item.trim())
        .filter(Boolean),
    ),
  )
}

function normalizeAvatar(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

function getCapabilityCount(capabilities: TeamMemberCapabilities): number {
  return CAPABILITY_FIELDS.reduce((count, field) => count + (capabilities[field.key] ? 1 : 0), 0)
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function isSupportedAvatarFile(file: File) {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
}

async function uploadAvatarFile(file: File): Promise<Attachment> {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`${API_BASE_URL}/attachments/upload`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || error.message || `Upload failed (${response.status})`)
  }

  return response.json()
}

interface QueryErrorNoticeProps {
  title: string
  error: unknown
  isFetching: boolean
  onRetry: () => void
}

function QueryErrorNotice({ title, error, isFetching, onRetry }: QueryErrorNoticeProps) {
  const { t } = useI18n()

  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          <div className="mt-1 text-xs text-red-600">
            {getErrorMessage(error, t('请稍后重试。'))}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={isFetching}
        >
          {isFetching ? t('加载中...') : t('重试')}
        </Button>
      </div>
    </div>
  )
}

export function TeamSettingsPage() {
  const { t } = useI18n()
  const {
    data: providersData,
    error: providersError,
    isError: providersIsError,
    isFetching: providersFetching,
    isLoading: providersLoading,
    refetch: refetchProviders,
  } = useProviders()
  const {
    data: presetsData,
    error: presetsError,
    isError: presetsIsError,
    isFetching: presetsFetching,
    isLoading: presetsLoading,
    refetch: refetchPresets,
  } = useMemberPresets()
  const {
    data: templatesData,
    error: templatesError,
    isError: templatesIsError,
    isFetching: templatesFetching,
    isLoading: templatesLoading,
    refetch: refetchTemplates,
  } = useTeamTemplates()

  const createPreset = useCreateMemberPreset()
  const updatePreset = useUpdateMemberPreset()
  const deletePreset = useDeleteMemberPreset()
  const createTemplate = useCreateTeamTemplate()
  const updateTemplate = useUpdateTeamTemplate()
  const deleteTemplate = useDeleteTeamTemplate()

  const [activeTab, setActiveTab] = useState<EditorTab>('presets')

  const [presetMode, setPresetMode] = useState<EditorMode>('edit')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [presetForm, setPresetForm] = useState<MemberPresetFormState>(createBlankMemberPresetForm())
  const [presetDirty, setPresetDirty] = useState(false)
  const [deletePresetTarget, setDeletePresetTarget] = useState<MemberPreset | null>(null)
  const [isAvatarPickerOpen, setIsAvatarPickerOpen] = useState(false)
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false)
  const avatarFileInputRef = useRef<HTMLInputElement>(null)

  const [templateMode, setTemplateMode] = useState<EditorMode>('edit')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [templateForm, setTemplateForm] = useState<TeamTemplateFormState>(createBlankTemplateForm())
  const [templateDirty, setTemplateDirty] = useState(false)
  const [deleteTemplateTarget, setDeleteTemplateTarget] = useState<TeamTemplate | null>(null)

  const presets = presetsData ?? EMPTY_MEMBER_PRESETS
  const templates = templatesData ?? EMPTY_TEAM_TEMPLATES
  const providerRows = providersData ?? EMPTY_PROVIDER_ROWS

  const presetById = useMemo(
    () => new Map(presets.map(preset => [preset.id, preset] as const)),
    [presets],
  )

  const templateById = useMemo(
    () => new Map(templates.map(template => [template.id, template] as const)),
    [templates],
  )

  const providerOptions = useMemo(() => {
    const options = providerRows.map(({ provider, availability }) => ({
      value: provider.id,
      label: provider.name + (availability.type === 'NOT_FOUND' ? t(' (不可用)') : ''),
      disabled: availability.type === 'NOT_FOUND',
    }))

    if (presetForm.providerId && !options.some(option => option.value === presetForm.providerId)) {
      options.unshift({
        value: presetForm.providerId,
        label: `${presetForm.providerId}${t(' (不可用)')}`,
        disabled: true,
      })
    }

    return options
  }, [presetForm.providerId, providerRows, t])

  const selectedPreset = selectedPresetId ? presetById.get(selectedPresetId) ?? null : null
  const selectedTemplate = selectedTemplateId ? templateById.get(selectedTemplateId) ?? null : null
  const presetProviderLabelById = useMemo(() => {
    return new Map(providerRows.map(({ provider, availability }) => [
      provider.id,
      provider.name + (availability.type === 'NOT_FOUND' ? t(' (不可用)') : ''),
    ] as const))
  }, [providerRows, t])

  useEffect(() => {
    if (presetsLoading || presetsIsError) return
    if (presetDirty) return

    if (presetMode === 'create') {
      setPresetForm(createBlankMemberPresetForm())
      return
    }

    if (selectedPresetId) {
      const selected = presetById.get(selectedPresetId)
      if (selected) {
        setPresetForm(memberPresetToForm(selected))
      }
      return
    }

    if (presets.length > 0) {
      const first = presets[0]
      setSelectedPresetId(first.id)
      setPresetMode('edit')
      setPresetForm(memberPresetToForm(first))
      return
    }

    setPresetMode('create')
    setSelectedPresetId(null)
    setPresetForm(createBlankMemberPresetForm())
  }, [presetById, presetDirty, presetMode, presets, presetsIsError, presetsLoading, selectedPresetId])

  useEffect(() => {
    if (templatesLoading || templatesIsError) return
    if (templateDirty) return

    if (templateMode === 'create') {
      setTemplateForm(createBlankTemplateForm())
      return
    }

    if (selectedTemplateId) {
      const selected = templateById.get(selectedTemplateId)
      if (selected) {
        setTemplateForm(teamTemplateToForm(selected))
      }
      return
    }

    if (templates.length > 0) {
      const first = templates[0]
      setSelectedTemplateId(first.id)
      setTemplateMode('edit')
      setTemplateForm(teamTemplateToForm(first))
      return
    }

    setTemplateMode('create')
    setSelectedTemplateId(null)
    setTemplateForm(createBlankTemplateForm())
  }, [selectedTemplateId, templateById, templateDirty, templateMode, templates, templatesIsError, templatesLoading])

  if (providersLoading || presetsLoading || templatesLoading) {
    return <div className="p-6 text-sm text-neutral-400">{t('加载中...')}</div>
  }

  const updatePresetField = <K extends keyof MemberPresetFormState>(field: K, value: MemberPresetFormState[K]) => {
    setPresetForm(prev => ({ ...prev, [field]: value }))
    setPresetDirty(true)
  }

  const updatePresetCapability = (key: keyof TeamMemberCapabilities, checked: boolean) => {
    setPresetForm(prev => ({
      ...prev,
      capabilities: {
        ...prev.capabilities,
        [key]: checked,
      },
    }))
    setPresetDirty(true)
  }

  const handleSelectPresetAvatar = (avatar: string) => {
    updatePresetField('avatar', avatar)
    setIsAvatarPickerOpen(false)
  }

  const handleClearAvatar = () => {
    updatePresetField('avatar', '')
  }

  const handleAvatarUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!isSupportedAvatarFile(file)) {
      toast.error(t('仅支持 PNG、JPG、WebP 头像。'))
      return
    }

    if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
      toast.error(t('头像图片不能超过 2MB。'))
      return
    }

    setIsUploadingAvatar(true)
    try {
      const attachment = await uploadAvatarFile(file)
      updatePresetField('avatar', `${API_BASE_URL}${attachment.url}`)
      toast.success(t('头像已上传'))
    } catch (error) {
      toast.error(getErrorMessage(error, t('头像上传失败')))
    } finally {
      setIsUploadingAvatar(false)
    }
  }

  const applyPresetSelection = (mode: EditorMode, preset: MemberPreset | null) => {
    setPresetMode(mode)
    setSelectedPresetId(preset?.id ?? null)
    setPresetForm(preset ? memberPresetToForm(preset) : createBlankMemberPresetForm())
    setPresetDirty(false)
  }

  const updateTemplateField = <K extends keyof TeamTemplateFormState>(field: K, value: TeamTemplateFormState[K]) => {
    setTemplateForm(prev => ({ ...prev, [field]: value }))
    setTemplateDirty(true)
  }

  const applyTemplateSelection = (mode: EditorMode, template: TeamTemplate | null) => {
    setTemplateMode(mode)
    setSelectedTemplateId(template?.id ?? null)
    setTemplateForm(template ? teamTemplateToForm(template) : createBlankTemplateForm())
    setTemplateDirty(false)
  }

  const handlePresetSave = async () => {
    const payload = {
      name: presetForm.name.trim(),
      aliases: parseAliasesText(presetForm.aliasesText),
      providerId: presetForm.providerId.trim(),
      rolePrompt: presetForm.rolePrompt.trim(),
      capabilities: { ...presetForm.capabilities },
      workspacePolicy: presetForm.workspacePolicy,
      triggerPolicy: presetForm.triggerPolicy,
      sessionPolicy: presetForm.sessionPolicy,
      avatar: normalizeAvatar(presetForm.avatar),
    }

    try {
      if (presetMode === 'create' || !selectedPresetId) {
        const created = await createPreset.mutateAsync(payload)
        applyPresetSelection('edit', created)
        toast.success(t('已创建'))
      } else {
        const updated = await updatePreset.mutateAsync({ id: selectedPresetId, data: payload })
        applyPresetSelection('edit', updated)
        toast.success(t('已保存'))
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('保存失败')))
    }
  }

  const handleDeletePreset = async () => {
    if (!deletePresetTarget) return

    try {
      await deletePreset.mutateAsync(deletePresetTarget.id)
      toast.success(t('Deleted'))
      const remaining = presets.filter(preset => preset.id !== deletePresetTarget.id)
      if (selectedPresetId === deletePresetTarget.id) {
        if (remaining.length > 0) {
          applyPresetSelection('edit', remaining[0])
        } else {
          applyPresetSelection('create', null)
        }
      }
      setDeletePresetTarget(null)
    } catch (error) {
      toast.error(getErrorMessage(error, t('删除失败')))
    }
  }

  const handleTemplateSave = async () => {
    const payload = {
      name: templateForm.name.trim(),
      memberPresetIds: templateForm.memberPresetIds,
    }

    try {
      if (templateMode === 'create' || !selectedTemplateId) {
        const created = await createTemplate.mutateAsync(payload)
        applyTemplateSelection('edit', created)
        toast.success(t('已创建'))
      } else {
        const updated = await updateTemplate.mutateAsync({ id: selectedTemplateId, data: payload })
        applyTemplateSelection('edit', updated)
        toast.success(t('已保存'))
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('保存失败')))
    }
  }

  const handleDeleteTemplate = async () => {
    if (!deleteTemplateTarget) return

    try {
      await deleteTemplate.mutateAsync(deleteTemplateTarget.id)
      toast.success(t('Deleted'))
      const remaining = templates.filter(template => template.id !== deleteTemplateTarget.id)
      if (selectedTemplateId === deleteTemplateTarget.id) {
        if (remaining.length > 0) {
          applyTemplateSelection('edit', remaining[0])
        } else {
          applyTemplateSelection('create', null)
        }
      }
      setDeleteTemplateTarget(null)
    } catch (error) {
      toast.error(getErrorMessage(error, t('删除失败')))
    }
  }

  const selectedPresetCount = getCapabilityCount(presetForm.capabilities)
  const canSavePreset = Boolean(presetForm.name.trim())
    && Boolean(presetForm.providerId.trim())
    && Boolean(presetForm.rolePrompt.trim())
    && !providersIsError
    && !presetsIsError
    && !createPreset.isPending && !updatePreset.isPending
  const canSaveTemplate = Boolean(templateForm.name.trim())
    && !templatesIsError
    && !presetsIsError
    && !createTemplate.isPending && !updateTemplate.isPending

  const selectedTemplateRows = templateForm.memberPresetIds
    .map((memberPresetId) => presetById.get(memberPresetId))
    .filter((item): item is MemberPreset => Boolean(item))

  const onSelectPreset = (preset: MemberPreset) => {
    setPresetDirty(false)
    applyPresetSelection('edit', preset)
  }

  const onCreatePreset = () => {
    setPresetDirty(false)
    applyPresetSelection('create', null)
  }

  const onSelectTemplate = (template: TeamTemplate) => {
    setTemplateDirty(false)
    applyTemplateSelection('edit', template)
  }

  const onCreateTemplate = () => {
    setTemplateDirty(false)
    applyTemplateSelection('create', null)
  }

  const addTemplatePreset = (presetId: string) => {
    setTemplateForm(prev => {
      return {
        ...prev,
        memberPresetIds: [...prev.memberPresetIds, presetId],
      }
    })
    setTemplateDirty(true)
  }

  const removeTemplatePreset = (index: number) => {
    setTemplateForm(prev => ({
      ...prev,
      memberPresetIds: prev.memberPresetIds.filter((_, itemIndex) => itemIndex !== index),
    }))
    setTemplateDirty(true)
  }

  const moveTemplatePreset = (index: number, direction: -1 | 1) => {
    setTemplateForm(prev => {
      const nextIndex = index + direction
      if (nextIndex < 0 || nextIndex >= prev.memberPresetIds.length) return prev

      const next = [...prev.memberPresetIds]
      const [item] = next.splice(index, 1)
      next.splice(nextIndex, 0, item)

      return {
        ...prev,
        memberPresetIds: next,
      }
    })
    setTemplateDirty(true)
  }

  return (
    <div className="px-10 py-6 mx-auto w-full max-w-6xl space-y-6">
      <section className="space-y-1">
        <h2 className="text-lg font-semibold text-neutral-900">{t('团队协作设置')}</h2>
        <p className="text-sm text-neutral-500">{t('管理成员预设与团队模板。')}</p>
      </section>

      {providersIsError && (
        <QueryErrorNotice
          title={t('Provider 列表加载失败')}
          error={providersError}
          isFetching={providersFetching}
          onRetry={() => void refetchProviders()}
        />
      )}

      <div className="inline-flex rounded-md border border-neutral-200 bg-neutral-50 p-1">
        <button
          type="button"
          onClick={() => setActiveTab('presets')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            activeTab === 'presets'
              ? 'bg-white text-neutral-900 shadow-sm'
              : 'text-neutral-500 hover:text-neutral-900',
          )}
        >
          {t('成员预设')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('templates')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            activeTab === 'templates'
              ? 'bg-white text-neutral-900 shadow-sm'
              : 'text-neutral-500 hover:text-neutral-900',
          )}
        >
          {t('团队模板')}
        </button>
      </div>

      {activeTab === 'presets' ? (
        <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold text-neutral-900">{t('成员预设')}</h3>
                <p className="text-[12px] text-neutral-400">{t('点击列表项可编辑。')}</p>
              </div>
              <Button size="sm" variant="outline" onClick={onCreatePreset}>
                <Plus size={14} />
                {t('新增')}
              </Button>
            </div>

            {presetsIsError ? (
              <QueryErrorNotice
                title={t('成员预设加载失败')}
                error={presetsError}
                isFetching={presetsFetching}
                onRetry={() => void refetchPresets()}
              />
            ) : presets.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-200 p-4 text-sm text-neutral-400">
                {t('当前没有成员预设')}
              </div>
            ) : (
              <div className="space-y-2">
                {presets.map(preset => {
                  const isSelected = presetMode === 'edit' && preset.id === selectedPresetId
                  const providerLabel = presetProviderLabelById.get(preset.providerId) ?? preset.providerId
                  const enabledCount = getCapabilityCount(preset.capabilities)

                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => onSelectPreset(preset)}
                      className={cn(
                        'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                        isSelected
                          ? 'border-neutral-900 bg-neutral-50'
                          : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <MemberAvatar
                          name={preset.name}
                          avatar={preset.avatar}
                          className="h-10 w-10 text-[11px]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-neutral-900">{preset.name}</div>
                              <div className="truncate text-xs text-neutral-500">{providerLabel}</div>
                            </div>
                            <div className="shrink-0 text-[11px] text-neutral-400">
                              {enabledCount}/10
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600">
                              {t(WORKSPACE_POLICY_LABELS[preset.workspacePolicy])}
                            </span>
                            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600">
                              {t(TRIGGER_POLICY_LABELS[preset.triggerPolicy])}
                            </span>
                            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600">
                              {t(SESSION_POLICY_LABELS[preset.sessionPolicy])}
                            </span>
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-5 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">{t('成员预设')}</h3>
                <p className="text-xs text-neutral-400">
                  {presetMode === 'create'
                    ? t('创建新成员预设')
                    : selectedPreset?.name ?? t('编辑成员预设')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {presetMode === 'edit' && selectedPreset && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDeletePresetTarget(selectedPreset)}
                  >
                    <Trash2 size={14} />
                    {t('删除')}
                  </Button>
                )}
                <Button size="sm" onClick={handlePresetSave} disabled={!canSavePreset}>
                  {createPreset.isPending || updatePreset.isPending
                    ? t('保存中...')
                    : presetMode === 'create'
                      ? t('创建')
                      : t('保存')}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="team-member-preset-name" className="block text-[13px] font-medium text-neutral-700 mb-1">{t('名称')}</label>
                <input
                  id="team-member-preset-name"
                  aria-label={t('成员预设名称')}
                  value={presetForm.name}
                  onChange={(e) => updatePresetField('name', e.target.value)}
                  className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="team-member-preset-aliases" className="block text-[13px] font-medium text-neutral-700 mb-1">{t('别名')}</label>
                <input
                  id="team-member-preset-aliases"
                  aria-label={t('成员预设别名')}
                  value={presetForm.aliasesText}
                  onChange={(e) => updatePresetField('aliasesText', e.target.value)}
                  placeholder={t('alice, a, reviewer')}
                  className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-[13px] font-medium text-neutral-700 mb-1">{t('Provider')}</label>
                <Select
                  value={presetForm.providerId}
                  onChange={(value) => updatePresetField('providerId', value)}
                  options={providerOptions}
                  disabled={providersIsError}
                />
                {providersIsError ? (
                  <p className="mt-1 text-[11px] text-red-500">
                    {t('Provider 列表加载失败，无法创建或修改成员预设。')}
                  </p>
                ) : providerOptions.length === 0 && (
                  <p className="mt-1 text-[11px] text-neutral-400">{t('暂无可用 Provider，请先在 Agent 配置中创建。')}</p>
                )}
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label className="block text-[13px] font-medium text-neutral-700">{t('头像')}</label>
                  <button
                    type="button"
                    onClick={handleClearAvatar}
                    disabled={!presetForm.avatar.trim()}
                    className="text-[11px] font-medium text-neutral-400 transition-colors hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('清除头像')}
                  </button>
                </div>
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <MemberAvatar
                      name={presetForm.name || t('Agent')}
                      avatar={presetForm.avatar}
                      className="h-14 w-14 text-sm"
                    />
                    <div className="min-w-[180px] flex-1">
                      <div className="truncate text-xs font-medium text-neutral-700">
                        {presetForm.avatar.trim() ? presetForm.avatar : t('默认首字母头像')}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => setIsAvatarPickerOpen(true)}>
                          {t('选择预设')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => avatarFileInputRef.current?.click()}
                          disabled={isUploadingAvatar}
                        >
                          <Upload size={14} />
                          {isUploadingAvatar ? t('上传中...') : t('上传头像')}
                        </Button>
                      </div>
                    </div>
                  </div>
                  <input
                    ref={avatarFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={handleAvatarUpload}
                  />
                  <p className="mt-2 text-[11px] text-neutral-400">
                    {t('支持 PNG、JPG、WebP，最大 2MB。')}
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label htmlFor="team-member-preset-role-prompt" className="block text-[13px] font-medium text-neutral-700 mb-1">{t('角色提示词')}</label>
              <textarea
                id="team-member-preset-role-prompt"
                aria-label={t('成员预设角色提示词')}
                value={presetForm.rolePrompt}
                onChange={(e) => updatePresetField('rolePrompt', e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-mono focus:border-neutral-400 focus:outline-none resize-y"
              />
            </div>

            <div>
              <div className="flex items-end justify-between gap-3 mb-2">
                <div>
                  <label className="block text-[13px] font-medium text-neutral-700">{t('可用能力')}</label>
                  <p className="text-[11px] text-neutral-400">{selectedPresetCount}/10</p>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {CAPABILITY_FIELDS.map(field => (
                  <label
                    key={field.key}
                    className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-700"
                  >
                    <input
                      type="checkbox"
                      checked={presetForm.capabilities[field.key]}
                      onChange={(e) => updatePresetCapability(field.key, e.target.checked)}
                      className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-400"
                    />
                    <span>{t(field.label)}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="block text-[13px] font-medium text-neutral-700 mb-1">{t('工作区策略')}</label>
                <Select
                  value={presetForm.workspacePolicy}
                  onChange={(value) => updatePresetField('workspacePolicy', value as WorkspacePolicy)}
                  options={WORKSPACE_POLICY_OPTIONS.map(option => ({
                    value: option.value,
                    label: t(option.label),
                  }))}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-neutral-700 mb-1">{t('触发策略')}</label>
                <Select
                  value={presetForm.triggerPolicy}
                  onChange={(value) => updatePresetField('triggerPolicy', value as TeamMemberTriggerPolicy)}
                  options={TRIGGER_POLICY_OPTIONS.map(option => ({
                    value: option.value,
                    label: t(option.label),
                  }))}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-neutral-700 mb-1">{t('会话策略')}</label>
                <Select
                  value={presetForm.sessionPolicy}
                  onChange={(value) => updatePresetField('sessionPolicy', value as TeamMemberSessionPolicy)}
                  options={SESSION_POLICY_OPTIONS.map(option => ({
                    value: option.value,
                    label: t(option.label),
                  }))}
                />
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold text-neutral-900">{t('团队模板')}</h3>
                <p className="text-[12px] text-neutral-400">{t('点击列表项可编辑。')}</p>
              </div>
              <Button size="sm" variant="outline" onClick={onCreateTemplate}>
                <Plus size={14} />
                {t('新增')}
              </Button>
            </div>

            {templatesIsError ? (
              <QueryErrorNotice
                title={t('团队模板加载失败')}
                error={templatesError}
                isFetching={templatesFetching}
                onRetry={() => void refetchTemplates()}
              />
            ) : templates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-200 p-4 text-sm text-neutral-400">
                {t('当前没有团队模板')}
              </div>
            ) : (
              <div className="space-y-2">
                {templates.map(template => {
                  const isSelected = templateMode === 'edit' && template.id === selectedTemplateId
                  const memberCount = template.members?.length ?? 0
                  const memberPresetIds = template.members?.map(member => member.memberPresetId) ?? []
                  const memberPreview = template.members
                    ?.slice(0, 3)
                    .map((member, index) => getInstanceLabel(
                      member.memberPreset?.name ?? member.memberPresetId,
                      index,
                      memberPresetIds,
                      member.memberPresetId,
                    ))
                    .join(' · ')

                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => onSelectTemplate(template)}
                      className={cn(
                        'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                        isSelected
                          ? 'border-neutral-900 bg-neutral-50'
                          : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-neutral-900">{template.name}</div>
                          <div className="mt-1 truncate text-xs text-neutral-500">
                            {t('{count} 个成员', { count: memberCount })}
                          </div>
                          {memberPreview && (
                            <div className="mt-2 truncate text-[11px] text-neutral-400">{memberPreview}</div>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-5 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">{t('团队模板')}</h3>
                <p className="text-xs text-neutral-400">
                  {templateMode === 'create'
                    ? t('创建新团队模板')
                    : selectedTemplate?.name ?? t('编辑团队模板')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {templateMode === 'edit' && selectedTemplate && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDeleteTemplateTarget(selectedTemplate)}
                  >
                    <Trash2 size={14} />
                    {t('删除')}
                  </Button>
                )}
                <Button size="sm" onClick={handleTemplateSave} disabled={!canSaveTemplate}>
                  {createTemplate.isPending || updateTemplate.isPending
                    ? t('保存中...')
                    : templateMode === 'create'
                      ? t('创建')
                      : t('保存')}
                </Button>
              </div>
            </div>

            <div>
              <label htmlFor="team-template-name" className="block text-[13px] font-medium text-neutral-700 mb-1">{t('名称')}</label>
              <input
                id="team-template-name"
                aria-label={t('团队模板名称')}
                value={templateForm.name}
                onChange={(e) => updateTemplateField('name', e.target.value)}
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="space-y-2">
                <div>
                  <label className="block text-[13px] font-medium text-neutral-700">{t('成员预设')}</label>
                  <p className="text-[11px] text-neutral-400">{t('选择顺序即保存顺序。')}</p>
                </div>
                <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                  {presetsIsError ? (
                    <QueryErrorNotice
                      title={t('成员预设加载失败')}
                      error={presetsError}
                      isFetching={presetsFetching}
                      onRetry={() => void refetchPresets()}
                    />
                  ) : presets.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-neutral-200 p-4 text-sm text-neutral-400">
                      {t('先创建成员预设，再配置团队模板。')}
                    </div>
                  ) : (
                    presets.map(preset => {
                      const selectedCount = templateForm.memberPresetIds.filter(id => id === preset.id).length
                      const providerLabel = presetProviderLabelById.get(preset.providerId) ?? preset.providerId

                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => addTemplatePreset(preset.id)}
                          className={cn(
                            'flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                            selectedCount > 0
                              ? 'border-neutral-900 bg-neutral-50'
                              : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50',
                          )}
                        >
                          <MemberAvatar
                            name={preset.name}
                            avatar={preset.avatar}
                            className="mt-0.5 h-8 w-8 text-[11px]"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-neutral-900">{preset.name}</div>
                            <div className="truncate text-xs text-neutral-500">{providerLabel}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {selectedCount > 0 && (
                              <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-white">
                                x{selectedCount}
                              </span>
                            )}
                            <Plus size={15} className="text-neutral-500" />
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <label className="block text-[13px] font-medium text-neutral-700">{t('已选成员')}</label>
                  <p className="text-[11px] text-neutral-400">{t('上移下移后即为保存顺序。')}</p>
                </div>
                <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                  {selectedTemplateRows.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-neutral-200 p-4 text-sm text-neutral-400">
                      {t('尚未选择成员预设')}
                    </div>
                  ) : (
                    selectedTemplateRows.map((preset, index) => {
                      const displayName = getInstanceLabel(
                        preset.name,
                        index,
                        templateForm.memberPresetIds,
                        preset.id,
                      )

                      return (
                        <div
                          key={`${preset.id}-${index}`}
                          className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <MemberAvatar
                              name={preset.name}
                              avatar={preset.avatar}
                              className="h-8 w-8 text-[11px]"
                            />
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-neutral-900">{displayName}</div>
                              <div className="truncate text-xs text-neutral-500">
                                {presetProviderLabelById.get(preset.providerId) ?? preset.providerId}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => moveTemplatePreset(index, -1)}
                              disabled={index === 0}
                              title={t('上移')}
                            >
                              <ChevronUp size={14} />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => moveTemplatePreset(index, 1)}
                              disabled={index === selectedTemplateRows.length - 1}
                              title={t('下移')}
                            >
                              <ChevronDown size={14} />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => removeTemplatePreset(index)}
                              title={t('移除')}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      <ConfirmDialog
        isOpen={Boolean(deletePresetTarget)}
        onClose={() => setDeletePresetTarget(null)}
        onConfirm={handleDeletePreset}
        title={t('删除')}
        description={deletePresetTarget
          ? t('确定删除 "{name}"？此操作不可撤销。', { name: deletePresetTarget.name })
          : ''}
        variant="danger"
        confirmText={t('删除')}
        cancelText={t('取消')}
        isLoading={deletePreset.isPending}
      />

      <Modal
        isOpen={isAvatarPickerOpen}
        onClose={() => setIsAvatarPickerOpen(false)}
        title={t('选择预设头像')}
        className="max-w-2xl"
      >
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {AVATAR_PRESETS.map((preset) => {
            const selected = presetForm.avatar === preset.src
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPresetAvatar(preset.src)}
                className={cn(
                  'group rounded-lg border bg-white p-2 text-center transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-900/15',
                  selected ? 'border-neutral-900 ring-2 ring-neutral-900/10' : 'border-neutral-200',
                )}
                aria-pressed={selected}
                aria-label={t('选择 {name} 头像', { name: preset.label })}
              >
                <img
                  src={preset.src}
                  alt={preset.label}
                  loading="lazy"
                  className="mx-auto h-14 w-14 rounded-full object-cover sm:h-16 sm:w-16"
                />
                <span className="mt-1 block truncate text-[10px] font-medium text-neutral-500">
                  {preset.label}
                </span>
              </button>
            )
          })}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(deleteTemplateTarget)}
        onClose={() => setDeleteTemplateTarget(null)}
        onConfirm={handleDeleteTemplate}
        title={t('删除')}
        description={deleteTemplateTarget
          ? t('确定删除 "{name}"？此操作不可撤销。', { name: deleteTemplateTarget.name })
          : ''}
        variant="danger"
        confirmText={t('删除')}
        cancelText={t('取消')}
        isLoading={deleteTemplate.isPending}
      />
    </div>
  )
}
