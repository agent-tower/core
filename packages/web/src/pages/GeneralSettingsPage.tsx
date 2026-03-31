import { Select } from '@/components/ui/select'
import { useI18n } from '@/lib/i18n'
import type { AppLocale } from '@agent-tower/shared'

const LANGUAGE_OPTIONS: Array<{ value: AppLocale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

export function GeneralSettingsPage() {
  const { locale, setLocale, t } = useI18n()

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
    </div>
  )
}
