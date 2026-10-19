import type { WorkspaceBackgroundServiceDto } from '@agent-tower/shared'
import { Notice, Spinner } from '@/design-system'
import { useI18n } from '@/lib/i18n'

interface MergeActiveServicesNoticeProps {
  services: WorkspaceBackgroundServiceDto[]
  isLoading: boolean
  isError: boolean
}

export function MergeActiveServicesNotice({
  services,
  isLoading,
  isError,
}: MergeActiveServicesNoticeProps) {
  const { t } = useI18n()

  if (isLoading) {
    return <Spinner size="xs" label={t('正在检查后台服务...')} className="text-xs" />
  }

  if (services.length > 0) {
    return (
      <Notice tone="warning" title={t('合并前将停止 {count} 个后台服务', { count: services.length })}>
        <p className="break-all font-mono text-xs">
          {services.map(service => service.name).join(', ')}
        </p>
        <p className="mt-1">{t('停止后不会自动恢复。')}</p>
      </Notice>
    )
  }

  if (isError) {
    return (
      <p className="text-xs text-warning-ink" role="status">
        {t('无法检查后台服务状态，提交时会再次确认。')}
      </p>
    )
  }

  return null
}
