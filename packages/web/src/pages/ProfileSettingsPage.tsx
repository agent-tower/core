import { useState } from 'react'
import { useProfiles, useDefaultProfiles, useUpdateVariant, useDeleteVariant } from '@/hooks/use-profiles'
import type { VariantConfig } from '@/hooks/use-profiles'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Plus, Pencil, Trash2, ChevronDown } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { SettingsPageContainer } from '@/components/settings/SettingsSection'

function configSummary(config: VariantConfig): string {
  const entries = Object.entries(config)
  if (entries.length === 0) return '(empty)'
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')
}

const AGENT_LABELS: Record<string, string> = {
  CLAUDE_CODE: 'Claude Code',
  GEMINI_CLI: 'Gemini CLI',
  CURSOR_AGENT: 'Cursor Agent',
}

function AgentTypeGroup({
  agentType,
  variants,
  isBuiltIn,
  onEdit,
  onNew,
  onDelete,
}: {
  agentType: string
  variants: Record<string, VariantConfig>
  isBuiltIn: (variant: string) => boolean
  onEdit: (variant: string, config: VariantConfig) => void
  onNew: () => void
  onDelete: (variant: string) => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  const variantEntries = Object.entries(variants)

  return (
    <div className="rounded-lg border border-neutral-200 overflow-hidden">
      {/* Group header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-neutral-50/60">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
        >
          <h3 className="text-[13px] font-semibold text-neutral-900">
            {AGENT_LABELS[agentType] ?? agentType}
          </h3>
          <span className="text-[11px] text-neutral-400">
            {variantEntries.length} {t('个变体')}
          </span>
          <ChevronDown size={14} className={cn('text-neutral-400 transition-transform', expanded && 'rotate-180')} />
        </button>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-900 hover:bg-white transition-colors"
        >
          <Plus size={12} />
          {t('新增')}
        </button>
      </div>

      {/* Variant rows */}
      {expanded && (
        <div className="divide-y divide-neutral-100">
          {variantEntries.map(([variant, config]) => {
            const builtIn = isBuiltIn(variant)
            return (
              <div
                key={variant}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-50/50 transition-colors"
              >
                <span className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide shrink-0',
                  variant === 'DEFAULT' ? 'bg-blue-50 text-blue-600' : 'bg-neutral-100 text-neutral-600',
                )}>
                  {variant}
                </span>

                <span className="flex-1 min-w-0 text-[12px] text-neutral-400 font-mono truncate">
                  {configSummary(config)}
                </span>

                {builtIn && (
                  <span className="shrink-0 text-[10px] text-neutral-300 font-medium">{t('内置')}</span>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => onEdit(variant, config)}
                    className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
                    title={t('编辑')}
                  >
                    <Pencil size={12} />
                  </button>
                  {!builtIn && (
                    <button
                      onClick={() => onDelete(variant)}
                      className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      title={t('删除')}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {variantEntries.length === 0 && (
            <div className="px-4 py-4 text-center text-[12px] text-neutral-400">
              {t('暂无变体')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ProfileSettingsPage() {
  const { t } = useI18n()
  const { data: profiles, isLoading } = useProfiles()
  const { data: defaults } = useDefaultProfiles()
  const updateVariant = useUpdateVariant()
  const deleteVariant = useDeleteVariant()

  const [editModal, setEditModal] = useState<{
    agentType: string; variant: string; config: VariantConfig; isNew: boolean
  } | null>(null)
  const [editJson, setEditJson] = useState('')
  const [editVariantName, setEditVariantName] = useState('')
  const [jsonError, setJsonError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ agentType: string; variant: string } | null>(null)

  const openEdit = (agentType: string, variant: string, config: VariantConfig) => {
    setEditModal({ agentType, variant, config, isNew: false })
    setEditVariantName(variant)
    setEditJson(JSON.stringify(config, null, 2))
    setJsonError('')
  }

  const openNew = (agentType: string) => {
    setEditModal({ agentType, variant: '', config: {}, isNew: true })
    setEditVariantName('')
    setEditJson('{\n  \n}')
    setJsonError('')
  }

  const handleSave = () => {
    if (!editModal || !editVariantName.trim()) return
    try {
      const config = JSON.parse(editJson)
      setJsonError('')
      updateVariant.mutate(
        { agentType: editModal.agentType, variant: editVariantName.trim().toUpperCase(), config },
        { onSuccess: () => setEditModal(null) }
      )
    } catch {
      setJsonError(t('JSON 格式错误'))
    }
  }

  const handleDelete = (agentType: string, variant: string) => {
    setDeleteTarget({ agentType, variant })
  }

  const handleConfirmDelete = () => {
    if (!deleteTarget) return
    deleteVariant.mutate(
      { agentType: deleteTarget.agentType, variant: deleteTarget.variant },
      { onSettled: () => setDeleteTarget(null) }
    )
  }

  const isBuiltIn = (agentType: string, variant: string): boolean => {
    return !!defaults?.executors[agentType]?.[variant]
  }

  if (isLoading) {
    return (
      <SettingsPageContainer>
        <div className="flex items-center justify-center py-20">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
        </div>
      </SettingsPageContainer>
    )
  }

  const executors = profiles?.executors ?? {}

  return (
    <SettingsPageContainer>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-neutral-900">{t('Profile 配置')}</h2>
        <p className="mt-0.5 text-[12px] text-neutral-500">{t('管理 Agent 执行器的配置变体。每个变体定义一组运行参数。')}</p>
      </div>

      <div className="space-y-3">
        {Object.entries(executors).map(([agentType, variants]) => (
          <AgentTypeGroup
            key={agentType}
            agentType={agentType}
            variants={variants}
            isBuiltIn={(variant) => isBuiltIn(agentType, variant)}
            onEdit={(variant, config) => openEdit(agentType, variant, config)}
            onNew={() => openNew(agentType)}
            onDelete={(variant) => handleDelete(agentType, variant)}
          />
        ))}
      </div>

      {Object.keys(executors).length === 0 && (
        <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/50 py-12 text-center">
          <p className="text-sm text-neutral-400">{t('暂无 Profile 配置')}</p>
        </div>
      )}

      <Modal
        isOpen={!!editModal}
        onClose={() => setEditModal(null)}
        title={editModal?.isNew
          ? t('新增 Variant — {agentType}', { agentType: AGENT_LABELS[editModal.agentType] ?? editModal.agentType })
          : t('编辑 {variant}', { variant: editModal?.variant ?? '' })}
        action={
          <>
            <Button variant="outline" onClick={() => setEditModal(null)}>{t('取消')}</Button>
            <Button onClick={handleSave} disabled={updateVariant.isPending}>
              {updateVariant.isPending ? t('保存中...') : t('保存')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 mb-1">{t('Variant 名称')}</label>
            <input
              type="text"
              value={editVariantName}
              onChange={e => setEditVariantName(e.target.value)}
              disabled={!editModal?.isNew}
              placeholder={t('例如: CUSTOM')}
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-mono transition-colors focus:border-neutral-400 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-500"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 mb-1">{t('配置 (JSON)')}</label>
            <textarea
              value={editJson}
              onChange={e => { setEditJson(e.target.value); setJsonError('') }}
              rows={6}
              className="w-full rounded-lg border border-neutral-200 bg-neutral-50/50 px-3 py-2 text-sm font-mono transition-colors focus:border-neutral-400 focus:bg-white focus:outline-none resize-none"
            />
            {jsonError && <p className="mt-1 text-xs text-red-500">{jsonError}</p>}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => { if (!deleteVariant.isPending) setDeleteTarget(null) }}
        onConfirm={handleConfirmDelete}
        title={t('删除 Profile Variant')}
        description={deleteTarget
          ? t('确定删除 "{name}"？此操作不可撤销。', { name: `${AGENT_LABELS[deleteTarget.agentType] ?? deleteTarget.agentType} / ${deleteTarget.variant}` })
          : ''}
        confirmText={t('删除')}
        cancelText={t('取消')}
        variant="danger"
        isLoading={deleteVariant.isPending}
      />
    </SettingsPageContainer>
  )
}
