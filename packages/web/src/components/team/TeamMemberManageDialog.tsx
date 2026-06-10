import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Check,
  CopyPlus,
  Edit3,
  Plus,
  Settings2,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react'
import type {
  MemberPreset,
  TeamMember,
  TeamMemberCapabilities,
  TeamMemberQueueManagementPolicy,
  TeamMemberSessionPolicy,
  TeamMemberTriggerPolicy,
  TeamRun,
  WorkspacePolicy,
} from '@agent-tower/shared'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Modal } from '@/components/ui/modal'
import { Select } from '@/components/ui/select'
import {
  useAddTeamRunMember,
  useMemberPresets,
  usePatchTeamRunMember,
  useRemoveTeamRunMember,
  type TeamRunMemberSnapshotInput,
} from '@/hooks/use-team-run'
import { useProviders } from '@/hooks/use-providers'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { MemberAvatar } from './MemberAvatar'

interface TeamMemberManageDialogProps {
  isOpen: boolean
  onClose: () => void
  teamRun: TeamRun
}

type PanelMode = 'edit' | 'add-preset' | 'add-custom'

interface MemberFormState {
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

const WORKSPACE_POLICY_OPTIONS: Array<{ value: WorkspacePolicy; label: string }> = [
  { value: 'none', label: '无' },
  { value: 'shared', label: '共享' },
  { value: 'dedicated', label: '独占' },
]

const TRIGGER_POLICY_OPTIONS: Array<{ value: TeamMemberTriggerPolicy; label: string }> = [
  { value: 'MENTION_ONLY', label: '仅提及' },
  { value: 'USER_MESSAGES', label: '所有用户消息' },
]

const SESSION_POLICY_OPTIONS: Array<{ value: TeamMemberSessionPolicy; label: string }> = [
  { value: 'new_per_request', label: '每次新会话' },
  { value: 'resume_last', label: '复用上次会话' },
]

const QUEUE_MANAGEMENT_POLICY_OPTIONS: Array<{ value: TeamMemberQueueManagementPolicy; label: string }> = [
  { value: 'own_only', label: '仅自己队列' },
  { value: 'team_pending', label: '全队列待处理' },
]

function blankForm(): MemberFormState {
  return {
    name: '',
    aliasesText: '',
    providerId: '',
    rolePrompt: '',
    capabilities: { ...DEFAULT_CAPABILITIES },
    workspacePolicy: 'none',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'new_per_request',
    queueManagementPolicy: 'own_only',
    avatar: '',
  }
}

function memberToForm(member: TeamMember): MemberFormState {
  return {
    name: member.name,
    aliasesText: (member.aliases ?? []).join(', '),
    providerId: member.providerId,
    rolePrompt: member.rolePrompt,
    capabilities: { ...DEFAULT_CAPABILITIES, ...member.capabilities },
    workspacePolicy: member.workspacePolicy,
    triggerPolicy: member.triggerPolicy,
    sessionPolicy: member.sessionPolicy,
    queueManagementPolicy: member.queueManagementPolicy,
    avatar: member.avatar ?? '',
  }
}

function presetToForm(preset: MemberPreset): MemberFormState {
  return {
    name: preset.name,
    aliasesText: (preset.aliases ?? []).join(', '),
    providerId: preset.providerId,
    rolePrompt: preset.rolePrompt,
    capabilities: { ...DEFAULT_CAPABILITIES, ...preset.capabilities },
    workspacePolicy: preset.workspacePolicy,
    triggerPolicy: preset.triggerPolicy,
    sessionPolicy: preset.sessionPolicy,
    queueManagementPolicy: preset.queueManagementPolicy,
    avatar: preset.avatar ?? '',
  }
}

function parseAliases(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)))
}

function formToPayload(form: MemberFormState): TeamRunMemberSnapshotInput {
  return {
    name: form.name.trim(),
    aliases: parseAliases(form.aliasesText),
    providerId: form.providerId.trim(),
    rolePrompt: form.rolePrompt.trim(),
    capabilities: { ...form.capabilities },
    workspacePolicy: form.workspacePolicy,
    triggerPolicy: form.triggerPolicy,
    sessionPolicy: form.sessionPolicy,
    queueManagementPolicy: form.queueManagementPolicy,
    avatar: form.avatar.trim() || null,
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function isActiveMember(member: TeamMember) {
  return member.membershipStatus !== 'REMOVED'
}

function isMemberWorking(member: TeamMember) {
  return member.status === 'RUNNING'
    || member.status === 'WAITING_ROOM_REPLY'
    || member.status === 'SESSION_ENDED'
    || member.status === 'QUEUED'
}

function getStatusTone(member: TeamMember) {
  if (isMemberWorking(member)) return 'bg-emerald-500'
  if (member.status === 'FAILED') return 'bg-red-500'
  return 'bg-neutral-300'
}

function workspacePolicyLabel(value: WorkspacePolicy) {
  return WORKSPACE_POLICY_OPTIONS.find((option) => option.value === value)?.label ?? value
}

function sessionPolicyLabel(value: TeamMemberSessionPolicy) {
  return SESSION_POLICY_OPTIONS.find((option) => option.value === value)?.label ?? value
}

interface FieldLabelProps {
  children: React.ReactNode
}

function FieldLabel({ children }: FieldLabelProps) {
  return <span className="text-xs font-medium text-neutral-600">{children}</span>
}

interface EmptyStateProps {
  icon: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}

function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex min-h-[18rem] flex-col items-center justify-center rounded-lg border border-dashed border-neutral-200 bg-white px-6 py-8 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 text-neutral-500">
        {icon}
      </div>
      <div className="text-sm font-medium text-neutral-900">{title}</div>
      {description ? <div className="mt-1 max-w-sm text-xs leading-relaxed text-neutral-500">{description}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function TeamMemberManageDialog({ isOpen, onClose, teamRun }: TeamMemberManageDialogProps) {
  const { t } = useI18n()
  const { data: presets = [] } = useMemberPresets()
  const { data: providers = [] } = useProviders()
  const addMember = useAddTeamRunMember(teamRun.id)
  const patchMember = usePatchTeamRunMember(teamRun.id)
  const removeMember = useRemoveTeamRunMember(teamRun.id)
  const initializedOpenStateRef = useRef(false)
  const [panelMode, setPanelMode] = useState<PanelMode>('edit')
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [form, setForm] = useState<MemberFormState>(blankForm())
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null)
  const [selectedMemberFallback, setSelectedMemberFallback] = useState<TeamMember | null>(null)

  const members = teamRun.members ?? []
  const teamRunActiveMembers = useMemo(() => members.filter(isActiveMember), [members])
  const activeMembers = useMemo(() => {
    if (
      selectedMemberFallback
      && isActiveMember(selectedMemberFallback)
      && !teamRunActiveMembers.some((member) => member.id === selectedMemberFallback.id)
    ) {
      return [...teamRunActiveMembers, selectedMemberFallback]
    }
    return teamRunActiveMembers
  }, [selectedMemberFallback, teamRunActiveMembers])
  const selectedMemberFromTeamRun = selectedMemberId
    ? teamRunActiveMembers.find((member) => member.id === selectedMemberId) ?? null
    : null
  const selectedMember = selectedMemberFallback?.id === selectedMemberId
    ? selectedMemberFallback
    : selectedMemberFromTeamRun
  const selectedPreset = selectedPresetId
    ? presets.find((preset) => preset.id === selectedPresetId) ?? null
    : null
  const isBusy = addMember.isPending || patchMember.isPending || removeMember.isPending
  const workingCount = activeMembers.filter(isMemberWorking).length

  const providerOptions = useMemo(() => {
    const options = providers.map(({ provider, availability }) => ({
      value: provider.id,
      label: provider.name + (availability.type === 'NOT_FOUND' ? t(' (不可用)') : ''),
      disabled: availability.type === 'NOT_FOUND',
    }))
    if (form.providerId && !options.some((option) => option.value === form.providerId)) {
      options.unshift({ value: form.providerId, label: `${form.providerId}${t(' (不可用)')}`, disabled: true })
    }
    return options
  }, [form.providerId, providers, t])

  useEffect(() => {
    if (!isOpen) {
      initializedOpenStateRef.current = false
      setSelectedMemberFallback(null)
      return
    }
    if (initializedOpenStateRef.current) return
    initializedOpenStateRef.current = true
    const firstMember = activeMembers[0] ?? null
    setPanelMode(firstMember ? 'edit' : 'add-preset')
    setSelectedMemberId(firstMember?.id ?? null)
    setSelectedPresetId('')
    setForm(firstMember ? memberToForm(firstMember) : blankForm())
    setRemoveTarget(null)
  }, [activeMembers, isOpen])

  useEffect(() => {
    if (!selectedMemberFallback) return
    if (teamRunActiveMembers.some((member) => member.id === selectedMemberFallback.id)) {
      setSelectedMemberFallback(null)
    }
  }, [selectedMemberFallback, teamRunActiveMembers])

  useEffect(() => {
    if (panelMode !== 'add-preset') return
    if (!selectedPreset) return
    setForm(presetToForm(selectedPreset))
  }, [panelMode, selectedPreset])

  const updateForm = <K extends keyof MemberFormState>(key: K, value: MemberFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const updateCapability = (key: keyof TeamMemberCapabilities, value: boolean) => {
    setForm((current) => ({
      ...current,
      capabilities: {
        ...current.capabilities,
        [key]: value,
      },
    }))
  }

  const switchToEdit = (member: TeamMember) => {
    setPanelMode('edit')
    setSelectedMemberId(member.id)
    setSelectedPresetId('')
    setForm(memberToForm(member))
  }

  const switchToPresetAdd = () => {
    setPanelMode('add-preset')
    setSelectedMemberId(null)
    const nextPreset = selectedPreset ?? presets[0] ?? null
    setSelectedPresetId(nextPreset?.id ?? '')
    setForm(nextPreset ? presetToForm(nextPreset) : blankForm())
  }

  const switchToCustomAdd = () => {
    setPanelMode('add-custom')
    setSelectedMemberId(null)
    setSelectedPresetId('')
    setForm(blankForm())
  }

  const hasRequiredFormFields = Boolean(form.name.trim() && form.providerId.trim() && form.rolePrompt.trim())
  const canSave = panelMode === 'add-preset'
    ? Boolean(selectedPresetId)
    : panelMode === 'edit'
      ? Boolean(selectedMember && hasRequiredFormFields)
      : hasRequiredFormFields

  const handleSave = async () => {
    try {
      if (panelMode === 'add-preset') {
        if (!selectedPresetId) return
        const member = await addMember.mutateAsync({ memberPresetId: selectedPresetId })
        toast.success(t('Member added'))
        setSelectedMemberFallback(member)
        setPanelMode('edit')
        setSelectedMemberId(member.id)
        setSelectedPresetId('')
        setForm(memberToForm(member))
        return
      }

      const payload = formToPayload(form)
      if (!payload.name || !payload.providerId || !payload.rolePrompt) {
        toast.error(t('Name, provider, and role prompt are required'))
        return
      }

      if (panelMode === 'add-custom') {
        const member = await addMember.mutateAsync({ member: payload })
        toast.success(t('Member added'))
        setSelectedMemberFallback(member)
        setPanelMode('edit')
        setSelectedMemberId(member.id)
        setForm(memberToForm(member))
        return
      }

      if (selectedMember) {
        const member = await patchMember.mutateAsync({ memberId: selectedMember.id, data: payload })
        toast.success(t('Member updated'))
        setSelectedMemberFallback((current) => (current?.id === member.id ? member : current))
        setSelectedMemberId(member.id)
        setForm(memberToForm(member))
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('Failed to save member')))
    }
  }

  const handleRemove = async () => {
    if (!removeTarget) return
    try {
      await removeMember.mutateAsync({
        memberId: removeTarget.id,
        stopActive: true,
        cancelQueued: true,
      })
      if (selectedMemberId === removeTarget.id) {
        const nextMember = activeMembers.find((member) => member.id !== removeTarget.id) ?? null
        setSelectedMemberId(nextMember?.id ?? null)
        setPanelMode(nextMember ? 'edit' : 'add-preset')
        setForm(nextMember ? memberToForm(nextMember) : blankForm())
      }
      setSelectedMemberFallback((current) => (current?.id === removeTarget.id ? null : current))
      setRemoveTarget(null)
      toast.success(t('Member removed'))
    } catch (error) {
      toast.error(getErrorMessage(error, t('Failed to remove member')))
    }
  }

  const renderPresetPanel = () => (
    <div className="flex min-h-0 flex-col lg:flex-1">
      <div className="border-b border-neutral-100 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
              <UserPlus size={15} className="text-neutral-500" />
              <span>{t('Add member from preset')}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              {t('Choose a saved preset to add a ready-to-run member snapshot.')}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={switchToCustomAdd} disabled={isBusy}>
            <CopyPlus size={13} />
            {t('Custom member')}
          </Button>
        </div>
      </div>

      <div className="p-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {presets.length === 0 ? (
          <EmptyState
            icon={<UserPlus size={18} />}
            title={t('No member presets')}
            description={t('Create a custom member for this TeamRun, or add presets from Team Collaboration Settings.')}
            action={(
              <Button type="button" variant="outline" size="sm" onClick={switchToCustomAdd} disabled={isBusy}>
                <Plus size={13} />
                {t('Custom member')}
              </Button>
            )}
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {presets.map((preset: MemberPreset) => {
              const selected = selectedPresetId === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    setSelectedPresetId(preset.id)
                    setForm(presetToForm(preset))
                  }}
                  className={cn(
                    'flex min-h-[4.25rem] items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                    selected
                      ? 'border-neutral-900 bg-neutral-50 shadow-sm'
                      : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50',
                  )}
                >
                  <MemberAvatar name={preset.name} avatar={preset.avatar} className="h-8 w-8 text-[11px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-neutral-900">{preset.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-neutral-500">{preset.providerId}</span>
                    <span className="mt-1 block truncate text-[10px] text-neutral-400">
                      {t(workspacePolicyLabel(preset.workspacePolicy))} · {t(sessionPolicyLabel(preset.sessionPolicy))}
                    </span>
                  </span>
                  {selected ? <Check size={16} className="shrink-0 text-neutral-900" /> : null}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )

  const renderFormPanel = () => {
    const isEditMode = panelMode === 'edit'
    if (isEditMode && !selectedMember) {
      return (
        <div className="p-5">
          <EmptyState
            icon={<Users size={18} />}
            title={t('Select a member')}
            description={t('Choose a member on the left to edit its future TeamRun configuration.')}
            action={(
              <Button type="button" variant="outline" size="sm" onClick={switchToPresetAdd} disabled={isBusy}>
                <Plus size={13} />
                {t('Add member')}
              </Button>
            )}
          />
        </div>
      )
    }

    return (
      <div className="flex min-h-0 flex-col lg:flex-1">
        <div className="border-b border-neutral-100 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
                {isEditMode ? <Settings2 size={15} className="text-neutral-500" /> : <Plus size={15} className="text-neutral-500" />}
                <span>{isEditMode ? t('Edit member') : t('Custom member')}</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                {isEditMode
                  ? t('Provider, role, workspace, and session changes apply to future work only.')
                  : t('Create a one-off member snapshot for this TeamRun.')}
              </p>
            </div>
            {isEditMode && selectedMember ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRemoveTarget(selectedMember)}
                disabled={isBusy}
                className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
              >
                <Trash2 size={13} />
                {t('Remove')}
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={switchToPresetAdd} disabled={isBusy}>
                <UserPlus size={13} />
                {t('Use preset')}
              </Button>
            )}
          </div>
        </div>

        <div className="p-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {isEditMode && selectedMember ? (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5">
              <MemberAvatar name={selectedMember.name} avatar={selectedMember.avatar} className="h-9 w-9 text-xs" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', getStatusTone(selectedMember))} />
                  <span className="truncate text-sm font-medium text-neutral-900">{selectedMember.name}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-neutral-500">
                  {selectedMember.providerId} · {t(workspacePolicyLabel(selectedMember.workspacePolicy))}
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="space-y-1.5">
                <FieldLabel>{t('Name')}</FieldLabel>
                <input
                  value={form.name}
                  onChange={(event) => updateForm('name', event.target.value)}
                  className="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm outline-none transition-colors focus:border-neutral-400"
                />
              </label>
              <label className="space-y-1.5">
                <FieldLabel>{t('Aliases')}</FieldLabel>
                <input
                  value={form.aliasesText}
                  onChange={(event) => updateForm('aliasesText', event.target.value)}
                  placeholder={t('Comma separated')}
                  className="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm outline-none transition-colors focus:border-neutral-400"
                />
              </label>
              <label className="space-y-1.5">
                <FieldLabel>{t('Provider')}</FieldLabel>
                <Select value={form.providerId} onChange={(value) => updateForm('providerId', value)} options={providerOptions} />
              </label>
              <label className="space-y-1.5">
                <FieldLabel>{t('Avatar')}</FieldLabel>
                <input
                  value={form.avatar}
                  onChange={(event) => updateForm('avatar', event.target.value)}
                  className="h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm outline-none transition-colors focus:border-neutral-400"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="space-y-1.5">
                <FieldLabel>{t('Workspace policy')}</FieldLabel>
                <Select
                  value={form.workspacePolicy}
                  onChange={(value) => updateForm('workspacePolicy', value as WorkspacePolicy)}
                  options={WORKSPACE_POLICY_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
                />
              </label>
              <label className="space-y-1.5">
                <FieldLabel>{t('Trigger policy')}</FieldLabel>
                <Select
                  value={form.triggerPolicy}
                  onChange={(value) => updateForm('triggerPolicy', value as TeamMemberTriggerPolicy)}
                  options={TRIGGER_POLICY_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
                />
              </label>
              <label className="space-y-1.5">
                <FieldLabel>{t('Session policy')}</FieldLabel>
                <Select
                  value={form.sessionPolicy}
                  onChange={(value) => updateForm('sessionPolicy', value as TeamMemberSessionPolicy)}
                  options={SESSION_POLICY_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
                />
              </label>
              <label className="space-y-1.5">
                <FieldLabel>{t('Queue policy')}</FieldLabel>
                <Select
                  value={form.queueManagementPolicy}
                  onChange={(value) => updateForm('queueManagementPolicy', value as TeamMemberQueueManagementPolicy)}
                  options={QUEUE_MANAGEMENT_POLICY_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
                />
              </label>
            </div>

            <label className="space-y-1.5">
              <FieldLabel>{t('Role prompt')}</FieldLabel>
              <textarea
                value={form.rolePrompt}
                onChange={(event) => updateForm('rolePrompt', event.target.value)}
                rows={7}
                className="w-full resize-y rounded-lg border border-neutral-200 px-3 py-2 text-sm leading-relaxed outline-none transition-colors focus:border-neutral-400"
              />
            </label>

            <div className="space-y-2">
              <FieldLabel>{t('Capabilities')}</FieldLabel>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {CAPABILITY_FIELDS.map((field) => (
                  <label
                    key={field.key}
                    className="flex min-h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-xs text-neutral-700"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(form.capabilities[field.key])}
                      onChange={(event) => updateCapability(field.key, event.target.checked)}
                    />
                    <span className="min-w-0 truncate">{t(field.label)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={isBusy ? () => {} : onClose}
        title={t('Manage Team Members')}
        className="max-w-6xl"
        action={
          <>
            <Button type="button" variant="outline" onClick={onClose} disabled={isBusy}>
              {t('Close')}
            </Button>
            <Button type="button" onClick={handleSave} disabled={isBusy || !canSave}>
              {isBusy
                ? t('Processing...')
                : panelMode === 'edit'
                  ? t('Save member')
                  : t('Add member')}
            </Button>
          </>
        }
      >
        <div className="grid min-h-0 grid-cols-1 overflow-visible rounded-lg border border-neutral-200 bg-white lg:h-[min(42rem,calc(100vh-13rem))] lg:min-h-[34rem] lg:grid-cols-[20rem_minmax(0,1fr)] lg:overflow-hidden">
          <aside className="flex min-h-0 flex-col border-b border-neutral-200 bg-neutral-50/70 lg:border-b-0 lg:border-r">
            <div className="border-b border-neutral-200 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
                    <Users size={15} className="text-neutral-500" />
                    <span>{t('Members')}</span>
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    {activeMembers.length} {t('active')} · {workingCount} {t('working')}
                  </div>
                </div>
                <Button type="button" size="icon-sm" variant="outline" onClick={switchToPresetAdd} disabled={isBusy} title={t('Add member')}>
                  <Plus size={14} />
                </Button>
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto p-2 lg:min-h-0 lg:max-h-none lg:flex-1">
              {activeMembers.length === 0 ? (
                <div className="rounded-lg border border-dashed border-neutral-200 bg-white px-3 py-5 text-center text-xs text-neutral-400">
                  {t('No active members')}
                </div>
              ) : (
                <div className="space-y-1">
                  {activeMembers.map((member) => {
                    const selected = panelMode === 'edit' && selectedMemberId === member.id
                    return (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => switchToEdit(member)}
                        className={cn(
                          'group flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                          selected
                            ? 'border-neutral-300 bg-white shadow-sm'
                            : 'border-transparent hover:border-neutral-200 hover:bg-white',
                        )}
                      >
                        <MemberAvatar name={member.name} avatar={member.avatar} className="h-8 w-8 text-[11px]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', getStatusTone(member))} />
                            <span className="truncate text-sm font-medium text-neutral-900">{member.name}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-neutral-500">{member.providerId}</span>
                        </span>
                        <Edit3
                          size={13}
                          className={cn(
                            'shrink-0 text-neutral-300 transition-opacity',
                            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                          )}
                        />
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-neutral-200 p-2">
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={switchToPresetAdd}
                  disabled={isBusy}
                  className={cn(
                    'inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    panelMode === 'add-preset' ? 'bg-neutral-900 text-white' : 'bg-white text-neutral-600 hover:bg-neutral-100',
                  )}
                >
                  <UserPlus size={12} />
                  {t('Preset')}
                </button>
                <button
                  type="button"
                  onClick={switchToCustomAdd}
                  disabled={isBusy}
                  className={cn(
                    'inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    panelMode === 'add-custom' ? 'bg-neutral-900 text-white' : 'bg-white text-neutral-600 hover:bg-neutral-100',
                  )}
                >
                  <CopyPlus size={12} />
                  {t('Custom')}
                </button>
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col">
            {panelMode === 'add-preset' ? renderPresetPanel() : renderFormPanel()}
          </section>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={handleRemove}
        title={t('Remove member')}
        variant="danger"
        isLoading={removeMember.isPending}
        confirmText={t('Remove')}
        description={
          <div className="space-y-2">
            <p>
              {removeTarget
                ? t('Remove this member from future TeamRun work?')
                : ''}
            </p>
            {removeTarget && isMemberWorking(removeTarget) ? (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-left text-red-700">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span className="text-sm font-medium">{t('确认后会停止当前工作并取消队列')}</span>
              </div>
            ) : null}
          </div>
        }
      />
    </>
  )
}
