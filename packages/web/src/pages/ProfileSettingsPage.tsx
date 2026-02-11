import { useState } from 'react'
import { useProfiles, useDefaultProfiles, useUpdateVariant, useDeleteVariant } from '@/hooks/use-profiles'
import type { VariantConfig } from '@/hooks/use-profiles'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Plus, Pencil, Trash2 } from 'lucide-react'

function configSummary(config: VariantConfig): string {
  return Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(', ')
}

const AGENT_LABELS: Record<string, string> = {
  CLAUDE_CODE: 'Claude Code',
  GEMINI_CLI: 'Gemini CLI',
  CURSOR_AGENT: 'Cursor Agent',
}

export function ProfileSettingsPage() {
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
      setJsonError('JSON 格式错误')
    }
  }

  const handleDelete = (agentType: string, variant: string) => {
    if (!confirm(`确定删除 ${agentType} / ${variant}？`)) return
    deleteVariant.mutate({ agentType, variant })
  }

  const isBuiltIn = (agentType: string, variant: string): boolean => {
    return !!defaults?.executors[agentType]?.[variant]
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-neutral-400">加载中...</div>
  }

  const executors = profiles?.executors ?? {}

  return (
    <div className="px-10 py-6 mx-auto w-full max-w-3xl">
      {Object.entries(executors).map(([agentType, variants]) => (
        <div key={agentType} className="mb-6">
          {/* Agent header */}
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[13px] font-semibold text-neutral-900">
              {AGENT_LABELS[agentType] ?? agentType}
            </h3>
            <button
              onClick={() => openNew(agentType)}
              className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-900 transition-colors"
            >
              <Plus size={12} />
              <span>新增</span>
            </button>
          </div>

          {/* Variant rows */}
          <div className="border border-neutral-100 rounded-lg overflow-hidden">
            {Object.entries(variants).map(([variant, config], idx, arr) => {
              const builtIn = isBuiltIn(agentType, variant)
              return (
                <div
                  key={variant}
                  className={`flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-50 transition-colors group ${
                    idx < arr.length - 1 ? 'border-b border-neutral-100' : ''
                  }`}
                >
                  {/* Badge */}
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide ${
                    variant === 'DEFAULT'
                      ? 'bg-blue-50 text-blue-600'
                      : 'bg-neutral-50 text-neutral-600'
                  }`}>
                    {variant}
                  </span>

                  {/* Config */}
                  <span className="flex-1 text-[12px] text-neutral-400 font-mono truncate">
                    {configSummary(config)}
                  </span>

                  {/* Built-in indicator */}
                  {builtIn && (
                    <span className="text-[11px] text-neutral-300 font-medium">内置</span>
                  )}

                  {/* Actions — visible on hover */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => openEdit(agentType, variant, config)}
                      className="p-1 text-neutral-300 hover:text-neutral-700 rounded transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                    {!builtIn && (
                      <button
                        onClick={() => handleDelete(agentType, variant)}
                        className="p-1 text-neutral-300 hover:text-red-500 rounded transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {/* Edit Modal */}
      <Modal
        isOpen={!!editModal}
        onClose={() => setEditModal(null)}
        title={editModal?.isNew ? `新增 Variant — ${AGENT_LABELS[editModal.agentType] ?? editModal.agentType}` : `编辑 ${editModal?.variant}`}
        action={
          <>
            <Button variant="outline" onClick={() => setEditModal(null)}>取消</Button>
            <Button onClick={handleSave} disabled={updateVariant.isPending}>
              {updateVariant.isPending ? '保存中...' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 mb-1">Variant 名称</label>
            <input
              type="text"
              value={editVariantName}
              onChange={e => setEditVariantName(e.target.value)}
              disabled={!editModal?.isNew}
              placeholder="例如: CUSTOM"
              className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-neutral-300 disabled:bg-neutral-50 disabled:text-neutral-500 font-mono"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-neutral-700 mb-1">配置 (JSON)</label>
            <textarea
              value={editJson}
              onChange={e => { setEditJson(e.target.value); setJsonError('') }}
              rows={6}
              className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-neutral-300 resize-none"
            />
            {jsonError && <p className="mt-1 text-xs text-red-500">{jsonError}</p>}
          </div>
        </div>
      </Modal>
    </div>
  )
}
