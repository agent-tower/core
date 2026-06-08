import { useEffect, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { Check, Loader2, Plus, X, Zap, Shield } from 'lucide-react'
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
}: TeamRunCreateFormProps) {
  const { t } = useI18n()
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

  return (
    <div className="space-y-3">
      {/* Mode selector */}
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-neutral-500 shrink-0">{t('执行模式')}</span>
        <div className="inline-flex rounded-md bg-white p-0.5 shadow-sm">
          <button
            type="button"
            onClick={() => !disabled && setMode('AUTO')}
            disabled={disabled}
            className={cn(
              'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-all disabled:cursor-not-allowed disabled:opacity-50',
              mode === 'AUTO'
                ? 'bg-neutral-800 text-white shadow-sm font-medium'
                : 'text-neutral-500 hover:text-neutral-700',
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
              'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-all disabled:cursor-not-allowed disabled:opacity-50',
              mode === 'CONFIRM'
                ? 'bg-neutral-800 text-white shadow-sm font-medium'
                : 'text-neutral-500 hover:text-neutral-700',
            )}
          >
            <Shield size={11} />
            {t('确认模式')}
          </button>
        </div>
      </div>

      {/* Two-column grid: Templates | Members */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Template column */}
        <section className="min-w-0">
          <div className="text-[11px] font-medium text-neutral-500 mb-1.5">{t('团队模板')}</div>
          {teamTemplatesIsError ? (
            <div className="rounded-lg bg-red-50 px-3 py-2.5 text-xs text-red-600">
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
            <div className="flex items-center gap-2 py-3 text-xs text-neutral-400">
              <Loader2 size={12} className="animate-spin" />
              {t('加载中...')}
            </div>
          ) : (teamTemplatesData ?? []).length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-200 bg-white px-3 py-3 text-xs text-neutral-400">
              {t('当前没有团队模板')}
              <Link to="/settings/team" className="ml-1.5 text-blue-500 hover:underline">
                {t('去创建')}
              </Link>
            </div>
          ) : (
            <div className="space-y-1.5">
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
                      'w-full rounded-lg px-3 py-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60',
                      isSelected
                        ? 'bg-blue-50 ring-1 ring-blue-200'
                        : 'bg-white hover:bg-white/80',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('text-xs truncate', isSelected ? 'font-medium text-blue-800' : 'text-neutral-800')}>
                            {template.name}
                          </span>
                          <span className="text-[10px] text-neutral-400 shrink-0">{memberCount}{t('人')}</span>
                        </div>
                        {preview && (
                          <div className="mt-0.5 text-[10px] text-neutral-400 truncate">{preview}</div>
                        )}
                      </div>
                      {isSelected && <Check size={13} className="shrink-0 text-blue-600" />}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {/* Members column */}
        <section className="min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[11px] font-medium text-neutral-500">{t('追加成员')}</span>
            {selectedMemberPresets.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[16px] h-4 rounded-full bg-blue-600 text-[9px] font-medium text-white px-1">
                {selectedMemberPresets.length}
              </span>
            )}
          </div>

          {/* Selected chips */}
          {selectedMemberPresets.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {selectedMemberPresets.map((preset, index) => {
                const displayName = getInstanceLabel(preset.name, index, selectedMemberPresetIds, preset.id)
                return (
                  <div
                    key={`${preset.id}-${index}`}
                    className="inline-flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded bg-blue-50 text-[10px] text-neutral-700"
                  >
                    <MemberAvatar name={preset.name} avatar={preset.avatar} className="h-3.5 w-3.5 text-[7px]" />
                    <span className="max-w-[80px] truncate">{displayName}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveSelectedPreset(index)}
                      disabled={disabled}
                      className="p-0.5 text-neutral-400 hover:text-red-500 disabled:opacity-30 rounded"
                    >
                      <X size={9} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Member list */}
          {memberPresetsIsError ? (
            <div className="rounded-lg bg-red-50 px-3 py-2.5 text-xs text-red-600">
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
            <div className="flex items-center gap-2 py-3 text-xs text-neutral-400">
              <Loader2 size={12} className="animate-spin" />
              {t('加载中...')}
            </div>
          ) : (memberPresetsData ?? []).length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-200 bg-white px-3 py-3 text-xs text-neutral-400">
              {t('当前没有成员预设')}
              <Link to="/settings/team" className="ml-1.5 text-blue-500 hover:underline">
                {t('去创建')}
              </Link>
            </div>
          ) : (
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
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
                      'flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-left transition-all',
                      disabled && 'cursor-not-allowed opacity-60',
                      'bg-white hover:bg-white/80',
                    )}
                  >
                    <MemberAvatar name={preset.name} avatar={preset.avatar} className="h-6 w-6 text-[9px] shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-neutral-800 truncate">{preset.name}</div>
                      <div className="text-[10px] text-neutral-400 truncate">{providerLabel} · {capCount}/10</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {selectedCount > 0 && (
                        <span className="text-[9px] text-blue-600 font-medium">×{selectedCount}</span>
                      )}
                      <Plus size={12} className="text-neutral-300" />
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
