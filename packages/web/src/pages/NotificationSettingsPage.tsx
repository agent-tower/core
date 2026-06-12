import { useState, useEffect, useRef } from 'react'
import {
  useNotificationSettings,
  useUpdateNotificationSettings,
  useTestNotificationChannel,
} from '@/hooks/use-notifications'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CheckCircle2, AlertCircle, Loader2, Link, Bell, MessageSquare } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import {
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsSectionTitle,
  SettingsRow,
  SettingsSaveBar,
  SettingsFormSkeleton,
} from '@/components/settings/SettingsSection'

interface FormState {
  webhookUrl: string
  baseUrl: string
  titleTemplate: string
  bodyTemplate: string
}

export function NotificationSettingsPage() {
  const { t } = useI18n()
  const { data: settings, isLoading } = useNotificationSettings()
  const updateSettings = useUpdateNotificationSettings()
  const testChannel = useTestNotificationChannel()
  const channelOptions = [
    { value: 'none', label: t('关闭') },
    { value: 'feishu', label: t('飞书 Webhook') },
  ]

  const [form, setForm] = useState<FormState>({
    webhookUrl: '',
    baseUrl: '',
    titleTemplate: '',
    bodyTemplate: '',
  })
  const [dirty, setDirty] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const testTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (settings && !dirty) {
      setForm({
        webhookUrl: settings.feishuWebhookUrl ?? '',
        baseUrl: settings.thirdPartyBaseUrl ?? '',
        titleTemplate: settings.taskInReviewTitleTemplate ?? '',
        bodyTemplate: settings.taskInReviewBodyTemplate ?? '',
      })
    }
  }, [settings, dirty])

  useEffect(() => {
    if (testChannel.isSuccess) {
      setTestStatus('success')
      testTimerRef.current = setTimeout(() => setTestStatus('idle'), 3000)
    } else if (testChannel.isError) {
      setTestStatus('error')
      testTimerRef.current = setTimeout(() => setTestStatus('idle'), 5000)
    }
    return () => clearTimeout(testTimerRef.current)
  }, [testChannel.isSuccess, testChannel.isError])

  if (isLoading) {
    return (
      <SettingsPageContainer>
        <SettingsFormSkeleton rows={3} />
      </SettingsPageContainer>
    )
  }

  const osEnabled = settings?.osNotificationEnabled ?? true
  const channel = settings?.thirdPartyChannel ?? 'none'

  const updateField = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
  }

  const handleOsToggle = (checked: boolean) => {
    updateSettings.mutate({ osNotificationEnabled: checked })
  }

  const handleChannelChange = (value: string) => {
    updateSettings.mutate({ thirdPartyChannel: value as 'none' | 'feishu' })
  }

  const handleSaveAll = () => {
    updateSettings.mutate(
      {
        feishuWebhookUrl: form.webhookUrl.trim() || null,
        thirdPartyBaseUrl: form.baseUrl.trim() || null,
        taskInReviewTitleTemplate: form.titleTemplate.trim() || 'Agent Tower',
        taskInReviewBodyTemplate: form.bodyTemplate.trim() || t('✅ "{taskTitle}" 已完成，等待审查'),
      },
      { onSuccess: () => setDirty(false) },
    )
  }

  const handleTest = () => {
    if (!form.webhookUrl.trim()) return
    testChannel.mutate({
      channel: 'feishu',
      webhookUrl: form.webhookUrl.trim(),
      baseUrl: form.baseUrl.trim() || undefined,
    })
  }

  return (
    <SettingsPageContainer>
      <SettingsPageHeader title={t('通知设置')} className="mb-1" />

      <div className="divide-y divide-border/60">
        {/* OS Notification */}
        <SettingsRow
          icon={Bell}
          label={t('桌面通知')}
          description={t('任务完成时弹出系统通知')}
          align="center"
          controlWidth="auto"
        >
          <Switch checked={osEnabled} onCheckedChange={handleOsToggle} aria-label={t('桌面通知')} />
        </SettingsRow>

        {/* Third-party channel */}
        <div className="py-5">
          <SettingsRow
            icon={MessageSquare}
            label={t('第三方通知')}
            description={t('推送到外部渠道（飞书群机器人等）')}
            align="center"
            className="py-0"
          >
            <Select
              value={channel}
              onChange={(v) => handleChannelChange(v)}
              options={channelOptions}
            />
          </SettingsRow>

          {channel === 'feishu' && (
            <div className="mt-4 space-y-4 sm:pl-11">
              <div>
                <label htmlFor="feishu-webhook-url" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Webhook URL
                </label>
                <div className="flex gap-2">
                  <Input
                    id="feishu-webhook-url"
                    value={form.webhookUrl}
                    onChange={(e) => updateField('webhookUrl', e.target.value)}
                    placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                    className="min-w-0 flex-1 font-mono"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleTest}
                    disabled={!form.webhookUrl.trim() || testChannel.isPending}
                    className="h-auto shrink-0"
                  >
                    {testChannel.isPending && <Loader2 size={12} className="mr-1 animate-spin motion-reduce:animate-none" />}
                    {t('测试')}
                  </Button>
                </div>
                {testStatus === 'success' && (
                  <div role="status" className="mt-2 flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle2 size={12} aria-hidden="true" />
                    {t('测试消息发送成功')}
                  </div>
                )}
                {testStatus === 'error' && (
                  <div role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle size={12} aria-hidden="true" />
                    {t('发送失败，请检查 Webhook 地址')}
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="feishu-base-url" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Link size={11} aria-hidden="true" />
                    {t('跳转地址')}
                  </span>
                </label>
                <Input
                  id="feishu-base-url"
                  value={form.baseUrl}
                  onChange={(e) => updateField('baseUrl', e.target.value)}
                  placeholder="http://localhost:5173"
                  className="font-mono"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('通知卡片中的"查看任务"按钮跳转地址前缀')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Template section */}
        <div className="py-5">
          <div className="mb-4">
            <SettingsSectionTitle>{t('通知模板')}</SettingsSectionTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('支持变量: {taskTitle}, {taskId}, {projectId}, {projectName}, {status}', {
                taskTitle: '{taskTitle}',
                taskId: '{taskId}',
                projectId: '{projectId}',
                projectName: '{projectName}',
                status: '{status}',
              })}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="notification-title-template" className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('标题')}</label>
              <Input
                id="notification-title-template"
                value={form.titleTemplate}
                onChange={(e) => updateField('titleTemplate', e.target.value)}
                placeholder="Agent Tower"
              />
            </div>
            <div>
              <label htmlFor="notification-body-template" className="mb-1.5 block text-xs font-medium text-muted-foreground">{t('内容')}</label>
              <Input
                id="notification-body-template"
                value={form.bodyTemplate}
                onChange={(e) => updateField('bodyTemplate', e.target.value)}
                placeholder={t('✅ "{taskTitle}" 已完成，等待审查')}
              />
            </div>
          </div>
        </div>
      </div>

      {dirty && (
        <SettingsSaveBar saving={updateSettings.isPending} onSave={handleSaveAll} />
      )}
    </SettingsPageContainer>
  )
}
