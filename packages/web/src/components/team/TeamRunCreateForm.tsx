import { useEffect, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import type { MemberPreset, TeamRunMode } from '@agent-tower/shared'
import { Button } from '@/components/ui/button'
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

interface QueryErrorNoticeProps {
  title: string
  error: unknown
  isFetching: boolean
  onRetry: () => void
  disabled?: boolean
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function countCapabilities(capabilities: MemberPreset['capabilities']) {
  return Object.values(capabilities).filter(Boolean).length
}

function QueryErrorNotice({ title, error, isFetching, onRetry, disabled }: QueryErrorNoticeProps) {
  const { t } = useI18n()

  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          <div className="mt-1 text-xs text-red-600">
            {getErrorMessage(error, t('请稍后重试。'))}
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={disabled || isFetching}>
          {isFetching ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {t('加载中...')}
            </>
          ) : (
            t('重试')
          )}
        </Button>
      </div>
    </div>
  )
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
    error: memberPresetsError,
    isError: memberPresetsIsError,
    isFetching: memberPresetsIsFetching,
    isLoading: memberPresetsIsLoading,
    refetch: refetchMemberPresets,
  } = useMemberPresets()
  const {
    data: teamTemplatesData,
    error: teamTemplatesError,
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

  const selectedTemplate = selectedTemplateId ? teamTemplateById.get(selectedTemplateId) ?? null : null
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
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current
      }
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

  const handleToggleMemberPreset = (presetId: string) => {
    if (disabled) return
    setSelectedMemberPresetIds((current) =>
      current.includes(presetId)
        ? current.filter((id) => id !== presetId)
        : [...current, presetId],
    )
  }

  const handleMoveSelectedPreset = (index: number, direction: -1 | 1) => {
    if (disabled) return
    setSelectedMemberPresetIds((current) => {
      const nextIndex = index + direction
      if (nextIndex < 0 || nextIndex >= current.length) return current

      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(nextIndex, 0, item)
      return next
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-neutral-900">{t('TeamRun 模式')}</div>
          <div className="text-xs text-neutral-500">{t('默认使用确认模式，便于先检查团队编排。')}</div>
        </div>
        <div className="inline-flex rounded-md border border-neutral-200 bg-neutral-50 p-1">
          <button
            type="button"
            onClick={() => !disabled && setMode('CONFIRM')}
            disabled={disabled}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              mode === 'CONFIRM'
                ? 'bg-white text-neutral-900 shadow-sm'
                : 'text-neutral-500 hover:text-neutral-900',
            )}
          >
            {t('确认模式')}
          </button>
          <button
            type="button"
            onClick={() => !disabled && setMode('AUTO')}
            disabled={disabled}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              mode === 'AUTO'
                ? 'bg-white text-neutral-900 shadow-sm'
                : 'text-neutral-500 hover:text-neutral-900',
            )}
          >
            {t('自动模式')}
          </button>
        </div>
      </div>

      <div className="pr-1">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div className="space-y-5">
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">{t('团队模板')}</h3>
                <p className="text-xs text-neutral-400">{t('模板成员会先加入，随后按顺序追加所选成员。')}</p>
              </div>

              {teamTemplatesIsError ? (
                <QueryErrorNotice
                  title={t('团队模板加载失败')}
                  error={teamTemplatesError}
                  isFetching={teamTemplatesIsFetching}
                  onRetry={() => void refetchTeamTemplates()}
                  disabled={disabled}
                />
              ) : teamTemplatesIsLoading ? (
                <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400">
                  <Loader2 size={14} className="animate-spin" />
                  {t('加载中...')}
                </div>
              ) : (teamTemplatesData ?? []).length === 0 ? (
                <div className="rounded-lg border border-dashed border-neutral-200 bg-white px-4 py-4 text-sm text-neutral-400">
                  <div>{t('当前没有团队模板')}</div>
                  <Button asChild size="sm" variant="outline" className="mt-3">
                    <Link to="/settings/team">{t('前往 /settings/team 创建')}</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {(teamTemplatesData ?? []).map((template) => {
                    const isSelected = template.id === selectedTemplateId
                    const memberCount = template.members?.length ?? 0
                    const memberPreview = template.members
                      ?.slice(0, 3)
                      .map((member) => member.memberPreset?.name ?? member.memberPresetId)
                      .join(' · ')

                    return (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => handleToggleTemplate(template.id)}
                        disabled={disabled}
                        className={cn(
                          'w-full rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
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
                          {isSelected && <Check size={14} className="mt-0.5 shrink-0 text-neutral-900" />}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">{t('成员预设')}</h3>
                <p className="text-xs text-neutral-400">{t('选择顺序即保存顺序。')}</p>
              </div>

              {memberPresetsIsError ? (
                <QueryErrorNotice
                  title={t('成员预设加载失败')}
                  error={memberPresetsError}
                  isFetching={memberPresetsIsFetching}
                  onRetry={() => void refetchMemberPresets()}
                  disabled={disabled}
                />
              ) : memberPresetsIsLoading ? (
                <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-400">
                  <Loader2 size={14} className="animate-spin" />
                  {t('加载中...')}
                </div>
              ) : (memberPresetsData ?? []).length === 0 ? (
                <div className="rounded-lg border border-dashed border-neutral-200 bg-white px-4 py-4 text-sm text-neutral-400">
                  <div>{t('当前没有成员预设')}</div>
                  <Button asChild size="sm" variant="outline" className="mt-3">
                    <Link to="/settings/team">{t('前往 /settings/team 创建')}</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {(memberPresetsData ?? []).map((preset) => {
                    const checked = selectedMemberPresetIds.includes(preset.id)
                    const providerLabel = providerLabelById.get(preset.providerId) ?? preset.providerId
                    const capabilityCount = countCapabilities(preset.capabilities)

                    return (
                      <label
                        key={preset.id}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors',
                          disabled && 'cursor-not-allowed opacity-60',
                          checked
                            ? 'border-neutral-900 bg-neutral-50'
                            : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggleMemberPreset(preset.id)}
                          disabled={disabled}
                          className="mt-1 h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-400 disabled:cursor-not-allowed"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-neutral-900">{preset.name}</div>
                          <div className="truncate text-xs text-neutral-500">{providerLabel}</div>
                        </div>
                        <div className="shrink-0 text-[11px] text-neutral-400">
                          {capabilityCount}/10
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </section>
          </div>

          <div className="space-y-5">
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">{t('已选成员')}</h3>
                <p className="text-xs text-neutral-400">{t('上移下移后即为保存顺序。')}</p>
              </div>

              {selectedMemberPresets.length === 0 ? (
                <div className="rounded-lg border border-dashed border-neutral-200 bg-white px-4 py-4 text-sm text-neutral-400">
                  {t('尚未选择成员预设')}
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedMemberPresets.map((preset, index) => {
                    const providerLabel = providerLabelById.get(preset.providerId) ?? preset.providerId
                    return (
                      <div
                        key={preset.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-neutral-900">{preset.name}</div>
                          <div className="truncate text-xs text-neutral-500">{providerLabel}</div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleMoveSelectedPreset(index, -1)}
                            disabled={disabled || index === 0}
                            title={t('上移')}
                          >
                            <ChevronUp size={14} />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => handleMoveSelectedPreset(index, 1)}
                            disabled={disabled || index === selectedMemberPresets.length - 1}
                            title={t('下移')}
                          >
                            <ChevronDown size={14} />
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-4">
              <div className="text-xs font-medium text-neutral-700">{t('模板成员会先加入，随后按顺序追加所选成员。')}</div>
              <div className="mt-2 text-xs text-neutral-500">
                {selectedTemplate ? (
                  <>
                    <span className="font-medium text-neutral-700">{selectedTemplate.name}</span>
                    <span className="mx-1">·</span>
                    <span>{t('{count} 个成员', { count: selectedTemplate.members?.length ?? 0 })}</span>
                  </>
                ) : (
                  <span>{t('请选择至少一个团队模板或成员预设。')}</span>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
