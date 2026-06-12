import { useState } from 'react'
import { useProfiles, useDefaultProfiles, useUpdateVariant, useDeleteVariant } from '@/hooks/use-profiles'
import type { VariantConfig } from '@/hooks/use-profiles'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Plus, Pencil, Trash2, ChevronDown, Layers } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsField,
  SettingsEmptyState,
} from '@/components/settings/SettingsSection'

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
    <div className="overflow-hidden rounded-lg border border-border">
      {/* Group header */}
      <div className="flex items-center justify-between gap-3 bg-muted/40 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-3 rounded-md transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <h3 className="text-[13px] font-semibold text-foreground">
            {AGENT_LABELS[agentType] ?? agentType}
          </h3>
          <span className="text-[11px] text-muted-foreground">
            {variantEntries.length} {t('个变体')}
          </span>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn('text-muted-foreground transition-transform motion-reduce:transition-none', expanded && 'rotate-180')}
          />
        </button>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Plus size={12} aria-hidden="true" />
          {t('新增')}
        </button>
      </div>

      {/* Variant rows */}
      {expanded && (
        <div className="divide-y divide-border/60">
          {variantEntries.map(([variant, config]) => {
            const builtIn = isBuiltIn(variant)
            return (
              <div
                key={variant}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
              >
                <span className={cn(
                  'inline-flex shrink-0 items-center rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide',
                  variant === 'DEFAULT' ? 'bg-primary/[0.06] text-primary' : 'bg-muted text-muted-foreground',
                )}>
                  {variant}
                </span>

                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {configSummary(config)}
                </span>

                {builtIn && (
                  <span className="shrink-0 text-[10px] font-medium text-muted-foreground/70">{t('内置')}</span>
                )}

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => onEdit(variant, config)}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    title={t('编辑')}
                    aria-label={t('编辑')}
                  >
                    <Pencil size={12} />
                  </button>
                  {!builtIn && (
                    <button
                      onClick={() => onDelete(variant)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                      title={t('删除')}
                      aria-label={t('删除')}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {variantEntries.length === 0 && (
            <div className="px-4 py-4 text-center text-xs text-muted-foreground">
              {t('暂无变体')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ProfileSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="h-7 w-36" />
      <Skeleton className="mt-2 h-3.5 w-72 max-w-full" />
      <div className="mt-5 space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-center gap-3 bg-muted/40 px-4 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-14" />
            </div>
            <div className="divide-y divide-border/60">
              {Array.from({ length: 2 }).map((_, j) => (
                <div key={j} className="flex items-center gap-3 px-4 py-2.5">
                  <Skeleton className="h-5 w-16 rounded" />
                  <Skeleton className="h-3.5 flex-1" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
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
        <ProfileSkeleton />
      </SettingsPageContainer>
    )
  }

  const executors = profiles?.executors ?? {}

  return (
    <SettingsPageContainer>
      <SettingsPageHeader
        title={t('Profile 配置')}
        description={t('管理 Agent 执行器的配置变体。每个变体定义一组运行参数。')}
        className="mb-4"
      />

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
        <SettingsEmptyState icon={Layers} message={t('暂无 Profile 配置')} />
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
          <SettingsField label={t('Variant 名称')} htmlFor="profile-variant-name">
            <Input
              id="profile-variant-name"
              value={editVariantName}
              onChange={e => setEditVariantName(e.target.value)}
              disabled={!editModal?.isNew}
              placeholder={t('例如: CUSTOM')}
              className="font-mono"
            />
          </SettingsField>
          <SettingsField label={t('配置 (JSON)')} htmlFor="profile-variant-json">
            <Textarea
              id="profile-variant-json"
              value={editJson}
              onChange={e => { setEditJson(e.target.value); setJsonError('') }}
              rows={6}
              className="resize-none font-mono"
              aria-invalid={!!jsonError}
            />
            {jsonError && <p role="alert" className="mt-1 text-xs text-destructive">{jsonError}</p>}
          </SettingsField>
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
