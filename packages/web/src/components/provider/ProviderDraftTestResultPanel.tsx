import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { ProviderDraftTestResult } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export function getPublicProviderTestEndpoint(endpoint: string | undefined): string | null {
  if (!endpoint) return null
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

function formatTestedAt(testedAt: string | undefined, locale: string): string | null {
  if (!testedAt) return null
  const date = new Date(testedAt)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)
}

export function ProviderDraftTestResultPanel({ result }: { result: ProviderDraftTestResult }) {
  const { locale, t } = useI18n()
  const endpoint = getPublicProviderTestEndpoint(result.target?.endpoint)
  const testedAt = formatTestedAt(result.testedAt, locale)

  return (
    <div
      data-provider-test-result
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        result.ok ? 'border-success/30 bg-success/10 text-success-ink' : 'border-warning/30 bg-warning/10 text-foreground',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {result.ok
          ? <CheckCircle2 size={16} className="shrink-0" />
          : <AlertTriangle size={16} className="shrink-0 text-warning" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{result.ok
            ? result.stage === 'connection' ? t('连接测试通过') : t('本机可用性检查通过')
            : t('配置检查未通过')}</div>
          <div className="mt-0.5 break-words text-xs opacity-80">{result.summary}</div>
          {(endpoint || testedAt) && (
            <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs opacity-80">
              {endpoint && (
                <>
                  <dt className="font-medium">{t('测试对象')}</dt>
                  <dd className="min-w-0"><code className="break-all">{endpoint}</code></dd>
                </>
              )}
              {testedAt && (
                <>
                  <dt className="font-medium">{t('测试时间')}</dt>
                  <dd className="min-w-0 break-words">
                    <time dateTime={result.testedAt}>{testedAt}</time>
                  </dd>
                </>
              )}
            </dl>
          )}
          {!result.ok && <div className="mt-1 text-xs opacity-80">{t('测试失败不会阻止保存。')}</div>}
        </div>
      </div>
    </div>
  )
}
