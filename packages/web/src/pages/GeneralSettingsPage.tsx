import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/lib/i18n'
import { useAppSettings, useUpdateAppSettings, useCommitMessageDefaults } from '@/hooks/use-app-settings'
import { useProviders } from '@/hooks/use-providers'
import {
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsSectionTitle,
  SettingsRow,
} from '@/components/settings/SettingsSection'
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
      <SettingsPageHeader title={t('通用设置')} className="mb-1" />

      <div className="divide-y divide-border/60">
        <SettingsRow
          label={t('显示语言')}
          description={t('界面语言会保存到本地数据库，重启后继续生效。')}
          align="center"
        >
          <Select
            value={locale}
            onChange={(value) => setLocale(value as AppLocale)}
            options={LANGUAGE_OPTIONS}
          />
        </SettingsRow>
      </div>

      <SettingsSectionTitle className="mt-8 mb-1">
        {t('Git Commit Message')}
      </SettingsSectionTitle>

      <div className="divide-y divide-border/60">
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
        >
          <div className="space-y-2">
            <Textarea
              value={promptText}
              onChange={(e) => {
                setPromptText(e.target.value)
                setPromptDirty(true)
              }}
              rows={5}
              className="font-mono resize-y"
            />
            {promptDirty && (
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPromptText(appSettings?.commitMessagePrompt || defaults?.prompt || '')
                    setPromptDirty(false)
                  }}
                >
                  {t('取消')}
                </Button>
                <Button size="sm" onClick={handlePromptSave} disabled={updateSettings.isPending}>
                  {updateSettings.isPending ? t('保存中...') : t('保存')}
                </Button>
              </div>
            )}
          </div>
        </SettingsRow>
      </div>
    </SettingsPageContainer>
  )
}
