import { useState } from 'react'
import { useProviders, useCreateProvider, useUpdateProvider, useDeleteProvider } from '@/hooks/use-providers'
import type { CreateProviderInput, UpdateProviderInput } from '@/hooks/use-providers'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Plus, Pencil, Trash2, CheckCircle2, XCircle } from 'lucide-react'
import { AgentType } from '@agent-tower/shared'

const AGENT_TYPE_LABELS: Record<string, string> = {
  CLAUDE_CODE: 'Claude Code',
  GEMINI_CLI: 'Gemini CLI',
  CURSOR_AGENT: 'Cursor Agent',
  CODEX: 'Codex',
}

function AvailabilityBadge({ type }: { type: string }) {
  if (type === 'LOGIN_DETECTED' || type === 'INSTALLATION_FOUND') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-green-700 bg-green-50 rounded">
        <CheckCircle2 size={12} />
        可用
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-neutral-500 bg-neutral-50 rounded">
      <XCircle size={12} />
      不可用
    </span>
  )
}

interface ProviderFormData {
  name: string
  agentType: AgentType
  env: Array<{ key: string; value: string }>
  config: string // JSON string
  isDefault: boolean
}

function ProviderFormModal({
  isOpen,
  onClose,
  initialData,
  onSave,
}: {
  isOpen: boolean
  onClose: () => void
  initialData?: ProviderFormData
  onSave: (data: CreateProviderInput | UpdateProviderInput) => void
}) {
  const [formData, setFormData] = useState<ProviderFormData>(
    initialData ?? {
      name: '',
      agentType: AgentType.CLAUDE_CODE,
      env: [{ key: '', value: '' }],
      config: '{}',
      isDefault: false,
    }
  )
  const [configError, setConfigError] = useState('')

  const handleAddEnv = () => {
    setFormData(prev => ({ ...prev, env: [...prev.env, { key: '', value: '' }] }))
  }

  const handleRemoveEnv = (index: number) => {
    setFormData(prev => ({ ...prev, env: prev.env.filter((_, i) => i !== index) }))
  }

  const handleEnvChange = (index: number, field: 'key' | 'value', value: string) => {
    setFormData(prev => ({
      ...prev,
      env: prev.env.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    }))
  }

  const handleSave = () => {
    try {
      const config = JSON.parse(formData.config)
      setConfigError('')

      const env: Record<string, string> = {}
      formData.env.forEach(({ key, value }) => {
        if (key.trim()) env[key.trim()] = value
      })

      const data = {
        name: formData.name,
        agentType: formData.agentType,
        env,
        config,
        isDefault: formData.isDefault,
      }

      onSave(data)
    } catch {
      setConfigError('Config JSON 格式错误')
    }
  }

  if (!isOpen) return null

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={initialData ? '编辑 Provider' : '新建 Provider'}>
      <div className="space-y-4">
        {/* Name */}
        <div>
          <label className="block text-xs font-medium text-neutral-700 mb-1">名称</label>
          <input
            type="text"
            value={formData.name}
            onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
            className="w-full px-3 py-2 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
            placeholder="例如: Claude Code (官方)"
          />
        </div>

        {/* Agent Type */}
        {!initialData && (
          <div>
            <label className="block text-xs font-medium text-neutral-700 mb-1">Agent 类型</label>
            <select
              value={formData.agentType}
              onChange={e => setFormData(prev => ({ ...prev, agentType: e.target.value as AgentType }))}
              className="w-full px-3 py-2 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
            >
              {Object.values(AgentType).map(type => (
                <option key={type} value={type}>
                  {AGENT_TYPE_LABELS[type] ?? type}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Environment Variables */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-neutral-700">环境变量</label>
            <button
              onClick={handleAddEnv}
              className="text-xs text-neutral-500 hover:text-neutral-900"
            >
              + 添加
            </button>
          </div>
          <div className="space-y-2">
            {formData.env.map((item, index) => (
              <div key={index} className="flex gap-2">
                <input
                  type="text"
                  value={item.key}
                  onChange={e => handleEnvChange(index, 'key', e.target.value)}
                  placeholder="KEY"
                  className="flex-1 px-3 py-2 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
                />
                <input
                  type="text"
                  value={item.value}
                  onChange={e => handleEnvChange(index, 'value', e.target.value)}
                  placeholder="value"
                  className="flex-[2] px-3 py-2 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
                />
                <button
                  onClick={() => handleRemoveEnv(index)}
                  className="px-2 text-neutral-400 hover:text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            例如: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL
          </p>
        </div>

        {/* Config JSON */}
        <div>
          <label className="block text-xs font-medium text-neutral-700 mb-1">运行参数 (JSON)</label>
          <textarea
            value={formData.config}
            onChange={e => setFormData(prev => ({ ...prev, config: e.target.value }))}
            rows={6}
            className="w-full px-3 py-2 text-sm font-mono border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
            placeholder='{"dangerouslySkipPermissions": true, "model": "claude-sonnet-4-20250514"}'
          />
          {configError && (
            <p className="mt-1 text-xs text-red-600">{configError}</p>
          )}
          <p className="mt-1 text-xs text-neutral-500">
            例如: dangerouslySkipPermissions, model, plan 等
          </p>
        </div>

        {/* Is Default */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="isDefault"
            checked={formData.isDefault}
            onChange={e => setFormData(prev => ({ ...prev, isDefault: e.target.checked }))}
            className="w-4 h-4"
          />
          <label htmlFor="isDefault" className="text-sm text-neutral-700">
            设为该类型的默认 Provider
          </label>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!formData.name.trim()}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function ProviderSettingsPage() {
  const { data: providersData, isLoading } = useProviders()
  const createProvider = useCreateProvider()
  const updateProvider = useUpdateProvider()
  const deleteProvider = useDeleteProvider()

  const [editModal, setEditModal] = useState<{ id?: string; data?: ProviderFormData } | null>(null)

  const handleCreate = (data: CreateProviderInput) => {
    createProvider.mutate(data, {
      onSuccess: () => setEditModal(null),
    })
  }

  const handleUpdate = (id: string, data: UpdateProviderInput) => {
    updateProvider.mutate({ id, data }, {
      onSuccess: () => setEditModal(null),
    })
  }

  const handleDelete = (id: string, name: string, builtIn?: boolean) => {
    if (builtIn) {
      alert('内置 Provider 不可删除')
      return
    }
    if (!confirm(`确定删除 "${name}"？`)) return
    deleteProvider.mutate(id)
  }

  const openEdit = (provider: any) => {
    const envArray = Object.entries(provider.provider.env).map(([key, value]) => ({
      key,
      value: value as string,
    }))
    setEditModal({
      id: provider.provider.id,
      data: {
        name: provider.provider.name,
        agentType: provider.provider.agentType as AgentType,
        env: envArray.length > 0 ? envArray : [{ key: '', value: '' }],
        config: JSON.stringify(provider.provider.config, null, 2),
        isDefault: provider.provider.isDefault,
      },
    })
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-neutral-400">加载中...</div>
  }

  const providers = providersData ?? []

  return (
    <div className="px-10 py-6 mx-auto w-full max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">Provider 配置</h2>
          <p className="text-sm text-neutral-500 mt-1">
            管理 AI Agent 的连接配置和运行参数
          </p>
        </div>
        <Button onClick={() => setEditModal({})}>
          <Plus size={14} className="mr-1" />
          新建 Provider
        </Button>
      </div>

      {providers.length === 0 ? (
        <div className="text-center py-12 text-sm text-neutral-400">
          暂无 Provider 配置
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map(item => {
            const provider = item.provider
            const availability = item.availability
            return (
              <div
                key={provider.id}
                className="border border-neutral-200 rounded-lg p-4 hover:border-neutral-300 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-medium text-neutral-900">{provider.name}</h3>
                      <AvailabilityBadge type={availability.type} />
                      {provider.isDefault && (
                        <span className="px-2 py-0.5 text-xs text-blue-700 bg-blue-50 rounded">
                          默认
                        </span>
                      )}
                      {provider.builtIn && (
                        <span className="px-2 py-0.5 text-xs text-neutral-500 bg-neutral-50 rounded">
                          内置
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-neutral-500 mb-2">
                      {AGENT_TYPE_LABELS[provider.agentType] ?? provider.agentType}
                    </p>
                    {Object.keys(provider.env).length > 0 && (
                      <div className="text-xs text-neutral-600 mb-1">
                        <span className="font-medium">环境变量:</span>{' '}
                        {Object.keys(provider.env).join(', ')}
                      </div>
                    )}
                    {Object.keys(provider.config).length > 0 && (
                      <div className="text-xs text-neutral-600">
                        <span className="font-medium">运行参数:</span>{' '}
                        {Object.entries(provider.config)
                          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                          .join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-4">
                    <button
                      onClick={() => openEdit(item)}
                      className="p-2 text-neutral-400 hover:text-neutral-900 transition-colors"
                      title="编辑"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(provider.id, provider.name, provider.builtIn)}
                      className="p-2 text-neutral-400 hover:text-red-600 transition-colors"
                      title="删除"
                      disabled={provider.builtIn}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editModal && (
        <ProviderFormModal
          isOpen={true}
          onClose={() => setEditModal(null)}
          initialData={editModal.data}
          onSave={data => {
            if (editModal.id) {
              handleUpdate(editModal.id, data)
            } else {
              handleCreate(data as CreateProviderInput)
            }
          }}
        />
      )}
    </div>
  )
}
