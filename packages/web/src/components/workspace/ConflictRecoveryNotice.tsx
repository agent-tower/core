import type { ConflictDetails } from './GitOperationsDialog'
import { useEffect, useState } from 'react'
import type { useConflictRecovery } from '@/hooks/use-conflict-recovery'
import { removeConflictRecovery } from '@/lib/conflict-recovery-storage'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'

export function ConflictRecoveryNotice({ recovery, onRecover }: { recovery: ReturnType<typeof useConflictRecovery>; onRecover: (details: ConflictDetails) => void }) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const { drafts, storageUnavailable, identityError } = recovery
  return <div className="space-y-2 px-4 text-sm">
    {storageUnavailable && <p role="alert">{t('浏览器存储不可用或资料损坏；本页仅在内存中保留，刷新后可能无法恢复。请先保存操作资料。')}</p>}
    {identityError && <p role="alert">{t('无法确认当前身份，暂不展示已保存的冲突资料。')}</p>}
    {drafts.map(draft => <div key={draft.operationId} className="rounded border p-2 space-y-1">
      <p>{t('已保留原冲突资料；关闭弹窗后可在此重新打开。仅当前身份和本标签页可恢复，关闭标签页或清理浏览器数据会删除资料。')}</p>
      <p>{draft.expiresAt && draft.expiresAt <= now ? t('恢复证明已过期；保留成果，在实际目标手工继续，或确认后明确中止并重做。已提交但结果未知的请求仍可核对原 UUID。') : `${t('恢复截止时间')}：${draft.expiresAt ? new Date(draft.expiresAt).toLocaleString() : t('未知')}`}</p>
      <Button variant="outline" onClick={() => onRecover(draft.details)}>{t('恢复上次冲突资料')}</Button>
      <Button variant="ghost" onClick={() => removeConflictRecovery(draft.details.resolutionContextToken)}>{t('清理本地操作资料')}</Button>
      <p className="text-xs text-muted-foreground">{t('清理不会取消服务端已受理请求；结果未知时请先核对原提交。')}</p>
    </div>)}
  </div>
}
