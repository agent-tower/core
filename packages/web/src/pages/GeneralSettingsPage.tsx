import { useState, useEffect, useCallback, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/lib/i18n'
import { useAppSettings, useUpdateAppSettings, useCommitMessageDefaults } from '@/hooks/use-app-settings'
import {
  useAccessAuthSettings,
  useLogoutAccessAuth,
  useUpdateAccessAuthSettings,
} from '@/hooks/use-access-auth'
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
const ACCESS_PASSWORD_MIN_LENGTH = 8
type AccessPasswordMode = 'idle' | 'enable' | 'change' | 'disable'

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function GeneralSettingsPage() {
  const { locale, setLocale, t } = useI18n()
  const { data: appSettings } = useAppSettings()
  const { data: providers } = useProviders()
  const { data: defaults } = useCommitMessageDefaults()
  const { data: accessSettings } = useAccessAuthSettings()
  const updateSettings = useUpdateAppSettings()
  const updateAccessAuth = useUpdateAccessAuthSettings()
  const logoutAccessAuth = useLogoutAccessAuth()

  const [selectedProviderId, setSelectedProviderId] = useState(FOLLOW_TASK_VALUE)
  const [promptText, setPromptText] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [accessEnabledDraft, setAccessEnabledDraft] = useState(false)
  const [editingAccessPassword, setEditingAccessPassword] = useState(false)
  const [accessPasswordError, setAccessPasswordError] = useState<string | null>(null)

  useEffect(() => {
    if (!appSettings || !defaults) return
    setSelectedProviderId(appSettings.commitMessageProviderId || FOLLOW_TASK_VALUE)
    setPromptText(appSettings.commitMessagePrompt || defaults.prompt)
    setPromptDirty(false)
  }, [appSettings, defaults])

  useEffect(() => {
    if (!accessSettings) return
    setAccessEnabledDraft(accessSettings.enabled)
    setEditingAccessPassword(false)
    setAccessPasswordError(null)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }, [accessSettings?.enabled])

  const providerOptions = [
    { value: FOLLOW_TASK_VALUE, label: t('跟随任务') },
    ...(providers ?? [])
      .filter(p => p.availability.type !== 'NOT_FOUND')
      .map(p => ({ value: p.provider.id, label: p.provider.name })),
  ]

  const accessEnabled = accessSettings?.enabled ?? false
  const accessPasswordMode: AccessPasswordMode = !accessEnabled && accessEnabledDraft
    ? 'enable'
    : accessEnabled && !accessEnabledDraft
      ? 'disable'
      : accessEnabled && editingAccessPassword
        ? 'change'
        : 'idle'
  const showAccessPasswordForm = accessPasswordMode !== 'idle'
  const accessStatusLabel = showAccessPasswordForm
    ? accessPasswordMode === 'disable'
      ? t('将关闭')
      : accessPasswordMode === 'enable'
        ? t('将启用')
        : t('已启用')
    : accessEnabled
      ? t('已启用')
      : t('未启用')

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

  const clearPasswordFields = useCallback(() => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }, [])

  const resetAccessPasswordEdit = useCallback(() => {
    setAccessEnabledDraft(accessSettings?.enabled ?? false)
    setEditingAccessPassword(false)
    setAccessPasswordError(null)
    clearPasswordFields()
  }, [accessSettings?.enabled, clearPasswordFields])

  const validateAccessPasswordForm = useCallback((mode: AccessPasswordMode) => {
    if ((mode === 'change' || mode === 'disable') && !currentPassword) {
      setAccessPasswordError(t('请输入当前密码'))
      return false
    }

    if (mode === 'enable' || mode === 'change') {
      if (newPassword.length < ACCESS_PASSWORD_MIN_LENGTH) {
        setAccessPasswordError(t('密码至少需要 8 个字符'))
        return false
      }
      if (newPassword !== confirmPassword) {
        setAccessPasswordError(t('两次输入不一致'))
        return false
      }
    }

    setAccessPasswordError(null)
    return true
  }, [confirmPassword, currentPassword, newPassword, t])

  const handleAccessPasswordSave = useCallback(() => {
    if (accessPasswordMode === 'idle') return
    if (!validateAccessPasswordForm(accessPasswordMode)) return

    const payload = accessPasswordMode === 'disable'
      ? { enabled: false, currentPassword }
      : accessPasswordMode === 'enable'
        ? { enabled: true, newPassword }
        : { currentPassword, newPassword }

    updateAccessAuth.mutate(
      payload,
      {
        onSuccess: (settings) => {
          setAccessEnabledDraft(settings.enabled)
          setEditingAccessPassword(false)
          setAccessPasswordError(null)
          clearPasswordFields()
          toast.success(accessPasswordMode === 'disable' ? t('已关闭') : t('已保存'))
        },
        onError: (error) => {
          const message = getErrorMessage(error, t('保存失败'))
          if (message.toLowerCase().includes('current password')) {
            setAccessPasswordError(t('当前密码不正确'))
          } else if (message.toLowerCase().includes('at least 8')) {
            setAccessPasswordError(t('密码至少需要 8 个字符'))
          } else {
            setAccessPasswordError(message)
          }
        },
      },
    )
  }, [
    accessPasswordMode,
    clearPasswordFields,
    currentPassword,
    newPassword,
    t,
    updateAccessAuth,
    validateAccessPasswordForm,
  ])

  const handleAccessSwitch = useCallback((checked: boolean) => {
    if (!accessSettings || updateAccessAuth.isPending) return
    setAccessEnabledDraft(checked)
    setEditingAccessPassword(false)
    setAccessPasswordError(null)
    clearPasswordFields()
  }, [accessSettings, clearPasswordFields, updateAccessAuth.isPending])

  const handleLogoutAccessAuth = useCallback(() => {
    logoutAccessAuth.mutate(undefined, {
      onSuccess: () => toast.success(t('已退出登录')),
      onError: (error) => toast.error(getErrorMessage(error, t('退出登录失败'))),
    })
  }, [logoutAccessAuth, t])

  const handleAccessPasswordSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    handleAccessPasswordSave()
  }, [handleAccessPasswordSave])

  const handleStartChangeAccessPassword = useCallback(() => {
    if (!accessSettings || updateAccessAuth.isPending) {
      return
    }
    setAccessEnabledDraft(true)
    setEditingAccessPassword(true)
    setAccessPasswordError(null)
    clearPasswordFields()
  }, [accessSettings, clearPasswordFields, updateAccessAuth.isPending])

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
        {t('访问安全')}
      </SettingsSectionTitle>

      <div className="divide-y divide-border/60">
        <SettingsRow
          label={t('访问密码')}
          description={t('开启后，进入 Agent Tower 需要输入密码。')}
          controlWidth="fixed"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">{accessStatusLabel}</span>
              <Switch
                checked={accessEnabledDraft}
                onCheckedChange={handleAccessSwitch}
                disabled={!accessSettings || updateAccessAuth.isPending}
                aria-label={t('访问密码')}
              />
            </div>

            {accessEnabled && accessPasswordMode === 'idle' && (
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={handleStartChangeAccessPassword}
                  disabled={updateAccessAuth.isPending}
                >
                  {t('修改密码')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="w-full sm:w-auto"
                  onClick={handleLogoutAccessAuth}
                  disabled={logoutAccessAuth.isPending}
                >
                  {logoutAccessAuth.isPending ? t('退出中...') : t('退出登录')}
                </Button>
              </div>
            )}

            {showAccessPasswordForm && (
              <form className="space-y-2" onSubmit={handleAccessPasswordSubmit}>
                {(accessPasswordMode === 'change' || accessPasswordMode === 'disable') && (
                  <Input
                    type="password"
                    autoComplete="current-password"
                    placeholder={t('当前密码')}
                    value={currentPassword}
                    onChange={(event) => {
                      setCurrentPassword(event.target.value)
                      setAccessPasswordError(null)
                    }}
                    disabled={updateAccessAuth.isPending}
                    aria-invalid={Boolean(accessPasswordError && !currentPassword)}
                  />
                )}

                {(accessPasswordMode === 'enable' || accessPasswordMode === 'change') && (
                  <>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder={accessPasswordMode === 'enable' ? t('访问密码') : t('新密码')}
                      value={newPassword}
                      onChange={(event) => {
                        setNewPassword(event.target.value)
                        setAccessPasswordError(null)
                      }}
                      disabled={updateAccessAuth.isPending}
                      aria-invalid={Boolean(accessPasswordError && newPassword.length < ACCESS_PASSWORD_MIN_LENGTH)}
                    />
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder={t('确认密码')}
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value)
                        setAccessPasswordError(null)
                      }}
                      disabled={updateAccessAuth.isPending}
                      aria-invalid={Boolean(accessPasswordError && newPassword !== confirmPassword)}
                    />
                  </>
                )}

                {(accessPasswordMode === 'change' || accessPasswordMode === 'disable') && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {accessPasswordMode === 'disable'
                      ? t('关闭后不再要求访问密码。')
                      : t('保存后其他已登录页面需要重新输入。')}
                  </p>
                )}

                {accessPasswordError && (
                  <p className="text-xs text-destructive">{accessPasswordError}</p>
                )}

                <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full sm:w-auto"
                    onClick={resetAccessPasswordEdit}
                    disabled={updateAccessAuth.isPending}
                  >
                    {t('取消')}
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={updateAccessAuth.isPending}
                  >
                    {updateAccessAuth.isPending
                      ? t('保存中...')
                      : accessPasswordMode === 'disable'
                        ? t('关闭访问密码')
                        : t('保存')}
                  </Button>
                </div>
              </form>
            )}
          </div>
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
