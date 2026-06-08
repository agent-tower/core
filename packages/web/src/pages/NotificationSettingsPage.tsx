import { useState, useEffect, useRef } from 'react'
import {
  useNotificationSettings,
  useUpdateNotificationSettings,
  useTestNotificationChannel,
} from '@/hooks/use-notifications'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { CheckCircle2, AlertCircle, Loader2, Link, Bell, MessageSquare } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { SettingsPageContainer } from '@/components/settings/SettingsSection'

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
        <div className="flex items-center justify-center py-20">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
        </div>
      </SettingsPageContainer>
    )
  }

  const osEnabled = settings?.osNotificationEnabled ?? true
  const channel = settings?.thirdPartyChannel ?? 'none'

  const updateField = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
  }

  const handleOsToggle = () => {
    updateSettings.mutate({ osNotificationEnabled: !osEnabled })
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
      <h2 className="text-base font-semibold text-neutral-900 mb-1">{t('通知设置')}</h2>

      {/* OS Notification - simple toggle row */}
      <div className="flex items-center justify-between py-5 border-b border-neutral-100">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600">
            <Bell size={15} />
          </div>
          <div>
            <div className="text-[13px] font-medium text-neutral-900">{t('桌面通知')}</div>
            <div className="text-[12px] text-neutral-500">{t('任务完成时弹出系统通知')}</div>
          </div>
        </div>
        <button
          onClick={handleOsToggle}
          className={cn(
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
            osEnabled ? 'bg-neutral-900' : 'bg-neutral-200',
          )}
        >
          <span className={cn(
            'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
            osEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
          )} />
        </button>
      </div>

      {/* Third-party channel */}
      <div className="py-5 border-b border-neutral-100">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600">
            <MessageSquare size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-neutral-900">{t('第三方通知')}</div>
            <div className="text-[12px] text-neutral-500">{t('推送到外部渠道（飞书群机器人等）')}</div>
          </div>
          <div className="shrink-0 w-[160px]">
            <Select
              value={channel}
              onChange={(v) => handleChannelChange(v)}
              options={channelOptions}
            />
          </div>
        </div>

        {channel === 'feishu' && (
          <div className="ml-11 space-y-4">
            <div>
              <label className="block text-[12px] font-medium text-neutral-600 mb-1.5">
                Webhook URL
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.webhookUrl}
                  onChange={(e) => updateField('webhookUrl', e.target.value)}
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                  className="flex-1 min-w-0 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-mono transition-colors focus:border-neutral-400 focus:outline-none"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTest}
                  disabled={!form.webhookUrl.trim() || testChannel.isPending}
                  className="shrink-0"
                >
                  {testChannel.isPending && <Loader2 size={12} className="animate-spin mr-1" />}
                  {t('测试')}
                </Button>
              </div>
              {testStatus === 'success' && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-emerald-600">
                  <CheckCircle2 size={12} />
                  {t('测试消息发送成功')}
                </div>
              )}
              {testStatus === 'error' && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-red-500">
                  <AlertCircle size={12} />
                  {t('发送失败，请检查 Webhook 地址')}
                </div>
              )}
            </div>

            <div>
              <label className="block text-[12px] font-medium text-neutral-600 mb-1.5">
                <span className="flex items-center gap-1.5">
                  <Link size={11} className="text-neutral-400" />
                  {t('跳转地址')}
                </span>
              </label>
              <input
                type="text"
                value={form.baseUrl}
                onChange={(e) => updateField('baseUrl', e.target.value)}
                placeholder="http://localhost:5173"
                className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-mono transition-colors focus:border-neutral-400 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-neutral-400">
                {t('通知卡片中的"查看任务"按钮跳转地址前缀')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Template section */}
      <div className="py-5">
        <div className="mb-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">{t('通知模板')}</h3>
          <p className="mt-1 text-[11px] text-neutral-400">
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
            <label className="block text-[12px] font-medium text-neutral-600 mb-1.5">{t('标题')}</label>
            <input
              type="text"
              value={form.titleTemplate}
              onChange={(e) => updateField('titleTemplate', e.target.value)}
              placeholder="Agent Tower"
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm transition-colors focus:border-neutral-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-neutral-600 mb-1.5">{t('内容')}</label>
            <input
              type="text"
              value={form.bodyTemplate}
              onChange={(e) => updateField('bodyTemplate', e.target.value)}
              placeholder={t('✅ "{taskTitle}" 已完成，等待审查')}
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm transition-colors focus:border-neutral-400 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {dirty && (
        <div className="sticky bottom-0 -mx-5 sm:-mx-8 px-5 sm:px-8 py-3 bg-white/90 backdrop-blur border-t border-neutral-100">
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-500">{t('有未保存的更改')}</span>
            <Button
              size="sm"
              onClick={handleSaveAll}
              disabled={updateSettings.isPending}
            >
              {updateSettings.isPending ? t('保存中...') : t('保存')}
            </Button>
          </div>
        </div>
      )}
    </SettingsPageContainer>
  )
}
