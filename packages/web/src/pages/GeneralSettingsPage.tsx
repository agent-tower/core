import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Select } from '@/components/ui/select'
import { useI18n } from '@/lib/i18n'
import { useAppSettings, useUpdateAppSettings, useCommitMessageDefaults } from '@/hooks/use-app-settings'
import { useProviders } from '@/hooks/use-providers'
import type { AppLocale } from '@agent-tower/shared'

const LANGUAGE_OPTIONS: Array<{ value: AppLocale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

const FOLLOW_TASK_VALUE = '__follow_task__'

export function GeneralSettingsPage() {
  const { locale, setLocale, t } = useI18n()
  const { data: appSettings } = useAppSettings()
  const { data: providers } = useProviders()
  const { data: defaults } = useCommitMessageDefaults()
  const updateSettings = useUpdateAppSettings()

  const [selectedProviderId, setSelectedProviderId] = useState(FOLLOW_TASK_VALUE)
  const [promptText, setPromptText] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)

  // Sync from server: use saved prompt, or fall back to built-in default
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
    <div className="px-10 py-6 mx-auto w-full max-w-3xl space-y-8">
      <section>
        <h2 className="text-lg font-semibold text-neutral-900">{t('通用设置')}</h2>
        <p className="mt-1 text-sm text-neutral-500">
          {t('选择界面语言。设置会保存到本地 Agent Tower 数据库，并在重新打开后继续生效。')}
        </p>
      </section>

      <section>
        <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('显示语言')}</h3>
        <Select
          value={locale}
          onChange={(value) => setLocale(value as AppLocale)}
          options={LANGUAGE_OPTIONS.map(option => ({
            value: option.value,
            label: option.label,
          }))}
        />
      </section>

      {/* Git Commit Message */}
      <section className="border-t border-neutral-100 pt-6">
        <h2 className="text-lg font-semibold text-neutral-900">{t('Git Commit Message')}</h2>
        <p className="mt-1 text-sm text-neutral-500">
          {t('配置自动生成 commit message 时使用的 Agent 渠道和提示词。')}
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('Agent 渠道')}</h3>
            <p className="text-xs text-neutral-400 mb-1.5">
              {t('"跟随任务"表示使用当前任务所用的 Agent 渠道。选择具体渠道可使用更经济的模型。')}
            </p>
            <Select
              value={selectedProviderId}
              onChange={handleProviderChange}
              options={providerOptions}
            />
          </div>

          <div>
            <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('提示词模板')}</h3>
            <p className="text-xs text-neutral-400 mb-1.5">
              {t('自定义生成 commit message 的提示词。留空则使用内置默认模板。')}
            </p>
            <textarea
              value={promptText}
              onChange={(e) => {
                setPromptText(e.target.value)
                setPromptDirty(true)
              }}
              rows={6}
              className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:border-neutral-400 resize-y font-mono"
            />
            {promptDirty && (
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={handlePromptSave}
                  disabled={updateSettings.isPending}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-neutral-900 rounded-md hover:bg-neutral-800 disabled:opacity-50 transition-colors"
                >
                  {updateSettings.isPending ? t('保存中...') : t('保存')}
                </button>
                <button
                  onClick={() => {
                    setPromptText(appSettings?.commitMessagePrompt || defaults?.prompt || '')
                    setPromptDirty(false)
                  }}
                  className="px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-900 transition-colors"
                >
                  {t('取消')}
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
