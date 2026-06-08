import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Select } from '@/components/ui/select'
import { useI18n } from '@/lib/i18n'
import { useAppSettings, useUpdateAppSettings, useCommitMessageDefaults } from '@/hooks/use-app-settings'
import { useProviders } from '@/hooks/use-providers'
import { SettingsPageContainer } from '@/components/settings/SettingsSection'
import type { AppLocale } from '@agent-tower/shared'

const LANGUAGE_OPTIONS: Array<{ value: AppLocale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

const FOLLOW_TASK_VALUE = '__follow_task__'

function SettingsRow({
  label,
  description,
  children,
  border = true,
}: {
  label: string
  description?: string
  children: React.ReactNode
  border?: boolean
}) {
  return (
    <div className={`flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-8 ${border ? 'border-b border-neutral-100' : ''}`}>
      <div className="min-w-0 sm:max-w-[360px]">
        <div className="text-[13px] font-medium text-neutral-900">{label}</div>
        {description && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-neutral-500">{description}</p>
        )}
      </div>
      <div className="w-full sm:w-[260px] shrink-0">{children}</div>
    </div>
  )
}

export function GeneralSettingsPage() {
  const { locale, setLocale, t } = useI18n()
  const { data: appSettings } = useAppSettings()
  const { data: providers } = useProviders()
  const { data: defaults } = useCommitMessageDefaults()
  const updateSettings = useUpdateAppSettings()

  const [selectedProviderId, setSelectedProviderId] = useState(FOLLOW_TASK_VALUE)
  const [promptText, setPromptText] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)

  useEffect(() => {
    if (!appSettings || !defaults) return
    setSelectedProviderId(appSettings.commitMessageProviderId || FOLLOW_TASK_VALUE)
    setPromptText(appSettings.commitMessagePrompt || defaults.prompt)
    setPromptDirty(false)
  }, [appSettings, defaults])

  const providerOptions = [
    { value: FOLLOW_TASK_VALUE, label: t('跟随任务') },
    ...(providers ?? [])
      .filter(p => p.availability.type !== 'NOT_FOUND')
      .map(p => ({ value: p.provider.id, label: p.provider.name })),
  ]

  const handleProviderChange = useCallback((value: string) => {
    setSelectedProviderId(value)
    const providerId = value === FOLLOW_TASK_VALUE ? null : value
    updateSettings.mutate(
      { commitMessageProviderId: providerId },
      { onError: () => toast.error(t('保存失败')) },
    )
  }, [updateSettings, t])

  const handlePromptSave = useCallback(() => {
    const prompt = promptText.trim() || null
    updateSettings.mutate(
      { commitMessagePrompt: prompt },
      {
        onSuccess: () => {
          setPromptDirty(false)
          toast.success(t('已保存'))
        },
        onError: () => toast.error(t('保存失败')),
      },
    )
  }, [promptText, updateSettings, t])

  return (
    <SettingsPageContainer>
      <div className="mb-1">
        <h2 className="text-base font-semibold text-neutral-900">{t('通用设置')}</h2>
      </div>

      <SettingsRow
        label={t('显示语言')}
        description={t('界面语言会保存到本地数据库，重启后继续生效。')}
      >
        <Select
          value={locale}
          onChange={(value) => setLocale(value as AppLocale)}
          options={LANGUAGE_OPTIONS}
        />
      </SettingsRow>

      <div className="mt-8 mb-2">
        <h3 className="text-[13px] font-semibold text-neutral-900 uppercase tracking-wide text-neutral-500">
          {t('Git Commit Message')}
        </h3>
      </div>

      <SettingsRow
        label={t('Agent 渠道')}
        description={t('"跟随任务"表示使用当前任务所用的 Agent 渠道。选择具体渠道可使用更经济的模型。')}
      >
        <Select
          value={selectedProviderId}
          onChange={handleProviderChange}
          options={providerOptions}
        />
      </SettingsRow>

      <SettingsRow
        label={t('提示词模板')}
        description={t('自定义生成 commit message 的提示词。留空则使用内置默认模板。')}
        border={false}
      >
        <div className="space-y-2">
          <textarea
            value={promptText}
            onChange={(e) => {
              setPromptText(e.target.value)
              setPromptDirty(true)
            }}
            rows={5}
            className="w-full rounded-lg border border-neutral-200 bg-neutral-50/50 px-3 py-2 text-sm font-mono leading-relaxed transition-colors focus:border-neutral-400 focus:bg-white focus:outline-none resize-y"
          />
          {promptDirty && (
            <div className="flex items-center gap-2">
              <button
                onClick={handlePromptSave}
                disabled={updateSettings.isPending}
                className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
              >
                {updateSettings.isPending ? t('保存中...') : t('保存')}
              </button>
              <button
                onClick={() => {
                  setPromptText(appSettings?.commitMessagePrompt || defaults?.prompt || '')
                  setPromptDirty(false)
                }}
                className="rounded-lg px-3 py-1.5 text-xs text-neutral-500 transition-colors hover:text-neutral-900"
              >
                {t('取消')}
              </button>
            </div>
          )}
        </div>
      </SettingsRow>
    </SettingsPageContainer>
  )
}
