import { useState, useEffect } from 'react'
import { parse as parseToml } from 'smol-toml'
import { useProviders, useCreateProvider, useUpdateProvider, useDeleteProvider } from '@/hooks/use-providers'
import type { CreateProviderInput, UpdateProviderInput } from '@/hooks/use-providers'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Select } from '@/components/ui/select'
import { Plus, Pencil, Trash2, CheckCircle2, XCircle, ChevronDown } from 'lucide-react'
import { AgentType } from '@agent-tower/shared'

const AGENT_TYPE_LABELS: Record<string, string> = {
  CLAUDE_CODE: 'Claude Code',
  GEMINI_CLI: 'Gemini CLI',
  CURSOR_AGENT: 'Cursor Agent',
  CODEX: 'Codex',
}

// ─── 配置字段元数据 ─────────────────────────────────────────────

interface ConfigFieldMeta {
  key: string
  label: string
  type: 'switch' | 'input' | 'select' | 'textarea'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  rows?: number
}

const APPEND_PROMPT_FIELD: ConfigFieldMeta = {
  key: 'appendPrompt', label: '追加 Prompt', type: 'textarea', rows: 3,
  placeholder: '追加到每次 prompt 末尾的文本',
}

const AGENT_CONFIG_FIELDS: Record<string, ConfigFieldMeta[]> = {
  [AgentType.CLAUDE_CODE]: [
    { key: 'dangerouslySkipPermissions', label: '跳过权限确认', type: 'switch' },
    { key: 'model', label: '模型', type: 'input', placeholder: 'claude-sonnet-4-20250514' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.GEMINI_CLI]: [
    { key: 'yolo', label: '跳过权限确认', type: 'switch' },
    { key: 'model', label: '模型', type: 'input', placeholder: 'gemini-2.5-pro' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.CURSOR_AGENT]: [
    { key: 'force', label: '强制执行', type: 'switch' },
    {
      key: 'model',
      label: '模型',
      type: 'select',
      options: [
        { value: '', label: '默认 (auto)' },
        { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
        { value: 'claude-sonnet-4-5-20250514', label: 'Claude Sonnet 4.5' },
        { value: 'gpt-4o', label: 'GPT-4o' },
      ],
    },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.CODEX]: [
    { key: 'fullAuto', label: '全自动模式', type: 'switch' },
    { key: 'model', label: '模型', type: 'input', placeholder: 'o3' },
    { key: 'profile', label: 'Profile', type: 'input', placeholder: '~/.codex/config.toml 中的 profile 名称' },
    APPEND_PROMPT_FIELD,
  ],
}

const CLAUDE_CODE_SETTINGS_TEMPLATE = JSON.stringify(
  {
    env: {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: '',
    },
  },
  null,
  2
)

const CODEX_SETTINGS_TEMPLATE = `# Codex config.toml 配置片段 — 通过 -c 参数注入，不会修改 ~/.codex/config.toml
# 参考: https://developers.openai.com/codex/config-sample

# ─── 模型与推理 ─────────────────────────────────────────────
# model_reasoning_effort = "medium"     # minimal | low | medium | high | xhigh
# model_reasoning_summary = "auto"      # auto | concise | detailed | none
# model_verbosity = "medium"            # low | medium | high
# service_tier = "flex"                 # fast | flex

# ─── 自定义 Model Provider ──────────────────────────────────
# model_provider = "azure"
#
# [model_providers.azure]
# name = "Azure OpenAI"
# base_url = "https://YOUR_PROJECT.openai.azure.com/openai"
# env_key = "AZURE_OPENAI_API_KEY"
# env_key_instructions = "Set AZURE_OPENAI_API_KEY in Provider env"
# wire_api = "responses"
# query_params = { api-version = "2025-04-01-preview" }

# ─── OpenAI 数据驻留 ────────────────────────────────────────
# [model_providers.openai-us]
# name = "OpenAI US"
# base_url = "https://us.api.openai.com/v1"
# wire_api = "responses"
# requires_openai_auth = true

# ─── 本地 OSS (Ollama) ──────────────────────────────────────
# [model_providers.ollama]
# name = "Ollama"
# base_url = "http://localhost:11434/v1"
# wire_api = "responses"
`

/** 根据 agentType 获取默认 settings 模板 */
function getSettingsTemplate(agentType: AgentType): string {
  if (agentType === AgentType.CLAUDE_CODE) return CLAUDE_CODE_SETTINGS_TEMPLATE
  if (agentType === AgentType.CODEX) return CODEX_SETTINGS_TEMPLATE
  return ''
}

/** 是否显示 CLI 原生配置面板 */
function hasSettingsPanel(agentType: AgentType): boolean {
  return agentType === AgentType.CLAUDE_CODE || agentType === AgentType.CODEX
}

// ─── 从 AGENT_CONFIG_FIELDS 自动生成友好标签映射 ────────────────

const CONFIG_FIELD_LABELS: Record<string, string> = Object.values(AGENT_CONFIG_FIELDS)
  .flat()
  .reduce<Record<string, string>>((acc, field) => {
    if (!acc[field.key]) acc[field.key] = field.label
    return acc
  }, {})

function formatConfigValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string' && value) return value
  return String(value)
}

// ─── 组件 ───────────────────────────────────────────────────────

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
  config: Record<string, unknown>
  settings: string // Claude Code: JSON string, Codex: TOML string
  env: Array<{ key: string; value: string }> // 环境变量
  isDefault: boolean
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-neutral-200 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 transition-colors rounded-lg"
      >
        {title}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  )
}

function ConfigFieldsForm({
  agentType,
  config,
  onChange,
}: {
  agentType: AgentType
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}) {
  const fields = AGENT_CONFIG_FIELDS[agentType] ?? []
  if (fields.length === 0) return <p className="text-xs text-neutral-400">该类型暂无运行配置</p>

  const updateField = (key: string, value: unknown) => {
    onChange({ ...config, [key]: value })
  }

  return (
    <div className="space-y-3">
      {fields.map(field =>
        field.type === 'textarea' ? (
          <div key={field.key}>
            <label className="block text-sm text-neutral-700 mb-1">{field.label}</label>
            <textarea
              value={(config[field.key] as string) ?? ''}
              onChange={e => updateField(field.key, e.target.value || undefined)}
              placeholder={field.placeholder}
              rows={field.rows ?? 3}
              className="w-full px-3 py-1.5 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
            />
          </div>
        ) : (
          <div key={field.key} className="flex items-center gap-3">
            <label className="text-sm text-neutral-700 w-32 shrink-0">{field.label}</label>
            {field.type === 'switch' && (
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!config[field.key]}
                  onChange={e => updateField(field.key, e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-neutral-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-neutral-900"></div>
              </label>
            )}
            {field.type === 'input' && (
              <input
                type="text"
                value={(config[field.key] as string) ?? ''}
                onChange={e => updateField(field.key, e.target.value || undefined)}
                placeholder={field.placeholder}
                className="flex-1 px-3 py-1.5 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
              />
            )}
            {field.type === 'select' && field.options && (
              <Select
                value={(config[field.key] as string) ?? ''}
                onChange={value => updateField(field.key, value || undefined)}
                options={field.options}
                placeholder="选择..."
              />
            )}
          </div>
        )
      )}
    </div>
  )
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
      config: {},
      settings: '',
      env: [],
      isDefault: false,
    }
  )
  const [settingsError, setSettingsError] = useState('')

  // 新建时自动填充 settings 模板
  useEffect(() => {
    if (!initialData && !formData.settings) {
      const template = getSettingsTemplate(formData.agentType)
      if (template) {
        setFormData(prev => ({ ...prev, settings: template }))
      }
    }
  }, [])

  // 切换 agentType 时更新 settings 模板
  const handleAgentTypeChange = (type: AgentType) => {
    setFormData(prev => ({
      ...prev,
      agentType: type,
      config: {},
      settings: getSettingsTemplate(type),
    }))
  }

  const handleSave = () => {
    setSettingsError('')

    // 清理 config 中值为 undefined/空字符串 的字段，保留 false（用户显式关闭开关）
    const cleanConfig: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(formData.config)) {
      if (v !== undefined && v !== '') {
        cleanConfig[k] = v
      }
    }

    // 校验 settings 格式
    const settingsStr = formData.settings.trim()
    if (settingsStr) {
      if (formData.agentType === AgentType.CODEX) {
        // TOML 校验
        try {
          parseToml(settingsStr)
        } catch (e) {
          setSettingsError(`TOML 语法错误: ${e instanceof Error ? e.message : String(e)}`)
          return
        }
      } else if (formData.agentType === AgentType.CLAUDE_CODE) {
        // JSON 校验
        try {
          JSON.parse(settingsStr)
        } catch {
          setSettingsError('JSON 语法错误')
          return
        }
      }
    }

    // 将 env 数组转为 Record，过滤掉空行
    const envRecord: Record<string, string> = {}
    for (const { key, value } of formData.env) {
      const k = key.trim()
      if (k) envRecord[k] = value
    }

    const data: CreateProviderInput = {
      name: formData.name,
      agentType: formData.agentType,
      config: cleanConfig,
      settings: settingsStr || undefined,
      env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
      isDefault: formData.isDefault,
    }

    onSave(data)
  }

  if (!isOpen) return null

  const showSettingsPanel = hasSettingsPanel(formData.agentType)
  const isCodex = formData.agentType === AgentType.CODEX

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={initialData ? '编辑 Provider' : '新建 Provider'}
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {/* 基本信息 */}
        <div className="grid grid-cols-2 gap-4">
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
          {!initialData && (
            <div>
              <label className="block text-xs font-medium text-neutral-700 mb-1">Agent 类型</label>
              <Select
                value={formData.agentType}
                onChange={value => handleAgentTypeChange(value as AgentType)}
                options={Object.values(AgentType).map(type => ({
                  value: type,
                  label: AGENT_TYPE_LABELS[type] ?? type,
                }))}
                placeholder="选择 Agent 类型"
              />
            </div>
          )}
        </div>

        {/* 默认 */}
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

        {/* 运行配置 */}
        <CollapsibleSection title="运行配置" defaultOpen>
          <ConfigFieldsForm
            agentType={formData.agentType}
            config={formData.config}
            onChange={config => setFormData(prev => ({ ...prev, config }))}
          />
        </CollapsibleSection>

        {/* 环境变量 */}
        <CollapsibleSection title="环境变量" defaultOpen={formData.env.length > 0}>
          <p className="text-xs text-neutral-500 mb-2">
            注入到 Agent 进程的环境变量。Codex 的 <code className="bg-neutral-100 px-1 rounded">env_key</code> 指定的是变量名，实际值需在此处设置。
          </p>
          <div className="space-y-2">
            {formData.env.map((row, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  type="text"
                  value={row.key}
                  onChange={e => {
                    const next = [...formData.env]
                    next[i] = { ...next[i], key: e.target.value }
                    setFormData(prev => ({ ...prev, env: next }))
                  }}
                  placeholder="变量名，如 AZURE_OPENAI_API_KEY"
                  className="flex-1 px-3 py-1.5 text-sm font-mono border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
                />
                <input
                  type="text"
                  value={row.value}
                  onChange={e => {
                    const next = [...formData.env]
                    next[i] = { ...next[i], value: e.target.value }
                    setFormData(prev => ({ ...prev, env: next }))
                  }}
                  placeholder="值"
                  className="flex-1 px-3 py-1.5 text-sm font-mono border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = formData.env.filter((_, j) => j !== i)
                    setFormData(prev => ({ ...prev, env: next }))
                  }}
                  className="p-1.5 text-neutral-400 hover:text-red-500"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFormData(prev => ({ ...prev, env: [...prev.env, { key: '', value: '' }] }))}
            >
              <Plus size={12} className="mr-1" />
              添加变量
            </Button>
          </div>
        </CollapsibleSection>

        {/* CLI 原生配置 — Claude Code (JSON) 或 Codex (TOML) */}
        {showSettingsPanel && (
          <CollapsibleSection title={isCodex ? 'CLI 原生配置 (config.toml)' : 'CLI 原生配置 (settings.json)'}>
            <p className="text-xs text-neutral-500 mb-2">
              {isCodex ? (
                <>
                  直接填写 Codex <code className="bg-neutral-100 px-1 rounded">config.toml</code> 格式的配置片段，
                  通过 <code className="bg-neutral-100 px-1 rounded">-c</code> 参数注入。
                  不会修改你的 <code className="bg-neutral-100 px-1 rounded">~/.codex/config.toml</code> 文件。
                </>
              ) : (
                <>
                  对应 Claude Code 的 <code className="bg-neutral-100 px-1 rounded">~/.claude/settings.json</code>，
                  通过 <code className="bg-neutral-100 px-1 rounded">--settings</code> 参数注入。
                  在 <code className="bg-neutral-100 px-1 rounded">env</code> 中设置 ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL 等。
                </>
              )}
            </p>
            <textarea
              value={formData.settings}
              onChange={e => {
                setFormData(prev => ({ ...prev, settings: e.target.value }))
                setSettingsError('')
              }}
              rows={10}
              className="w-full px-3 py-2 text-sm font-mono border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900 bg-neutral-50"
              placeholder={getSettingsTemplate(formData.agentType)}
            />
            {settingsError && (
              <p className="mt-1 text-xs text-red-600">{settingsError}</p>
            )}
          </CollapsibleSection>
        )}

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
    const p = provider.provider
    // 将 env Record 转为数组形式
    const envEntries = p.env
      ? Object.entries(p.env as Record<string, string>).map(([key, value]) => ({ key, value }))
      : []
    setEditModal({
      id: p.id,
      data: {
        name: p.name,
        agentType: p.agentType as AgentType,
        config: { ...p.config },
        settings: p.settings ?? '',
        env: envEntries,
        isDefault: p.isDefault,
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
            // 过滤掉内部字段 cmd（由 executor 桥接注入），不在列表展示
            const configEntries = Object.entries(provider.config).filter(
              ([k]) => k !== 'cmd'
            )
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
                    {configEntries.length > 0 && (
                      <div className="text-xs text-neutral-600 mb-1">
                        {configEntries.map(([k, v]) => (
                          <span key={k} className="inline-flex items-center mr-3">
                            <span className="font-medium">{CONFIG_FIELD_LABELS[k] ?? k}:</span>{' '}
                            {formatConfigValue(v)}
                          </span>
                        ))}
                      </div>
                    )}
                    {provider.settings?.trim() && (
                      <div className="text-xs text-neutral-600">
                        <span className="font-medium">CLI 配置:</span> 已配置
                      </div>
                    )}
                    {/* 兼容旧数据：显示 env */}
                    {Object.keys(provider.env).length > 0 && !provider.settings && (
                      <div className="text-xs text-neutral-600">
                        <span className="font-medium">环境变量:</span>{' '}
                        {Object.keys(provider.env).join(', ')}
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
