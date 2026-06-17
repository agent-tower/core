import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { Check, Loader2, Plus, X, Zap, Shield, ChevronDown } from 'lucide-react'
import type { MemberPreset, TeamRunMode } from '@agent-tower/shared'
import { MemberAvatar } from './MemberAvatar'
import { useProviders } from '@/hooks/use-providers'
import { useMemberPresets, useTeamTemplates } from '@/hooks/use-team-run'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface TeamRunCreateFormProps {
  mode: TeamRunMode
  setMode: Dispatch<SetStateAction<TeamRunMode>>
  selectedTemplateId: string | null
  setSelectedTemplateId: Dispatch<SetStateAction<string | null>>
  selectedMemberPresetIds: string[]
  setSelectedMemberPresetIds: Dispatch<SetStateAction<string[]>>
  disabled?: boolean
  /** Inline quick-create layout: single column, members behind a disclosure. */
  compact?: boolean
}

function getInstanceLabel(name: string, index: number, ids: string[], id: string): string {
  const totalForId = ids.filter(item => item === id).length
  if (totalForId <= 1) return name
  const instanceNumber = ids.slice(0, index + 1).filter(item => item === id).length
  return `${name} #${instanceNumber}`
}

function countCapabilities(capabilities: MemberPreset['capabilities']) {
  return Object.values(capabilities).filter(Boolean).length
}

export function TeamRunCreateForm({
  mode,
  setMode,
  selectedTemplateId,
  setSelectedTemplateId,
  selectedMemberPresetIds,
  setSelectedMemberPresetIds,
  disabled = false,
  compact = false,
}: TeamRunCreateFormProps) {
  const { t } = useI18n()
  const [showMembers, setShowMembers] = useState(false)
  const { data: providersData } = useProviders()
  const {
    data: memberPresetsData,
    isError: memberPresetsIsError,
    isFetching: memberPresetsIsFetching,
    isLoading: memberPresetsIsLoading,
    refetch: refetchMemberPresets,
  } = useMemberPresets()
  const {
    data: teamTemplatesData,
    isError: teamTemplatesIsError,
    isFetching: teamTemplatesIsFetching,
    isLoading: teamTemplatesIsLoading,
    refetch: refetchTeamTemplates,
  } = useTeamTemplates()

  const providerLabelById = useMemo(() => {
    return new Map(
      (providersData ?? []).map(({ provider, availability }) => [
        provider.id,
        provider.name + (availability.type === 'NOT_FOUND' ? t(' (不可用)') : ''),
      ] as const),
    )
  }, [providersData, t])

  const memberPresetById = useMemo(() => {
    return new Map((memberPresetsData ?? []).map((preset) => [preset.id, preset] as const))
  }, [memberPresetsData])

  const teamTemplateById = useMemo(() => {
    return new Map((teamTemplatesData ?? []).map((template) => [template.id, template] as const))
  }, [teamTemplatesData])

  const selectedMemberPresets = useMemo(
    () =>
      selectedMemberPresetIds
        .map((id) => memberPresetById.get(id))
        .filter((item): item is MemberPreset => Boolean(item)),
    [memberPresetById, selectedMemberPresetIds],
  )

  useEffect(() => {
    if (memberPresetsData === undefined) return
    setSelectedMemberPresetIds((current) => {
      const next = current.filter((id) => memberPresetById.has(id))
      if (next.length === current.length && next.every((id, index) => id === current[index])) return current
      return next
    })
  }, [memberPresetsData, memberPresetById, setSelectedMemberPresetIds])

  useEffect(() => {
    if (teamTemplatesData === undefined) return
    setSelectedTemplateId((current) => {
      if (!current || teamTemplateById.has(current)) return current
      return null
    })
  }, [setSelectedTemplateId, teamTemplateById, teamTemplatesData])

  const handleToggleTemplate = (templateId: string) => {
    if (disabled) return
    setSelectedTemplateId((current) => (current === templateId ? null : templateId))
  }

  const handleAddMemberPreset = (presetId: string) => {
    if (disabled) return
    setSelectedMemberPresetIds((current) => [...current, presetId])
  }

  const handleRemoveSelectedPreset = (index: number) => {
    if (disabled) return
    setSelectedMemberPresetIds((current) => current.filter((_, i) => i !== index))
  }

  const templateSection = (
    <section className="min-w-0">
      <div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t('团队模板')}</div>
      {teamTemplatesIsError ? (
        <div className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          <span>{t('团队模板加载失败')}</span>
          <button
            type="button"
            onClick={() => void refetchTeamTemplates()}
            disabled={disabled || teamTemplatesIsFetching}
            className="ml-2 underline hover:no-underline"
          >
            {t('重试')}
          </button>
        </div>
      ) : teamTemplatesIsLoading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          {t('加载中...')}
        </div>
      ) : (teamTemplatesData ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-xs text-muted-foreground">
          {t('当前没有团队模板')}
          <Link to="/settings/team" className="ml-1.5 text-info hover:underline">
            {t('去创建')}
          </Link>
        </div>
      ) : (
        <div className={cn('space-y-1.5', compact && 'sm:grid sm:grid-cols-2 sm:gap-1.5 sm:space-y-0')}>
          {(teamTemplatesData ?? []).map((template) => {
            const isSelected = template.id === selectedTemplateId
            const memberCount = template.members?.length ?? 0
            const memberPresetIds = template.members?.map((m) => m.memberPresetId) ?? []
            const preview = template.members
              ?.slice(0, 3)
              .map((m, i) => getInstanceLabel(m.memberPreset?.name ?? m.memberPresetId, i, memberPresetIds, m.memberPresetId))
              .join(', ')

            return (
              <button
                key={template.id}
                type="button"
                onClick={() => handleToggleTemplate(template.id)}
                disabled={disabled}
                className={cn(
                  'w-full rounded-lg px-3 py-2 text-left border transition-all disabled:cursor-not-allowed disabled:opacity-60',
                  isSelected
                    ? 'bg-background border-foreground/20 shadow-sm'
                    : 'bg-background border-border/60 hover:border-border hover:bg-accent',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={cn('text-xs truncate', isSelected ? 'font-medium text-foreground' : 'text-foreground')}>
                        {template.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{memberCount}{t('人')}</span>
                    </div>
                    {preview && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground truncate">{preview}</div>
                    )}
                  </div>
                  {isSelected && <Check size={13} className="shrink-0 text-foreground" />}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )

  const memberChips = selectedMemberPresets.length > 0 && (
    <div className="flex flex-wrap gap-1 mb-2">
      {selectedMemberPresets.map((preset, index) => {
        const displayName = getInstanceLabel(preset.name, index, selectedMemberPresetIds, preset.id)
        return (
          <div
            key={`${preset.id}-${index}`}
            className="inline-flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded-md border border-border/60 bg-background text-[10px] text-foreground"
          >
            <MemberAvatar name={preset.name} avatar={preset.avatar} className="h-3.5 w-3.5 text-[7px]" />
            <span className="max-w-[80px] truncate">{displayName}</span>
            <button
              type="button"
              onClick={() => handleRemoveSelectedPreset(index)}
              disabled={disabled}
              className="p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-30 rounded transition-colors"
            >
              <X size={9} />
            </button>
          </div>
        )
      })}
    </div>
  )

  const memberList = memberPresetsIsError ? (
    <div className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
      <span>{t('成员预设加载失败')}</span>
      <button
        type="button"
        onClick={() => void refetchMemberPresets()}
        disabled={disabled || memberPresetsIsFetching}
        className="ml-2 underline hover:no-underline"
      >
        {t('重试')}
      </button>
    </div>
  ) : memberPresetsIsLoading ? (
    <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
      <Loader2 size={12} className="animate-spin" />
      {t('加载中...')}
    </div>
  ) : (memberPresetsData ?? []).length === 0 ? (
    <div className="rounded-lg border border-dashed border-border bg-background px-3 py-3 text-xs text-muted-foreground">
      {t('当前没有成员预设')}
      <Link to="/settings/team" className="ml-1.5 text-info hover:underline">
        {t('去创建')}
      </Link>
    </div>
  ) : (
    <div className="space-y-1 max-h-[180px] overflow-y-auto pr-1">
      {(memberPresetsData ?? []).map((preset) => {
        const selectedCount = selectedMemberPresetIds.filter((id) => id === preset.id).length
        const providerLabel = providerLabelById.get(preset.providerId) ?? preset.providerId
        const capCount = countCapabilities(preset.capabilities)

        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => handleAddMemberPreset(preset.id)}
            disabled={disabled}
            className={cn(
              'flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-left border border-transparent transition-all',
              disabled && 'cursor-not-allowed opacity-60',
              'bg-background hover:bg-accent hover:border-border/60',
            )}
          >
            <MemberAvatar name={preset.name} avatar={preset.avatar} className="h-6 w-6 text-[9px] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-foreground truncate">{preset.name}</div>
              <div className="text-[10px] text-muted-foreground truncate">{providerLabel} · {capCount}/10</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {selectedCount > 0 && (
                <span className="text-[10px] text-foreground font-semibold">×{selectedCount}</span>
              )}
              <Plus size={12} className="text-muted-foreground" />
            </div>
          </button>
        )
      })}
    </div>
  )

  const memberCountBadge = selectedMemberPresets.length > 0 && (
    <span className="inline-flex items-center justify-center min-w-[16px] h-4 rounded-full bg-primary text-[10px] font-semibold text-primary-foreground px-1.5">
      {selectedMemberPresets.length}
    </span>
  )

  // Mode selector — shared by both layouts
  const modeSelector = (
    <div className="flex items-center gap-3">
      <span className="text-[11px] font-medium text-muted-foreground shrink-0">{t('执行模式')}</span>
      <div className="inline-flex items-center h-7 rounded-md border border-border/70 bg-background p-0.5">
        <button
          type="button"
          onClick={() => !disabled && setMode('AUTO')}
          disabled={disabled}
          className={cn(
            'flex items-center gap-1.5 rounded h-full px-2.5 text-xs transition-all disabled:cursor-not-allowed disabled:opacity-50',
            mode === 'AUTO'
              ? 'bg-primary text-primary-foreground font-medium shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Zap size={11} />
          {t('自动模式')}
        </button>
        <button
          type="button"
          onClick={() => !disabled && setMode('CONFIRM')}
          disabled={disabled}
          className={cn(
            'flex items-center gap-1.5 rounded h-full px-2.5 text-xs transition-all disabled:cursor-not-allowed disabled:opacity-50',
            mode === 'CONFIRM'
              ? 'bg-primary text-primary-foreground font-medium shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Shield size={11} />
          {t('确认模式')}
        </button>
      </div>
    </div>
  )

  // Compact: single column, members tucked behind a disclosure (inline quick-create)
  if (compact) {
    return (
      <div className="space-y-3">
        {modeSelector}
        {templateSection}

        <div className="border-t border-border/50 pt-2.5">
          <button
            type="button"
            onClick={() => !disabled && setShowMembers((v) => !v)}
            disabled={disabled}
            aria-expanded={showMembers}
            className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronDown size={12} className={cn('transition-transform', showMembers ? '' : '-rotate-90')} />
            {t('追加独立成员')}
            {memberCountBadge}
          </button>
          {showMembers && (
            <div className="mt-2">
              {memberChips}
              {memberList}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Full: two-column grid (roomy modal)
  return (
    <div className="space-y-3.5">
      {modeSelector}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {templateSection}

        <section className="min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">{t('追加成员')}</span>
            {memberCountBadge}
          </div>
          {memberChips}
          {memberList}
        </section>
      </div>
    </div>
  )
}
