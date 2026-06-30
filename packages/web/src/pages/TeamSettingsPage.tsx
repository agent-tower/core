import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, ChevronUp, ChevronDown, ArrowLeft } from 'lucide-react'
import type {
  Attachment,
  MemberPreset,
  TeamMemberCapabilities,
  TeamMemberQueueManagementPolicy,
  TeamMemberSessionPolicy,
  TeamMemberTriggerPolicy,
  TeamTemplate,
  WorkspacePolicy,
} from '@agent-tower/shared'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Modal } from '@/components/ui/modal'
import { Select, type SelectOption } from '@/components/ui/select'
import { AgentLogo } from '@/components/agent'
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
import { getApiBaseUrl } from '@/lib/api-base-url'
import { cn } from '@/lib/utils'
import {
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsCardGridSkeleton,
  SettingsEmptyState,
} from '@/components/settings/SettingsSection'

const API_BASE_URL = getApiBaseUrl()
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
  queueManagementPolicy: TeamMemberQueueManagementPolicy
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
  readRoom: false, postRoomMessage: false, mentionMembers: false,
  stopMemberWork: false, markReadyForReview: false, readFiles: false,
  writeFiles: false, runCommands: false, readDiff: false, mergeWorkspace: false,
}

const WORKSPACE_POLICY_OPTIONS: Array<{ value: WorkspacePolicy; label: string }> = [
  { value: 'none', label: '无' }, { value: 'shared', label: '共享' }, { value: 'dedicated', label: '独占' },
]
const TRIGGER_POLICY_OPTIONS: Array<{ value: TeamMemberTriggerPolicy; label: string }> = [
  { value: 'MENTION_ONLY', label: '仅提及' }, { value: 'USER_MESSAGES', label: '所有用户消息' },
]
const SESSION_POLICY_OPTIONS: Array<{ value: TeamMemberSessionPolicy; label: string }> = [
  { value: 'new_per_request', label: '每次新会话' }, { value: 'resume_last', label: '复用上次会话' },
]
const QUEUE_MANAGEMENT_POLICY_OPTIONS: Array<{ value: TeamMemberQueueManagementPolicy; label: string }> = [
  { value: 'own_only', label: '仅自己队列' }, { value: 'team_pending', label: '全队列待处理' },
]
function createBlankMemberPresetForm(): MemberPresetFormState {
  return { name: '', aliasesText: '', providerId: '', rolePrompt: '', capabilities: { ...DEFAULT_CAPABILITIES }, workspacePolicy: 'none', triggerPolicy: 'MENTION_ONLY', sessionPolicy: 'new_per_request', queueManagementPolicy: 'own_only', avatar: '' }
}

function memberPresetToForm(preset: MemberPreset): MemberPresetFormState {
  return { name: preset.name, aliasesText: preset.aliases.join(', '), providerId: preset.providerId, rolePrompt: preset.rolePrompt, capabilities: { ...DEFAULT_CAPABILITIES, ...preset.capabilities }, workspacePolicy: preset.workspacePolicy, triggerPolicy: preset.triggerPolicy, sessionPolicy: preset.sessionPolicy, queueManagementPolicy: preset.queueManagementPolicy, avatar: preset.avatar ?? '' }
}

function createBlankTemplateForm(): TeamTemplateFormState { return { name: '', memberPresetIds: [] } }
function teamTemplateToForm(template: TeamTemplate): TeamTemplateFormState { return { name: template.name, memberPresetIds: template.members?.map(member => member.memberPresetId) ?? [] } }

function getInstanceLabel(name: string, index: number, ids: string[], id: string): string {
  const totalForId = ids.filter(item => item === id).length
  if (totalForId <= 1) return name
  const instanceNumber = ids.slice(0, index + 1).filter(item => item === id).length
  return `${name} #${instanceNumber}`
}

function parseAliasesText(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\n,]/).map(item => item.trim()).filter(Boolean)))
}

function normalizeAvatar(raw: string): string | null { return raw.trim() || null }

function getCapabilityCount(capabilities: TeamMemberCapabilities): number {
  return CAPABILITY_FIELDS.reduce((count, field) => count + (capabilities[field.key] ? 1 : 0), 0)
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function isSupportedAvatarFile(file: File) { return ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) }

async function uploadAvatarFile(file: File): Promise<Attachment> {
  const formData = new FormData()
  formData.append('file', file)
  const response = await fetch(`${API_BASE_URL}/attachments/upload`, { method: 'POST', body: formData })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || error.message || `Upload failed (${response.status})`)
  }
  return response.json()
}

interface QueryErrorNoticeProps { title: string; error: unknown; isFetching: boolean; onRetry: () => void }

function QueryErrorNotice({ title, error, isFetching, onRetry }: QueryErrorNoticeProps) {
  const { t } = useI18n()
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          <div className="mt-1 text-xs text-destructive/90">{getErrorMessage(error, t('请稍后重试。'))}</div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={isFetching}>
          {isFetching ? t('加载中...') : t('重试')}
        </Button>
      </div>
    </div>
  )
}

export function TeamSettingsPage() {
  const { t } = useI18n()
  const { data: providersData, error: providersError, isError: providersIsError, isFetching: providersFetching, isLoading: providersLoading, refetch: refetchProviders } = useProviders()
  const { data: presetsData, error: presetsError, isError: presetsIsError, isFetching: presetsFetching, isLoading: presetsLoading, refetch: refetchPresets } = useMemberPresets()
  const { data: templatesData, error: templatesError, isError: templatesIsError, isFetching: templatesFetching, isLoading: templatesLoading, refetch: refetchTemplates } = useTeamTemplates()

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
  const [mobileShowEditor, setMobileShowEditor] = useState(false)

  const presets = presetsData ?? EMPTY_MEMBER_PRESETS
  const templates = templatesData ?? EMPTY_TEAM_TEMPLATES
  const providerRows = providersData ?? EMPTY_PROVIDER_ROWS

  const presetById = useMemo(() => new Map(presets.map(p => [p.id, p] as const)), [presets])
  const templateById = useMemo(() => new Map(templates.map(t => [t.id, t] as const)), [templates])

  const providerOptions = useMemo(() => {
    const options: SelectOption[] = providerRows.map(({ provider, availability }) => ({
      value: provider.id,
      label: provider.name + (availability.type === 'NOT_FOUND' ? t(' (不可用)') : ''),
      icon: <AgentLogo agentType={provider.agentType} className="size-4" />,
      disabled: availability.type === 'NOT_FOUND',
    }))
    if (presetForm.providerId && !options.some(o => o.value === presetForm.providerId)) {
      options.unshift({ value: presetForm.providerId, label: `${presetForm.providerId}${t(' (不可用)')}`, disabled: true })
    }
    return options
  }, [presetForm.providerId, providerRows, t])

  const selectedPreset = selectedPresetId ? presetById.get(selectedPresetId) ?? null : null
  const selectedTemplate = selectedTemplateId ? templateById.get(selectedTemplateId) ?? null : null
  const presetProviderLabelById = useMemo(() => new Map(providerRows.map(({ provider, availability }) => [provider.id, provider.name + (availability.type === 'NOT_FOUND' ? t(' (不可用)') : '')] as const)), [providerRows, t])

  useEffect(() => {
    if (presetsLoading || presetsIsError || presetDirty) return
    if (presetMode === 'create') { setPresetForm(createBlankMemberPresetForm()); return }
    if (selectedPresetId) { const s = presetById.get(selectedPresetId); if (s) setPresetForm(memberPresetToForm(s)); return }
    if (presets.length > 0) { const f = presets[0]; setSelectedPresetId(f.id); setPresetMode('edit'); setPresetForm(memberPresetToForm(f)); return }
    setPresetMode('create'); setSelectedPresetId(null); setPresetForm(createBlankMemberPresetForm())
  }, [presetById, presetDirty, presetMode, presets, presetsIsError, presetsLoading, selectedPresetId])

  useEffect(() => {
    if (templatesLoading || templatesIsError || templateDirty) return
    if (templateMode === 'create') { setTemplateForm(createBlankTemplateForm()); return }
    if (selectedTemplateId) { const s = templateById.get(selectedTemplateId); if (s) setTemplateForm(teamTemplateToForm(s)); return }
    if (templates.length > 0) { const f = templates[0]; setSelectedTemplateId(f.id); setTemplateMode('edit'); setTemplateForm(teamTemplateToForm(f)); return }
    setTemplateMode('create'); setSelectedTemplateId(null); setTemplateForm(createBlankTemplateForm())
  }, [selectedTemplateId, templateById, templateDirty, templateMode, templates, templatesIsError, templatesLoading])

  if (providersLoading || presetsLoading || templatesLoading) {
    return (
      <SettingsPageContainer className="max-w-6xl">
        <SettingsCardGridSkeleton cards={6} />
      </SettingsPageContainer>
    )
  }

  const updatePresetField = <K extends keyof MemberPresetFormState>(field: K, value: MemberPresetFormState[K]) => { setPresetForm(prev => ({ ...prev, [field]: value })); setPresetDirty(true) }
  const updatePresetCapability = (key: keyof TeamMemberCapabilities, checked: boolean) => { setPresetForm(prev => ({ ...prev, capabilities: { ...prev.capabilities, [key]: checked } })); setPresetDirty(true) }

  const handleSelectPresetAvatar = (avatar: string) => { updatePresetField('avatar', avatar); setIsAvatarPickerOpen(false) }
  const handleClearAvatar = () => { updatePresetField('avatar', '') }

  const handleAvatarUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    if (!isSupportedAvatarFile(file)) { toast.error(t('仅支持 PNG、JPG、WebP 头像。')); return }
    if (file.size > MAX_AVATAR_UPLOAD_BYTES) { toast.error(t('头像图片不能超过 2MB。')); return }
    setIsUploadingAvatar(true)
    try { const attachment = await uploadAvatarFile(file); updatePresetField('avatar', `${API_BASE_URL}${attachment.url}`); toast.success(t('头像已上传')) }
    catch (error) { toast.error(getErrorMessage(error, t('头像上传失败'))) }
    finally { setIsUploadingAvatar(false) }
  }

  const applyPresetSelection = (mode: EditorMode, preset: MemberPreset | null) => { setPresetMode(mode); setSelectedPresetId(preset?.id ?? null); setPresetForm(preset ? memberPresetToForm(preset) : createBlankMemberPresetForm()); setPresetDirty(false) }
  const updateTemplateField = <K extends keyof TeamTemplateFormState>(field: K, value: TeamTemplateFormState[K]) => { setTemplateForm(prev => ({ ...prev, [field]: value })); setTemplateDirty(true) }
  const applyTemplateSelection = (mode: EditorMode, template: TeamTemplate | null) => { setTemplateMode(mode); setSelectedTemplateId(template?.id ?? null); setTemplateForm(template ? teamTemplateToForm(template) : createBlankTemplateForm()); setTemplateDirty(false) }

  const handlePresetSave = async () => {
    const payload = { name: presetForm.name.trim(), aliases: parseAliasesText(presetForm.aliasesText), providerId: presetForm.providerId.trim(), rolePrompt: presetForm.rolePrompt.trim(), capabilities: { ...presetForm.capabilities }, workspacePolicy: presetForm.workspacePolicy, triggerPolicy: presetForm.triggerPolicy, sessionPolicy: presetForm.sessionPolicy, queueManagementPolicy: presetForm.queueManagementPolicy, avatar: normalizeAvatar(presetForm.avatar) }
    try {
      if (presetMode === 'create' || !selectedPresetId) { const c = await createPreset.mutateAsync(payload); applyPresetSelection('edit', c); toast.success(t('已创建')) }
      else { const u = await updatePreset.mutateAsync({ id: selectedPresetId, data: payload }); applyPresetSelection('edit', u); toast.success(t('已保存')) }
    } catch (error) { toast.error(getErrorMessage(error, t('保存失败'))) }
  }

  const handleDeletePreset = async () => {
    if (!deletePresetTarget) return
    try {
      await deletePreset.mutateAsync(deletePresetTarget.id); toast.success(t('Deleted'))
      const remaining = presets.filter(p => p.id !== deletePresetTarget.id)
      if (selectedPresetId === deletePresetTarget.id) {
        if (remaining.length > 0) applyPresetSelection('edit', remaining[0])
        else applyPresetSelection('create', null)
      }
      setDeletePresetTarget(null)
    } catch (error) { toast.error(getErrorMessage(error, t('删除失败'))) }
  }

  const handleTemplateSave = async () => {
    const payload = { name: templateForm.name.trim(), memberPresetIds: templateForm.memberPresetIds }
    try {
      if (templateMode === 'create' || !selectedTemplateId) { const c = await createTemplate.mutateAsync(payload); applyTemplateSelection('edit', c); toast.success(t('已创建')) }
      else { const u = await updateTemplate.mutateAsync({ id: selectedTemplateId, data: payload }); applyTemplateSelection('edit', u); toast.success(t('已保存')) }
    } catch (error) { toast.error(getErrorMessage(error, t('保存失败'))) }
  }

  const handleDeleteTemplate = async () => {
    if (!deleteTemplateTarget) return
    try {
      await deleteTemplate.mutateAsync(deleteTemplateTarget.id); toast.success(t('Deleted'))
      const remaining = templates.filter(t => t.id !== deleteTemplateTarget.id)
      if (selectedTemplateId === deleteTemplateTarget.id) {
        if (remaining.length > 0) applyTemplateSelection('edit', remaining[0])
        else applyTemplateSelection('create', null)
      }
      setDeleteTemplateTarget(null)
    } catch (error) { toast.error(getErrorMessage(error, t('删除失败'))) }
  }

  const selectedPresetCount = getCapabilityCount(presetForm.capabilities)
  const canSavePreset = Boolean(presetForm.name.trim()) && Boolean(presetForm.providerId.trim()) && Boolean(presetForm.rolePrompt.trim()) && !providersIsError && !presetsIsError && !createPreset.isPending && !updatePreset.isPending
  const canSaveTemplate = Boolean(templateForm.name.trim()) && !templatesIsError && !presetsIsError && !createTemplate.isPending && !updateTemplate.isPending

  const selectedTemplateRows = templateForm.memberPresetIds.map(id => presetById.get(id)).filter((item): item is MemberPreset => Boolean(item))

  const onSelectPreset = (preset: MemberPreset) => { setPresetDirty(false); applyPresetSelection('edit', preset) }
  const onCreatePreset = () => { setPresetDirty(false); applyPresetSelection('create', null) }
  const onSelectTemplate = (template: TeamTemplate) => { setTemplateDirty(false); applyTemplateSelection('edit', template) }
  const onCreateTemplate = () => { setTemplateDirty(false); applyTemplateSelection('create', null) }
  const addTemplatePreset = (presetId: string) => { setTemplateForm(prev => ({ ...prev, memberPresetIds: [...prev.memberPresetIds, presetId] })); setTemplateDirty(true) }
  const removeTemplatePreset = (index: number) => { setTemplateForm(prev => ({ ...prev, memberPresetIds: prev.memberPresetIds.filter((_, i) => i !== index) })); setTemplateDirty(true) }
  const moveTemplatePreset = (index: number, direction: -1 | 1) => {
    setTemplateForm(prev => {
      const nextIndex = index + direction; if (nextIndex < 0 || nextIndex >= prev.memberPresetIds.length) return prev
      const next = [...prev.memberPresetIds]; const [item] = next.splice(index, 1); next.splice(nextIndex, 0, item)
      return { ...prev, memberPresetIds: next }
    }); setTemplateDirty(true)
  }

  const openPresetEditor = (preset: MemberPreset) => { onSelectPreset(preset); setMobileShowEditor(true) }
  const openCreatePreset = () => { onCreatePreset(); setMobileShowEditor(true) }
  const openTemplateEditor = (template: TeamTemplate) => { onSelectTemplate(template); setMobileShowEditor(true) }
  const openCreateTemplate = () => { onCreateTemplate(); setMobileShowEditor(true) }
  const backToList = () => setMobileShowEditor(false)

  return (
    <SettingsPageContainer className="max-w-6xl">
      <SettingsPageHeader
        title={t('团队协作设置')}
        actions={
          <div className="inline-flex rounded-lg border border-border bg-muted/80 p-0.5">
            <button
              type="button"
              onClick={() => {
                setActiveTab('presets')
                backToList()
              }}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] font-medium transition-all',
                activeTab === 'presets'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('成员预设')}
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('templates')
                backToList()
              }}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] font-medium transition-all',
                activeTab === 'templates'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('团队模板')}
            </button>
          </div>
        }
      />

      {providersIsError && (
        <QueryErrorNotice title={t('Provider 列表加载失败')} error={providersError} isFetching={providersFetching} onRetry={() => void refetchProviders()} />
      )}

      {activeTab === 'presets' ? (
        mobileShowEditor ? (
          /* ── Preset editor (full view) ── */
          <div className="rounded-xl border border-border bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
              <div className="flex items-center gap-3">
                <button onClick={backToList} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <ArrowLeft size={14} />
                  {t('返回')}
                </button>
                <span className="text-neutral-200">|</span>
                <h3 className="text-[13px] font-semibold text-foreground">
                  {presetMode === 'create' ? t('创建新预设') : selectedPreset?.name ?? t('编辑预设')}
                </h3>
              </div>
              <div className="flex items-center gap-2">
                {presetMode === 'edit' && selectedPreset && (
                  <button onClick={() => setDeletePresetTarget(selectedPreset)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title={t('删除')}>
                    <Trash2 size={14} />
                  </button>
                )}
                <Button size="sm" onClick={handlePresetSave} disabled={!canSavePreset}>
                  {createPreset.isPending || updatePreset.isPending ? t('保存中...') : presetMode === 'create' ? t('创建') : t('保存')}
                </Button>
              </div>
            </div>

            <div className="p-5 space-y-5">
              {/* Identity */}
              <div className="flex items-start gap-4">
                <div className="shrink-0">
                  <MemberAvatar name={presetForm.name || t('Agent')} avatar={presetForm.avatar} className="h-14 w-14 text-sm" />
                  <div className="flex justify-center gap-1 mt-2">
                    <button type="button" onClick={() => setIsAvatarPickerOpen(true)} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">{t('选择')}</button>
                    <span className="text-[10px] text-muted-foreground/60">·</span>
                    <button type="button" onClick={() => avatarFileInputRef.current?.click()} disabled={isUploadingAvatar} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                      {isUploadingAvatar ? t('...') : t('上传')}
                    </button>
                    {presetForm.avatar.trim() && (
                      <>
                        <span className="text-[10px] text-muted-foreground/60">·</span>
                        <button type="button" onClick={handleClearAvatar} className="text-[10px] text-muted-foreground hover:text-destructive transition-colors">{t('清除')}</button>
                      </>
                    )}
                  </div>
                  <input ref={avatarFileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleAvatarUpload} />
                </div>
                <div className="flex-1 min-w-0 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('名称')}</label>
                    <input value={presetForm.name} onChange={e => updatePresetField('name', e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors focus:border-ring focus:outline-none" />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('别名')}</label>
                    <input value={presetForm.aliasesText} onChange={e => updatePresetField('aliasesText', e.target.value)} placeholder={t('alice, a, reviewer')} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors focus:border-ring focus:outline-none" />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('Provider')}</label>
                <Select value={presetForm.providerId} onChange={v => updatePresetField('providerId', v)} options={providerOptions} disabled={providersIsError} />
                {providersIsError && <p className="mt-1 text-[11px] text-destructive">{t('Provider 列表加载失败。')}</p>}
              </div>

              <div>
                <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('角色提示词')}</label>
                <textarea value={presetForm.rolePrompt} onChange={e => updatePresetField('rolePrompt', e.target.value)} rows={4} className="w-full rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm font-mono transition-colors focus:border-ring focus:bg-background focus:outline-none resize-y" />
              </div>

              <div>
                <div className="flex items-end justify-between gap-3 mb-2">
                  <label className="text-[12px] font-medium text-muted-foreground">{t('可用能力')}</label>
                  <span className="text-[11px] text-muted-foreground">{selectedPresetCount}/10</span>
                </div>
                <div className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
                  {CAPABILITY_FIELDS.map(field => (
                    <label key={field.key} className="flex items-center gap-2 rounded px-2.5 py-1.5 text-[12px] text-foreground hover:bg-muted transition-colors cursor-pointer">
                      <input type="checkbox" checked={presetForm.capabilities[field.key]} onChange={e => updatePresetCapability(field.key, e.target.checked)} className="h-3.5 w-3.5 rounded border-border" />
                      <span>{t(field.label)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('工作区')}</label>
                  <Select value={presetForm.workspacePolicy} onChange={v => updatePresetField('workspacePolicy', v as WorkspacePolicy)} options={WORKSPACE_POLICY_OPTIONS.map(o => ({ value: o.value, label: t(o.label) }))} />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('触发')}</label>
                  <Select value={presetForm.triggerPolicy} onChange={v => updatePresetField('triggerPolicy', v as TeamMemberTriggerPolicy)} options={TRIGGER_POLICY_OPTIONS.map(o => ({ value: o.value, label: t(o.label) }))} />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('会话')}</label>
                  <Select value={presetForm.sessionPolicy} onChange={v => updatePresetField('sessionPolicy', v as TeamMemberSessionPolicy)} options={SESSION_POLICY_OPTIONS.map(o => ({ value: o.value, label: t(o.label) }))} />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('队列')}</label>
                  <Select value={presetForm.queueManagementPolicy} onChange={v => updatePresetField('queueManagementPolicy', v as TeamMemberQueueManagementPolicy)} options={QUEUE_MANAGEMENT_POLICY_OPTIONS.map(o => ({ value: o.value, label: t(o.label) }))} />
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Preset grid card wall ── */
          <div>
            <div className="flex items-center justify-between gap-3 mb-4">
              <span className="text-[12px] text-muted-foreground">{t('{count} 个成员预设', { count: presets.length })}</span>
              <Button size="sm" variant="outline" onClick={openCreatePreset}>
                <Plus size={13} /> {t('新增预设')}
              </Button>
            </div>

            {presetsIsError ? (
              <QueryErrorNotice title={t('加载失败')} error={presetsError} isFetching={presetsFetching} onRetry={() => void refetchPresets()} />
            ) : presets.length === 0 ? (
              <SettingsEmptyState
                message={t('暂无成员预设')}
                action={
                  <Button size="sm" onClick={openCreatePreset}>
                    <Plus size={13} className="mr-1" /> {t('新增预设')}
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {presets.map(preset => {
                  const capCount = getCapabilityCount(preset.capabilities as TeamMemberCapabilities)
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => openPresetEditor(preset)}
                      className="flex items-start gap-3 rounded-xl border border-border bg-background p-4 text-left transition-all hover:border-border hover:shadow-sm"
                    >
                      <MemberAvatar name={preset.name} avatar={preset.avatar} className="h-10 w-10 text-xs shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-foreground">{preset.name}</div>
                        {preset.aliases.length > 0 && (
                          <div className="truncate text-[11px] text-muted-foreground mt-0.5">{preset.aliases.join(', ')}</div>
                        )}
                        <div className="truncate text-[11px] text-muted-foreground mt-1">
                          {presetProviderLabelById.get(preset.providerId) ?? preset.providerId}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t(WORKSPACE_POLICY_OPTIONS.find(o => o.value === preset.workspacePolicy)?.label ?? preset.workspacePolicy)}
                          </span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {capCount}/10 {t('能力')}
                          </span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      ) : (
        mobileShowEditor ? (
          /* ── Template editor (full view) ── */
          <div className="rounded-xl border border-border bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
              <div className="flex items-center gap-3">
                <button onClick={backToList} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <ArrowLeft size={14} />
                  {t('返回')}
                </button>
                <span className="text-neutral-200">|</span>
                <h3 className="text-[13px] font-semibold text-foreground">
                  {templateMode === 'create' ? t('创建新模板') : selectedTemplate?.name ?? t('编辑模板')}
                </h3>
              </div>
              <div className="flex items-center gap-2">
                {templateMode === 'edit' && selectedTemplate && (
                  <button onClick={() => setDeleteTemplateTarget(selectedTemplate)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors" title={t('删除')}>
                    <Trash2 size={14} />
                  </button>
                )}
                <Button size="sm" onClick={handleTemplateSave} disabled={!canSaveTemplate}>
                  {createTemplate.isPending || updateTemplate.isPending ? t('保存中...') : templateMode === 'create' ? t('创建') : t('保存')}
                </Button>
              </div>
            </div>

            <div className="p-5 space-y-5">
              <div>
                <label className="block text-[12px] font-medium text-muted-foreground mb-1">{t('模板名称')}</label>
                <input value={templateForm.name} onChange={e => updateTemplateField('name', e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors focus:border-ring focus:outline-none" />
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div>
                  <label className="block text-[12px] font-medium text-muted-foreground mb-2">{t('可用预设')}</label>
                  <div className="max-h-[400px] space-y-1 overflow-y-auto scrollbar-app-thin">
                    {presetsIsError ? (
                      <QueryErrorNotice title={t('加载失败')} error={presetsError} isFetching={presetsFetching} onRetry={() => void refetchPresets()} />
                    ) : presets.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border p-3 text-center text-[12px] text-muted-foreground">{t('先创建成员预设')}</div>
                    ) : (
                      presets.map(preset => {
                        const count = templateForm.memberPresetIds.filter(id => id === preset.id).length
                        return (
                          <button key={preset.id} type="button" onClick={() => addTemplatePreset(preset.id)} className={cn('flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-all', count > 0 ? 'border-neutral-900 bg-muted' : 'border-border bg-background hover:border-border')}>
                            <MemberAvatar name={preset.name} avatar={preset.avatar} className="h-7 w-7 text-[10px] shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[12px] font-medium text-foreground">{preset.name}</div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {count > 0 && <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white">x{count}</span>}
                              <Plus size={13} className="text-muted-foreground" />
                            </div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-muted-foreground mb-2">{t('已选成员')}</label>
                  <div className="max-h-[400px] space-y-1 overflow-y-auto scrollbar-app-thin">
                    {selectedTemplateRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border p-3 text-center text-[12px] text-muted-foreground">{t('尚未选择')}</div>
                    ) : (
                      selectedTemplateRows.map((preset, index) => (
                        <div key={`${preset.id}-${index}`} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <MemberAvatar name={preset.name} avatar={preset.avatar} className="h-7 w-7 text-[10px] shrink-0" />
                            <span className="truncate text-[12px] font-medium text-foreground">
                              {getInstanceLabel(preset.name, index, templateForm.memberPresetIds, preset.id)}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button type="button" variant="ghost" size="icon-sm" onClick={() => moveTemplatePreset(index, -1)} disabled={index === 0}><ChevronUp size={13} /></Button>
                            <Button type="button" variant="ghost" size="icon-sm" onClick={() => moveTemplatePreset(index, 1)} disabled={index === selectedTemplateRows.length - 1}><ChevronDown size={13} /></Button>
                            <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeTemplatePreset(index)}><Trash2 size={13} /></Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Template grid ── */
          <div>
            <div className="flex items-center justify-between gap-3 mb-4">
              <span className="text-[12px] text-muted-foreground">{t('{count} 个团队模板', { count: templates.length })}</span>
              <Button size="sm" variant="outline" onClick={openCreateTemplate}>
                <Plus size={13} /> {t('新增模板')}
              </Button>
            </div>

            {templatesIsError ? (
              <QueryErrorNotice title={t('加载失败')} error={templatesError} isFetching={templatesFetching} onRetry={() => void refetchTemplates()} />
            ) : templates.length === 0 ? (
              <SettingsEmptyState
                message={t('暂无团队模板')}
                action={
                  <Button size="sm" onClick={openCreateTemplate}>
                    <Plus size={13} className="mr-1" /> {t('新增模板')}
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map(template => {
                  const memberCount = template.members?.length ?? 0
                  const memberNames = (template.members ?? []).slice(0, 3).map(m => presetById.get(m.memberPresetId)?.name).filter(Boolean)
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => openTemplateEditor(template)}
                      className="flex flex-col rounded-xl border border-border bg-background p-4 text-left transition-all hover:border-border hover:shadow-sm"
                    >
                      <div className="truncate text-[13px] font-semibold text-foreground">{template.name}</div>
                      <div className="text-[11px] text-muted-foreground mt-1">{t('{count} 个成员', { count: memberCount })}</div>
                      {memberNames.length > 0 && (
                        <div className="truncate text-[11px] text-muted-foreground mt-1.5">
                          {memberNames.join(', ')}{memberCount > 3 ? ` +${memberCount - 3}` : ''}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      )}

      <ConfirmDialog isOpen={Boolean(deletePresetTarget)} onClose={() => setDeletePresetTarget(null)} onConfirm={handleDeletePreset} title={t('删除')} description={deletePresetTarget ? t('确定删除 "{name}"？此操作不可撤销。', { name: deletePresetTarget.name }) : ''} variant="danger" confirmText={t('删除')} cancelText={t('取消')} isLoading={deletePreset.isPending} />

      <Modal isOpen={isAvatarPickerOpen} onClose={() => setIsAvatarPickerOpen(false)} title={t('选择预设头像')} className="max-w-2xl">
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {AVATAR_PRESETS.map(preset => {
            const selected = presetForm.avatar === preset.src
            return (
              <button key={preset.id} type="button" onClick={() => handleSelectPresetAvatar(preset.src)} className={cn('group rounded-xl border bg-background p-2 text-center transition-all hover:border-neutral-400 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-neutral-900/15', selected ? 'border-neutral-900 ring-2 ring-neutral-900/10' : 'border-border')} aria-pressed={selected} aria-label={t('选择 {name} 头像', { name: preset.label })}>
                <img src={preset.src} alt={preset.label} loading="lazy" className="mx-auto h-14 w-14 rounded-full object-cover sm:h-16 sm:w-16" />
                <span className="mt-1 block truncate text-[10px] font-medium text-muted-foreground">{preset.label}</span>
              </button>
            )
          })}
        </div>
      </Modal>

      <ConfirmDialog isOpen={Boolean(deleteTemplateTarget)} onClose={() => setDeleteTemplateTarget(null)} onConfirm={handleDeleteTemplate} title={t('删除')} description={deleteTemplateTarget ? t('确定删除 "{name}"？此操作不可撤销。', { name: deleteTemplateTarget.name }) : ''} variant="danger" confirmText={t('删除')} cancelText={t('取消')} isLoading={deleteTemplate.isPending} />
    </SettingsPageContainer>
  )
}
