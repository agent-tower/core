import { useState, useEffect, useRef, type ChangeEvent } from 'react'
import { parse as parseToml } from 'smol-toml'
import {
  useProviders,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
  useExportProviderBackup,
  usePreviewProviderImport,
  useImportProviderBackup,
} from '@/hooks/use-providers'
import type { CreateProviderInput, UpdateProviderInput } from '@/hooks/use-providers'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Modal } from '@/components/ui/modal'
import { Select } from '@/components/ui/select'
import { Plus, Pencil, Trash2, CheckCircle2, XCircle, ChevronDown, Download, Upload } from 'lucide-react'
import {
  AgentType,
  type ProviderBackupFile,
  type ProviderImportAction,
  type ProviderImportPreview,
} from '@agent-tower/shared'
import { toast } from 'sonner'
import { CursorAgentModelField } from '@/components/provider/CursorAgentModelField'
import { translate, useI18n } from '@/lib/i18n'

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
  type: 'switch' | 'input' | 'select' | 'textarea' | 'cursor_model'
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
    { key: 'model', label: '模型', type: 'cursor_model' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.CODEX]: [
    { key: 'dangerouslyBypassApprovalsAndSandbox', label: '跳过所有确认和沙盒', type: 'switch' },
    { key: 'model', label: '模型', type: 'input', placeholder: 'o3' },
    { key: 'profile', label: 'Profile', type: 'input', placeholder: '~/.codex/config.toml 中的 profile 名称' },
    APPEND_PROMPT_FIELD,
  ],
}

function getDefaultConfigForAgentType(): Record<string, unknown> {
  return {}
}

function normalizeProviderConfig(
  _agentType: AgentType | string,
  config: Record<string, unknown>
): Record<string, unknown> {
  return { ...config }
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

const CONFIG_FIELD_OPTION_LABELS: Record<string, Record<string, string>> = Object.values(AGENT_CONFIG_FIELDS)
  .flat()
  .reduce<Record<string, Record<string, string>>>((acc, field) => {
    if (field.options) {
      acc[field.key] = Object.fromEntries(field.options.map(option => [option.value, option.label]))
    }
    return acc
  }, {})

function formatConfigValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? translate('是') : translate('否')
  if (typeof value === 'string' && value) {
    return CONFIG_FIELD_OPTION_LABELS[key]?.[value] ?? value
  }
  return String(value)
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function formatBackupFilename(exportedAt: string): string {
  const timestamp = exportedAt.replace(/[:.]/g, '-')
  return `agent-tower-provider-backup-${timestamp}.json`
}

function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function getImportActionMeta(action: ProviderImportAction) {
  switch (action) {
    case 'CREATE':
      return {
        label: '新增',
        className: 'text-green-700 bg-green-50',
      }
    case 'OVERWRITE':
      return {
        label: '覆盖',
        className: 'text-amber-700 bg-amber-50',
      }
    case 'SKIP':
      return {
        label: '跳过',
        className: 'text-neutral-600 bg-neutral-100',
      }
  }
}

// ─── 组件 ───────────────────────────────────────────────────────

function AvailabilityBadge({ type }: { type: string }) {
  const { t } = useI18n()
  if (type === 'LOGIN_DETECTED' || type === 'INSTALLATION_FOUND') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-green-700 bg-green-50 rounded">
        <CheckCircle2 size={12} />
        {t('可用')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-neutral-500 bg-neutral-50 rounded">
      <XCircle size={12} />
      {t('不可用')}
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
  const { t } = useI18n()
  const fields = AGENT_CONFIG_FIELDS[agentType] ?? []
  if (fields.length === 0) return <p className="text-xs text-neutral-400">{t('该类型暂无运行配置')}</p>

  const updateField = (key: string, value: unknown) => {
    onChange({ ...config, [key]: value })
  }

  return (
    <div className="space-y-3">
      {fields.map(field =>
        field.type === 'textarea' ? (
          <div key={field.key}>
            <label className="block text-sm text-neutral-700 mb-1">{t(field.label)}</label>
            <textarea
              value={(config[field.key] as string) ?? ''}
              onChange={e => updateField(field.key, e.target.value || undefined)}
              placeholder={field.placeholder ? t(field.placeholder) : undefined}
              rows={field.rows ?? 3}
              className="w-full px-3 py-1.5 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
            />
          </div>
        ) : field.type === 'cursor_model' ? (
          <div key={field.key} className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <label className="text-sm text-neutral-700 w-32 shrink-0 sm:pt-2">{t(field.label)}</label>
            <CursorAgentModelField
              value={(config[field.key] as string) ?? ''}
              onChange={v => updateField(field.key, v)}
            />
          </div>
        ) : (
          <div key={field.key} className="flex items-center gap-3">
            <label className="text-sm text-neutral-700 w-32 shrink-0">{t(field.label)}</label>
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
                placeholder={field.placeholder ? t(field.placeholder) : undefined}
                className="flex-1 px-3 py-1.5 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
              />
            )}
            {field.type === 'select' && field.options && (
              <Select
                value={(config[field.key] as string) ?? ''}
                onChange={value => updateField(field.key, value || undefined)}
                options={field.options}
                placeholder={t('选择...')}
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
  const { t } = useI18n()
  const [formData, setFormData] = useState<ProviderFormData>(
    initialData ?? {
      name: '',
      agentType: AgentType.CLAUDE_CODE,
      config: getDefaultConfigForAgentType(),
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
      config: getDefaultConfigForAgentType(),
      settings: getSettingsTemplate(type),
    }))
  }

  const handleSave = () => {
    setSettingsError('')

    // 清理 config 中值为 undefined/空字符串 的字段，保留 false（用户显式关闭开关）
    const normalizedConfig = normalizeProviderConfig(formData.agentType, formData.config)
    const cleanConfig: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(normalizedConfig)) {
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
          setSettingsError(t('TOML 语法错误: {message}', { message: e instanceof Error ? e.message : String(e) }))
          return
        }
      } else if (formData.agentType === AgentType.CLAUDE_CODE) {
        // JSON 校验
        try {
          JSON.parse(settingsStr)
        } catch {
          setSettingsError(t('JSON 语法错误'))
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
      title={initialData ? t('编辑 Provider') : t('新建 Provider')}
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {/* 基本信息 */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-neutral-700 mb-1">{t('名称')}</label>
            <input
              type="text"
              value={formData.name}
              onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
              className="w-full px-3 py-2 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900"
              placeholder={t('例如: Claude Code (官方)')}
            />
          </div>
          {!initialData && (
            <div>
              <label className="block text-xs font-medium text-neutral-700 mb-1">{t('Agent 类型')}</label>
              <Select
                value={formData.agentType}
                onChange={value => handleAgentTypeChange(value as AgentType)}
                options={Object.values(AgentType).map(type => ({
                  value: type,
                  label: AGENT_TYPE_LABELS[type] ?? type,
                }))}
                placeholder={t('选择 Agent 类型')}
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
            {t('设为该类型的默认 Provider')}
          </label>
        </div>

        {/* 运行配置 */}
        <CollapsibleSection title={t('运行配置')} defaultOpen>
          <ConfigFieldsForm
            agentType={formData.agentType}
            config={formData.config}
            onChange={config => setFormData(prev => ({ ...prev, config }))}
          />
        </CollapsibleSection>

        {/* 环境变量 */}
        <CollapsibleSection title={t('环境变量')} defaultOpen={formData.env.length > 0}>
          <p className="text-xs text-neutral-500 mb-2">
            {t('注入到 Agent 进程的环境变量。Codex 的')} <code className="bg-neutral-100 px-1 rounded">env_key</code> {t('指定的是变量名，实际值需在此处设置。')}
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
                  placeholder={t('变量名，如 AZURE_OPENAI_API_KEY')}
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
                  placeholder={t('值')}
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
              {t('添加变量')}
            </Button>
          </div>
        </CollapsibleSection>

        {/* CLI 原生配置 — Claude Code (JSON) 或 Codex (TOML) */}
        {showSettingsPanel && (
          <CollapsibleSection title={isCodex ? t('CLI 原生配置 (config.toml)') : t('CLI 原生配置 (settings.json)')}>
            <p className="text-xs text-neutral-500 mb-2">
              {isCodex ? (
                <>
                  {t('直接填写 Codex')} <code className="bg-neutral-100 px-1 rounded">config.toml</code> {t('格式的配置片段，通过')} <code className="bg-neutral-100 px-1 rounded">-c</code> {t('参数注入。不会修改你的')} <code className="bg-neutral-100 px-1 rounded">~/.codex/config.toml</code> {t('文件。')}
                </>
              ) : (
                <>
                  {t('对应 Claude Code 的')} <code className="bg-neutral-100 px-1 rounded">~/.claude/settings.json</code>，{t('通过')} <code className="bg-neutral-100 px-1 rounded">--settings</code> {t('参数注入。在')} <code className="bg-neutral-100 px-1 rounded">env</code> {t('中设置 ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL 等。')}
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
            {t('取消')}
          </Button>
          <Button onClick={handleSave} disabled={!formData.name.trim()}>
            {t('保存')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ExportBackupModal({
  isOpen,
  onClose,
  onConfirm,
  acknowledged,
  onAcknowledgedChange,
  isLoading,
}: {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  acknowledged: boolean
  onAcknowledgedChange: (checked: boolean) => void
  isLoading: boolean
}) {
  const { t } = useI18n()
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('导出 Provider 备份')}
      className="max-w-xl"
      action={
        <>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            {t('取消')}
          </Button>
          <Button onClick={onConfirm} disabled={!acknowledged || isLoading}>
            {isLoading ? t('导出中...') : t('导出备份')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t('导出的备份文件将包含完整的 Provider 配置，包括环境变量、CLI settings 等敏感信息。任何拿到文件的人都可能直接使用这些 Provider。')}
        </div>
        <div className="text-sm text-neutral-600 space-y-2">
          <p>{t('这个功能用于备份和迁移，不用于分享配置。')}</p>
          <p>{t('导出内容只包含用户层配置：自定义 Provider，以及对内置 Provider 的覆盖。')}</p>
        </div>
        <label className="flex items-start gap-3 rounded-lg border border-neutral-200 px-4 py-3 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={e => onAcknowledgedChange(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>{t('我已知晓该备份文件包含敏感信息，只会保存在安全位置。')}</span>
        </label>
      </div>
    </Modal>
  )
}

function ImportPreviewModal({
  isOpen,
  onClose,
  preview,
  backup,
  onConfirm,
  isLoading,
}: {
  isOpen: boolean
  onClose: () => void
  preview: ProviderImportPreview | null
  backup: ProviderBackupFile | null
  onConfirm: () => void
  isLoading: boolean
}) {
  const { t } = useI18n()
  if (!preview || !backup) return null

  const importableCount = preview.summary.create + preview.summary.overwrite
  const sortedItems = [...preview.items].sort((a, b) => {
    const order: Record<ProviderImportAction, number> = {
      CREATE: 0,
      OVERWRITE: 1,
      SKIP: 2,
    }
    return order[a.action] - order[b.action]
  })

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('导入 Provider 备份')}
      className="max-w-3xl"
      action={
        <>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            {t('取消')}
          </Button>
          <Button onClick={onConfirm} disabled={importableCount === 0 || isLoading}>
            {isLoading ? t('导入中...') : t('确认导入 {count} 项', { count: importableCount })}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
          <div>{t('导出时间：{value}', { value: new Date(backup.exportedAt).toLocaleString() })}</div>
          <div>{t('模式：完整备份（含敏感信息）')}</div>
          <div>{t('文件内 Provider 数量：{count}', { count: backup.providers.length })}</div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3">
            <div className="text-xs text-green-700">{t('新增')}</div>
            <div className="text-lg font-semibold text-green-900">{preview.summary.create}</div>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="text-xs text-amber-700">{t('覆盖')}</div>
            <div className="text-lg font-semibold text-amber-900">{preview.summary.overwrite}</div>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
            <div className="text-xs text-neutral-500">{t('跳过')}</div>
            <div className="text-lg font-semibold text-neutral-900">{preview.summary.skip}</div>
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto space-y-3 pr-1">
          {sortedItems.map(item => {
            const meta = getImportActionMeta(item.action)
            return (
              <div key={item.incoming.id} className="rounded-lg border border-neutral-200 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="truncate text-sm font-medium text-neutral-900">{item.incoming.name}</h4>
                      <span className={`inline-flex rounded px-2 py-0.5 text-xs ${meta.className}`}>
                        {t(meta.label)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {AGENT_TYPE_LABELS[item.incoming.agentType] ?? item.incoming.agentType}
                      {' · '}
                      <code className="rounded bg-neutral-100 px-1 py-0.5">{item.incoming.id}</code>
                    </div>
                  </div>
                </div>

                {item.action === 'OVERWRITE' && item.existing && (
                  <p className="mt-2 text-xs text-amber-700">
                    {t('将覆盖当前已有的 Provider：{name}', { name: item.existing.name })}
                  </p>
                )}
                {item.action === 'SKIP' && (
                  <p className="mt-2 text-xs text-neutral-500">
                    {t('当前同 ID Provider 配置一致，本次不会重复写入。')}
                  </p>
                )}
                {item.action === 'CREATE' && (
                  <p className="mt-2 text-xs text-green-700">
                    {t('当前不存在同 ID Provider，将直接新增。')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

export function ProviderSettingsPage() {
  const { t } = useI18n()
  const { data: providersData, isLoading } = useProviders()
  const createProvider = useCreateProvider()
  const updateProvider = useUpdateProvider()
  const deleteProvider = useDeleteProvider()
  const exportProviderBackup = useExportProviderBackup()
  const previewProviderImport = usePreviewProviderImport()
  const importProviderBackup = useImportProviderBackup()

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [editModal, setEditModal] = useState<{ id?: string; data?: ProviderFormData } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string
    name: string
    builtIn?: boolean
  } | null>(null)
  const [isExportBackupOpen, setIsExportBackupOpen] = useState(false)
  const [exportAcknowledged, setExportAcknowledged] = useState(false)
  const [importPreviewState, setImportPreviewState] = useState<{
    backup: ProviderBackupFile
    preview: ProviderImportPreview
  } | null>(null)

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

  const handleDelete = (provider: { id: string; name: string; builtIn?: boolean; deletable?: boolean }) => {
    const canDelete = provider.deletable ?? !provider.builtIn

    if (!canDelete) {
      toast.error(t('系统内置 Provider 不可删除'))
      return
    }

    setDeleteConfirm({
      id: provider.id,
      name: provider.name,
      builtIn: provider.builtIn,
    })
  }

  const handleConfirmDelete = () => {
    if (!deleteConfirm) return

    deleteProvider.mutate(deleteConfirm.id, {
      onSuccess: () => {
        toast.success(deleteConfirm.builtIn ? t('已恢复默认 Provider 配置') : t('Provider 已删除'))
        setDeleteConfirm(null)
      },
      onError: error => {
        toast.error(getErrorMessage(error, t('删除 Provider 失败')))
      },
    })
  }

  const closeExportBackup = () => {
    setIsExportBackupOpen(false)
    setExportAcknowledged(false)
  }

  const closeImportPreview = () => {
    setImportPreviewState(null)
  }

  const handleExportBackup = () => {
    exportProviderBackup.mutate(undefined, {
      onSuccess: backup => {
        downloadJsonFile(formatBackupFilename(backup.exportedAt), backup)
        toast.success(t('Provider 备份已导出'))
        closeExportBackup()
      },
      onError: error => {
        toast.error(getErrorMessage(error, t('导出 Provider 备份失败')))
      },
    })
  }

  const handleOpenImportFile = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    let parsed: ProviderBackupFile

    try {
      parsed = JSON.parse(await file.text()) as ProviderBackupFile
    } catch {
      toast.error(t('备份文件不是有效的 JSON'))
      return
    }

    previewProviderImport.mutate(parsed, {
      onSuccess: preview => {
        setImportPreviewState({ backup: parsed, preview })
      },
      onError: error => {
        toast.error(getErrorMessage(error, t('导入预览失败')))
      },
    })
  }

  const handleConfirmImport = () => {
    if (!importPreviewState) return

    importProviderBackup.mutate(importPreviewState.backup, {
      onSuccess: result => {
        const totalImported = result.summary.create + result.summary.overwrite
        toast.success(
          totalImported === 0
            ? t('导入完成，当前配置无需变更')
            : t('导入完成：新增 {create}，覆盖 {overwrite}，跳过 {skip}', {
                create: result.summary.create,
                overwrite: result.summary.overwrite,
                skip: result.summary.skip,
              })
        )
        closeImportPreview()
      },
      onError: error => {
        toast.error(getErrorMessage(error, t('导入 Provider 备份失败')))
      },
    })
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
        config: normalizeProviderConfig(p.agentType as AgentType, p.config),
        settings: p.settings ?? '',
        env: envEntries,
        isDefault: p.isDefault,
      },
    })
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-neutral-400">{t('加载中...')}</div>
  }

  const providers = providersData ?? []

  return (
    <div className="px-10 py-6 mx-auto w-full max-w-4xl">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFileChange}
      />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">{t('Provider 配置')}</h2>
          <p className="text-sm text-neutral-500 mt-1">
            {t('管理 AI Agent 的连接配置和运行参数')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleOpenImportFile} disabled={previewProviderImport.isPending || importProviderBackup.isPending}>
            <Upload size={14} />
            {t('导入备份')}
          </Button>
          <Button variant="outline" onClick={() => setIsExportBackupOpen(true)} disabled={exportProviderBackup.isPending}>
            <Download size={14} />
            {t('导出备份')}
          </Button>
          <Button onClick={() => setEditModal({})}>
            <Plus size={14} className="mr-1" />
            {t('新建 Provider')}
          </Button>
        </div>
      </div>

      {providers.length === 0 ? (
        <div className="text-center py-12 text-sm text-neutral-400">
          {t('暂无 Provider 配置')}
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map(item => {
            const provider = item.provider
            const availability = item.availability
            const normalizedConfig = normalizeProviderConfig(provider.agentType as AgentType, provider.config)
            // 过滤掉内部字段 cmd（由 executor 桥接注入），不在列表展示
            const configEntries = Object.entries(normalizedConfig).filter(
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
                          {t('默认')}
                        </span>
                      )}
                      {provider.builtIn && (
                        <span className="px-2 py-0.5 text-xs text-neutral-500 bg-neutral-50 rounded">
                          {t('内置')}
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
                            <span className="font-medium">{t(CONFIG_FIELD_LABELS[k] ?? k)}:</span>{' '}
                            {formatConfigValue(k, v)}
                          </span>
                        ))}
                      </div>
                    )}
                    {provider.settings?.trim() && (
                      <div className="text-xs text-neutral-600">
                        <span className="font-medium">{t('CLI 配置:')}</span> {t('已配置')}
                      </div>
                    )}
                    {/* 兼容旧数据：显示 env */}
                    {Object.keys(provider.env).length > 0 && !provider.settings && (
                      <div className="text-xs text-neutral-600">
                        <span className="font-medium">{t('环境变量:')}</span>{' '}
                        {Object.keys(provider.env).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-4">
                    <button
                      onClick={() => openEdit(item)}
                      className="p-2 text-neutral-400 hover:text-neutral-900 transition-colors"
                      title={t('编辑')}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(provider)}
                      className="p-2 text-neutral-400 hover:text-red-600 transition-colors"
                      title={provider.deletable === false ? t('系统内置 Provider 不可删除') : provider.builtIn ? t('删除自定义覆盖并恢复默认') : t('删除')}
                      disabled={provider.deletable === false}
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

      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        onClose={() => {
          if (!deleteProvider.isPending) {
            setDeleteConfirm(null)
          }
        }}
        onConfirm={handleConfirmDelete}
        title={deleteConfirm?.builtIn ? t('恢复默认 Provider') : t('删除 Provider')}
        description={
          deleteConfirm?.builtIn
            ? t('确定删除 "{name}" 的自定义覆盖，并恢复系统默认配置？', { name: deleteConfirm?.name })
            : t('确定删除 "{name}"？此操作不可撤销。', { name: deleteConfirm?.name })
        }
        confirmText={deleteConfirm?.builtIn ? t('恢复默认') : t('删除')}
        cancelText={t('取消')}
        variant="danger"
        isLoading={deleteProvider.isPending}
      />

      <ExportBackupModal
        isOpen={isExportBackupOpen}
        onClose={closeExportBackup}
        onConfirm={handleExportBackup}
        acknowledged={exportAcknowledged}
        onAcknowledgedChange={setExportAcknowledged}
        isLoading={exportProviderBackup.isPending}
      />

      <ImportPreviewModal
        isOpen={!!importPreviewState}
        onClose={closeImportPreview}
        preview={importPreviewState?.preview ?? null}
        backup={importPreviewState?.backup ?? null}
        onConfirm={handleConfirmImport}
        isLoading={importProviderBackup.isPending}
      />
    </div>
  )
}
