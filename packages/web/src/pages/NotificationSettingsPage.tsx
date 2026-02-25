import { useState, useEffect, useRef } from 'react'
import {
  useNotificationSettings,
  useUpdateNotificationSettings,
  useTestNotificationChannel,
} from '@/hooks/use-notifications'
import { Button } from '@/components/ui/button'
import { CheckCircle2, AlertCircle, Loader2, Link } from 'lucide-react'

const CHANNEL_OPTIONS = [
  { value: 'none', label: '无' },
  { value: 'feishu', label: '飞书' },
] as const

interface FormState {
  webhookUrl: string
  baseUrl: string
  titleTemplate: string
  bodyTemplate: string
}

export function NotificationSettingsPage() {
  const { data: settings, isLoading } = useNotificationSettings()
  const updateSettings = useUpdateNotificationSettings()
  const testChannel = useTestNotificationChannel()

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

  // 测试状态自动清除
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
    return <div className="p-6 text-sm text-neutral-400">加载中...</div>
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
        taskInReviewBodyTemplate: form.bodyTemplate.trim() || '✅ "{taskTitle}" 已完成，等待审查',
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
    <div className="px-10 py-6 mx-auto w-full max-w-3xl space-y-8">
      {/* 系统通知 */}
      <section>
        <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">系统通知</h3>
        <p className="text-[12px] text-neutral-400 mb-3">任务完成时弹出桌面通知</p>
        <button
          onClick={handleOsToggle}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            osEnabled ? 'bg-neutral-900' : 'bg-neutral-200'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              osEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </section>

      {/* 第三方通知 */}
      <section>
        <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">第三方通知</h3>
        <p className="text-[12px] text-neutral-400 mb-3">选择一个第三方渠道接收通知</p>

        <select
          value={channel}
          onChange={(e) => handleChannelChange(e.target.value)}
          className="px-3 py-1.5 border border-neutral-200 rounded-lg text-sm text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-300 bg-white"
        >
          {CHANNEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* 飞书配置 */}
        {channel === 'feishu' && (
          <div className="mt-4 space-y-4">
            {/* Webhook URL */}
            <div className="p-4 border border-neutral-100 rounded-lg space-y-3">
              <div>
                <label className="flex items-center gap-1 text-[13px] font-medium text-neutral-700 mb-1">
                  <Link size={12} />
                  Webhook URL
                </label>
                <input
                  type="text"
                  value={form.webhookUrl}
                  onChange={(e) => updateField('webhookUrl', e.target.value)}
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-neutral-300"
                />
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTest}
                  disabled={!form.webhookUrl.trim() || testChannel.isPending}
                >
                  {testChannel.isPending && <Loader2 size={12} className="animate-spin mr-1" />}
                  测试发送
                </Button>

                {testStatus === 'success' && (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <CheckCircle2 size={12} />
                    发送成功
                  </span>
                )}
                {testStatus === 'error' && (
                  <span className="flex items-center gap-1 text-xs text-red-500">
                    <AlertCircle size={12} />
                    发送失败
                  </span>
                )}
              </div>
            </div>

            {/* 跳转地址 */}
            <div className="p-4 border border-neutral-100 rounded-lg space-y-3">
              <div>
                <label className="block text-[13px] font-medium text-neutral-700 mb-1">
                  跳转地址（用于生成任务链接）
                </label>
                <input
                  type="text"
                  value={form.baseUrl}
                  onChange={(e) => updateField('baseUrl', e.target.value)}
                  placeholder="http://localhost:5173"
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-neutral-300"
                />
                <p className="text-[11px] text-neutral-400 mt-1">
                  通知卡片中的"查看任务"按钮将跳转到 {"{baseUrl}/projects/{projectId}/tasks/{taskId}"}
                </p>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 通知模板 */}
      <section>
        <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">通知模板</h3>
        <p className="text-[12px] text-neutral-400 mb-3">
          支持变量: {"{taskTitle}"}, {"{taskId}"}, {"{projectId}"}, {"{projectName}"}, {"{status}"}
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 mb-1">
              标题模板
            </label>
            <input
              type="text"
              value={form.titleTemplate}
              onChange={(e) => updateField('titleTemplate', e.target.value)}
              placeholder="Agent Tower"
              className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-neutral-300"
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-neutral-700 mb-1">
              内容模板
            </label>
            <textarea
              value={form.bodyTemplate}
              onChange={(e) => updateField('bodyTemplate', e.target.value)}
              placeholder='✅ "{taskTitle}" 已完成，等待审查'
              rows={2}
              className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-neutral-300 resize-none"
            />
          </div>
        </div>
      </section>

      {/* 统一保存按钮 */}
      {dirty && (
        <div className="sticky bottom-6 flex justify-end">
          <Button
            size="sm"
            onClick={handleSaveAll}
            disabled={updateSettings.isPending}
          >
            {updateSettings.isPending ? '保存中...' : '保存所有更改'}
          </Button>
        </div>
      )}
    </div>
  )
}
