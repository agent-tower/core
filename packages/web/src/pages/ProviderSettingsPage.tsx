import { useState, useRef, type ChangeEvent } from 'react'
import { parse as parseToml } from 'smol-toml'
import {
  useProviders,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
  useExportProviderBackup,
  usePreviewProviderImport,
  useImportProviderBackup,
  useProviderCapabilities,
  useTestProviderDraft,
} from '@/hooks/use-providers'
import type { CreateProviderInput, UpdateProviderInput, ProviderWithAvailability } from '@/hooks/use-providers'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Plus, Pencil, Trash2, CheckCircle2, XCircle, ChevronDown, Download, Upload, RotateCcw, AlertTriangle, Cpu, FlaskConical, KeyRound, Loader2 } from 'lucide-react'
import {
  AgentType,
  AGENT_RUNTIME_SUPPORT,
  PROVIDER_CAPABILITIES,
  RuntimeType,
  USER_VISIBLE_AGENT_TYPES,
  type AppLocale,
  type ProviderBackupFile,
  type ProviderDraftInput,
  type ProviderDraftTestResult,
  type ProviderConfigDiagnostic,
  type ProviderConflictResolution,
  type ProviderImportAction,
  type ProviderImportPreview,
  type ProviderSecretWriteState,
  type ProviderSimplifiedConfig,
} from '@agent-tower/shared'
import { toast } from 'sonner'
import { AgentLogo } from '@/components/agent'
import { CursorAgentModelField } from '@/components/provider/CursorAgentModelField'
import { ProviderDraftTestResultPanel } from '@/components/provider/ProviderDraftTestResultPanel'
import { SegmentedEffortSlider } from '@/components/provider/SegmentedEffortSlider'
import {
  buildProviderEnvWrites,
  createProviderDraftTestSequence,
  createProviderEnvDraftRows,
  getApiBaseUrlValidationError,
  getApiKeyDraftStatus,
  getExecutionPermissionState,
  getProviderBooleanConfigState,
  isProviderEnvDraftRowSensitive,
  isSameProviderEnvKey,
  markActiveCredentialEnvRowSensitive,
  resolveProviderDraftConflict,
  syncSimplifiedFromConfig,
  syncSimplifiedFromSettings,
  updateSimplifiedDraftValue,
  updateProviderBooleanConfig,
  usesCodexNativeModelProvider,
  type ProviderEnvDraftRow,
} from '@/components/provider/provider-draft'
import { translate, useI18n } from '@/lib/i18n'
import { getAgentLabel } from '@/lib/agent-meta'
import { cn } from '@/lib/utils'
import {
  SettingsEmptyState,
  SettingsMasterDetailSkeleton,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsSectionTitle,
} from '@/components/settings/SettingsSection'
import { SettingsMasterDetail } from '@/components/settings/SettingsMasterDetail'

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
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.GEMINI_CLI]: [
    { key: 'yolo', label: '自动批准操作（YOLO）', type: 'switch' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.CURSOR_AGENT]: [
    { key: 'force', label: '强制执行', type: 'switch' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.CODEX]: [
    { key: 'dangerouslyBypassApprovalsAndSandbox', label: '跳过所有确认和沙盒', type: 'switch' },
    { key: 'fastMode', label: 'Fast 模式', type: 'switch' },
    { key: 'disableResponsesWebsocket', label: '禁用 WebSocket', type: 'switch' },
    { key: 'profile', label: 'Profile', type: 'input', placeholder: '~/.codex/config.toml 中的 profile 名称' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.QWEN_CODE]: [
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.KIRO_CLI]: [
    { key: 'trustAllTools', label: '信任所有工具', type: 'switch' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.OPENCODE]: [
    { key: 'autoApprove', label: '自动批准操作', type: 'switch' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.PI_CODING_AGENT]: [
    { key: 'autoApprove', label: '自动批准操作', type: 'switch' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.GROK_BUILD]: [
    { key: 'alwaysApprove', label: '始终批准操作', type: 'switch' },
    APPEND_PROMPT_FIELD,
  ],
  [AgentType.MINION_CODE]: [
    { key: 'dangerouslySkipPermissions', label: '跳过权限确认', type: 'switch' },
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

const CODEX_SETTINGS_TEMPLATE_ZH = `# Codex config.toml 配置片段 — 通过 -c 参数注入，不会修改 ~/.codex/config.toml
# 参考: https://developers.openai.com/codex/config-sample

# ─── 模型与推理 ─────────────────────────────────────────────
# model_reasoning_effort = "medium"     # minimal | low | medium | high | xhigh | max | ultra
# model_reasoning_summary = "auto"      # auto | concise | detailed | none
# model_verbosity = "medium"            # low | medium | high
# service_tier = "fast"
# features.fast_mode = true

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

const CODEX_SETTINGS_TEMPLATE_EN = `# Codex config.toml snippet — injected through -c; ~/.codex/config.toml is not modified.
# Reference: https://developers.openai.com/codex/config-sample

# ─── Model and reasoning ────────────────────────────────────
# model_reasoning_effort = "medium"     # minimal | low | medium | high | xhigh | max | ultra
# model_reasoning_summary = "auto"      # auto | concise | detailed | none
# model_verbosity = "medium"            # low | medium | high
# service_tier = "fast"
# features.fast_mode = true

# ─── Custom Model Provider ──────────────────────────────────
# model_provider = "azure"
#
# [model_providers.azure]
# name = "Azure OpenAI"
# base_url = "https://YOUR_PROJECT.openai.azure.com/openai"
# env_key = "AZURE_OPENAI_API_KEY"
# env_key_instructions = "Set AZURE_OPENAI_API_KEY in Provider env"
# wire_api = "responses"
# query_params = { api-version = "2025-04-01-preview" }

# ─── OpenAI data residency ──────────────────────────────────
# [model_providers.openai-us]
# name = "OpenAI US"
# base_url = "https://us.api.openai.com/v1"
# wire_api = "responses"
# requires_openai_auth = true

# ─── Local OSS (Ollama) ─────────────────────────────────────
# [model_providers.ollama]
# name = "Ollama"
# base_url = "http://localhost:11434/v1"
# wire_api = "responses"
`

function getSettingsTemplate(agentType: AgentType, locale: AppLocale): string {
  if (agentType === AgentType.CLAUDE_CODE) return CLAUDE_CODE_SETTINGS_TEMPLATE
  if (agentType === AgentType.CODEX) return locale === 'zh-CN' ? CODEX_SETTINGS_TEMPLATE_ZH : CODEX_SETTINGS_TEMPLATE_EN
  return ''
}

function hasSettingsPanel(agentType: AgentType): boolean {
  return agentType === AgentType.CLAUDE_CODE || agentType === AgentType.CODEX
}

const ACP_AGENT_OPTION_SUFFIX = '::ACP'

function getProviderAgentOption(agentType: AgentType | string, runtimeType?: RuntimeType): string {
  return runtimeType === RuntimeType.ACP
    ? `${agentType}${ACP_AGENT_OPTION_SUFFIX}`
    : String(agentType)
}

function getProviderAgentLabel(agentType: AgentType | string, runtimeType?: RuntimeType): string {
  const label = getAgentLabel(agentType)
  return runtimeType === RuntimeType.ACP ? `${label} (ACP)` : label
}

function parseProviderAgentOption(value: string): { agentType: AgentType; runtimeType: RuntimeType } {
  if (value.endsWith(ACP_AGENT_OPTION_SUFFIX)) {
    return {
      agentType: value.slice(0, -ACP_AGENT_OPTION_SUFFIX.length) as AgentType,
      runtimeType: RuntimeType.ACP,
    }
  }
  return { agentType: value as AgentType, runtimeType: RuntimeType.CLI }
}

function removeClaudeEnvSetting(settings: string, key: string): string {
  if (!settings.trim()) return settings
  try {
    const parsed = JSON.parse(settings) as Record<string, unknown>
    if (!parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) return settings
    const env = parsed.env as Record<string, unknown>
    if (!(key in env)) return settings
    delete env[key]
    return JSON.stringify(parsed, null, 2)
  } catch {
    return settings
  }
}

const CONFIG_FIELD_LABELS: Record<string, string> = Object.values(AGENT_CONFIG_FIELDS)
  .flat()
  .reduce<Record<string, string>>((acc, field) => {
    if (!acc[field.key]) acc[field.key] = field.label
    return acc
  }, {})

CONFIG_FIELD_LABELS.permissionMode = '权限策略'

const CONFIG_FIELD_OPTION_LABELS: Record<string, Record<string, string>> = Object.values(AGENT_CONFIG_FIELDS)
  .flat()
  .reduce<Record<string, Record<string, string>>>((acc, field) => {
    if (field.options) {
      acc[field.key] = Object.fromEntries(field.options.map(option => [option.value, option.label]))
    }
    return acc
  }, {})

CONFIG_FIELD_OPTION_LABELS.permissionMode = {
  ASK: '每次询问',
  AUTO_APPROVE: '无限制',
  UNRESTRICTED: '无限制',
}

function formatConfigValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? translate('是') : translate('否')
  if (typeof value === 'string' && value) {
    const optionLabel = CONFIG_FIELD_OPTION_LABELS[key]?.[value]
    return optionLabel ? translate(optionLabel) : value
  }
  return String(value)
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function getDiagnosticFieldLabel(field: ProviderConfigDiagnostic['field']): string {
  if (field === 'apiBaseUrl') return 'API 地址'
  if (field === 'apiKey') return 'API Key'
  if (field === 'reasoningEffort') return '思考强度'
  if (field === 'model') return '模型'
  if (field === 'executionPermission') return '执行权限'
  if (field === 'fastMode') return 'Fast 模式'
  if (field === 'disableResponsesWebsocket') return '禁用 WebSocket'
  return field
}

function getEffortLabel(value: string): string {
  return ({
    minimal: '最低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
    ultra: 'Ultra',
  } as Record<string, string>)[value] ?? value
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
      return { label: '新增', className: 'bg-success/10 text-success' }
    case 'OVERWRITE':
      return { label: '覆盖', className: 'bg-warning/10 text-warning' }
    case 'SKIP':
      return { label: '跳过', className: 'bg-muted text-muted-foreground' }
  }
}

function AvailabilityDot({ type }: { type: string }) {
  const available = type === 'LOGIN_DETECTED' || type === 'INSTALLATION_FOUND'
  return (
    <span
      className={cn('inline-block h-2 w-2 rounded-full shrink-0', available ? 'bg-success' : 'bg-border')}
      title={available ? 'Available' : 'Unavailable'}
    >
      <span className="sr-only">{available ? 'Available' : 'Unavailable'}</span>
    </span>
  )
}

function AvailabilityBadge({ type }: { type: string }) {
  const { t } = useI18n()
  if (type === 'LOGIN_DETECTED' || type === 'INSTALLATION_FOUND') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
        <CheckCircle2 size={11} aria-hidden="true" />
        {t('可用')}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <XCircle size={11} aria-hidden="true" />
      {t('不可用')}
    </span>
  )
}

export interface ProviderFormData {
  name: string
  agentType: AgentType
  runtimeType: RuntimeType
  config: Record<string, unknown>
  settings: string
  env: ProviderEnvDraftRow[]
  simplified: ProviderSimplifiedConfig
  diagnostics?: ProviderConfigDiagnostic[]
  isDefault: boolean
}

function CollapsibleSection({
  title,
  status,
  defaultOpen = false,
  children,
}: {
  title: string
  status?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between rounded-lg px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span>{title}</span>
          {status}
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={cn('text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-180')}
        />
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  )
}

export function ProviderFormModal({
  isOpen,
  onClose,
  providerId,
  initialData,
  onSave,
}: {
  isOpen: boolean
  onClose: () => void
  providerId?: string
  initialData?: ProviderFormData
  onSave: (data: CreateProviderInput | UpdateProviderInput) => void
}) {
  const { locale, t } = useI18n()
  const testProvider = useTestProviderDraft()
  const [formData, setFormData] = useState<ProviderFormData>(
    initialData ?? {
      name: '',
      agentType: AgentType.CLAUDE_CODE,
      runtimeType: RuntimeType.CLI,
      config: getDefaultConfigForAgentType(),
      settings: '',
      env: [],
      simplified: {
        apiKey: { configured: false, envKey: 'ANTHROPIC_API_KEY' },
      },
      diagnostics: [],
      isDefault: false,
    }
  )
  const [configText, setConfigText] = useState(() => JSON.stringify(formData.config, null, 2))
  const [configError, setConfigError] = useState('')
  const [settingsError, setSettingsError] = useState(
    () => formData.diagnostics?.find(diagnostic => diagnostic.field === 'settings')?.message ?? '',
  )
  const [settingsTouched, setSettingsTouched] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [testResult, setTestResult] = useState<ProviderDraftTestResult | null>(null)
  const [simplifiedTouched, setSimplifiedTouched] = useState<Set<'apiBaseUrl' | 'model' | 'reasoningEffort'>>(() => new Set())
  const [conflicts, setConflicts] = useState(
    () => formData.diagnostics?.filter(diagnostic => diagnostic.code === 'CONFLICT') ?? [],
  )
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, ProviderConflictResolution>>({})
  const testSequence = useRef(createProviderDraftTestSequence())

  const { data: capabilities } = useProviderCapabilities(formData.agentType, formData.simplified.model)
  const capability = capabilities?.[formData.agentType] ?? PROVIDER_CAPABILITIES[formData.agentType]
  const apiBaseUrlError = capability.apiBaseUrl
    ? getApiBaseUrlValidationError(formData.simplified.apiBaseUrl)
    : null
  const permissionState = getExecutionPermissionState(formData.config, capability)
  const rawAcpPermissionMode = formData.config.permissionMode ?? formData.config.acpPermissionMode
  const acpPermissionMode = rawAcpPermissionMode === 'UNRESTRICTED'
    || rawAcpPermissionMode === 'AUTO_APPROVE'
    || (rawAcpPermissionMode === undefined && permissionState.enabled)
    ? 'UNRESTRICTED'
    : 'ASK'
  const acpPermissionModeError = formData.runtimeType === RuntimeType.ACP
    && rawAcpPermissionMode !== undefined
    && rawAcpPermissionMode !== 'ASK'
    && rawAcpPermissionMode !== 'UNRESTRICTED'
    && rawAcpPermissionMode !== 'AUTO_APPROVE'
    ? t('ACP 权限策略必须为 ASK 或 UNRESTRICTED')
    : null
  const websocketCapability = capability.disableResponsesWebsocket
  const websocketState = websocketCapability
    ? getProviderBooleanConfigState(formData.config, websocketCapability)
    : null
  const fastModeCapability = capability.fastMode
  const fastModeState = fastModeCapability
    ? getProviderBooleanConfigState(formData.config, fastModeCapability)
    : null
  const fastModeValue = fastModeCapability ? formData.config[fastModeCapability.path] : undefined
  const fastModeSelection = fastModeValue === true
    ? 'fast'
    : fastModeValue === false ? 'standard' : 'inherit'
  const reasoningEffort = formData.simplified.reasoningEffort ?? ''
  const reasoningEffortError = reasoningEffort
    && !capability.reasoningEffort?.options?.includes(reasoningEffort)
    ? t('请选择当前 Agent 支持的思考强度档位')
    : null

  const commitDraftChange = (updater?: (previous: ProviderFormData) => ProviderFormData) => {
    testSequence.current.invalidate()
    if (updater) setFormData(updater)
    setDirty(true)
    setTestResult(null)
  }

  const updateForm = (updater: (previous: ProviderFormData) => ProviderFormData) => {
    commitDraftChange(updater)
  }

  const requestClose = () => {
    if (dirty && !window.confirm(t('存在未保存的修改，确定放弃吗？'))) return
    onClose()
  }

  const getEnvRow = (key: string) => formData.env.find(row => isSameProviderEnvKey(row.key, key))

  const setEnvWrite = (key: string, write: ProviderSecretWriteState, value = '') => {
    if (write.action !== 'keep') {
      const mappedField = key === capability.apiBaseUrl?.path
        ? 'apiBaseUrl'
        : key === capability.apiKey?.path
          ? 'apiKey'
          : null
      if (mappedField) {
        setConflictResolutions(previous => {
          const next = { ...previous }
          delete next[mappedField]
          return next
        })
      }
    }
    updateForm(previous => {
      const existingIndex = previous.env.findIndex(row => isSameProviderEnvKey(row.key, key))
      const next = [...previous.env]
      const current = existingIndex >= 0 ? next[existingIndex]! : null
      const row: ProviderEnvDraftRow = {
        key: current?.key ?? key,
        value,
        write,
        configured: current?.configured ?? false,
        sensitive: isSameProviderEnvKey(key, previous.simplified.apiKey?.envKey)
          || !!current?.sensitive
          || /key|token|secret|password|auth/i.test(key),
      }
      if (existingIndex >= 0) next[existingIndex] = row
      else next.push(row)
      const shouldRemoveClaudeSetting = previous.agentType === AgentType.CLAUDE_CODE
        && write.action !== 'keep'
        && (key === capability.apiBaseUrl?.path || key === capability.apiKey?.path)
      return {
        ...previous,
        env: next,
        settings: shouldRemoveClaudeSetting ? removeClaudeEnvSetting(previous.settings, key) : previous.settings,
      }
    })
  }

  const updateSimple = (field: 'apiBaseUrl' | 'model' | 'reasoningEffort', value: string) => {
    setConflictResolutions(previous => {
      if (!(field in previous)) return previous
      const next = { ...previous }
      delete next[field]
      return next
    })
    setSimplifiedTouched(previous => new Set(previous).add(field))
    if (field === 'apiBaseUrl' && capability.apiBaseUrl?.kind === 'env') {
      setEnvWrite(capability.apiBaseUrl.path, value ? { action: 'replace', value } : { action: 'clear' }, value)
    }
    updateForm(previous => {
      const next = updateSimplifiedDraftValue(previous, field, value, capability)
      if (next.config !== previous.config) setConfigText(JSON.stringify(next.config, null, 2))
      return next
    })
  }

  const setDisableResponsesWebsocket = (enabled: boolean) => {
    if (!websocketCapability) return
    updateForm(previous => {
      const next = updateProviderBooleanConfig(previous, websocketCapability, enabled)
      setConfigText(JSON.stringify(next.config, null, 2))
      return next
    })
  }

  const setFastMode = (selection: string) => {
    if (!fastModeCapability) return
    updateForm(previous => {
      const next = updateProviderBooleanConfig(
        previous,
        fastModeCapability,
        selection === 'inherit' ? undefined : selection === 'fast',
      )
      setConfigText(JSON.stringify(next.config, null, 2))
      return next
    })
  }

  const handleAgentTypeChange = (value: string) => {
    if (dirty && !window.confirm(t('切换 Agent 类型会清空当前类型的配置，是否继续？'))) return
    const { agentType, runtimeType } = parseProviderAgentOption(value)
    const nextCapability = PROVIDER_CAPABILITIES[agentType]
    const config = runtimeType === RuntimeType.ACP
      ? { permissionMode: 'ASK' }
      : getDefaultConfigForAgentType()
    const next: ProviderFormData = {
      ...formData,
      agentType,
      runtimeType,
      config,
      settings: '',
      env: [],
      simplified: {
        apiKey: nextCapability.apiKey
          ? { configured: false, envKey: nextCapability.apiKey.path }
          : undefined,
      },
    }
    commitDraftChange(() => next)
    setConfigText(JSON.stringify(config, null, 2))
    setConfigError('')
    setSettingsError('')
    setSettingsTouched(false)
    setSimplifiedTouched(new Set())
    setConflicts([])
    setConflictResolutions({})
  }

  const validateAdvanced = (forTest = false): boolean => {
    let valid = !configError && !permissionState.error && !acpPermissionModeError && !fastModeState?.error && !websocketState?.error && !reasoningEffortError
    const settings = formData.settings.trim()
    if (settings && (settingsTouched || forTest)) {
      try {
        if (formData.agentType === AgentType.CODEX) parseToml(settings)
        else if (formData.agentType === AgentType.CLAUDE_CODE) {
          const parsed = JSON.parse(settings) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('JSON 顶层必须是对象'))
        }
        setSettingsError('')
      } catch (error) {
        setSettingsError(t('{format} 语法错误: {message}', {
          format: formData.agentType === AgentType.CODEX ? 'TOML' : 'JSON',
          message: error instanceof Error ? error.message : String(error),
        }))
        valid = false
      }
    }
    return valid
  }

  const buildDraft = (): ProviderDraftInput => {
    const env = buildProviderEnvWrites(formData.env)
    const simplified = Object.fromEntries(
      [...simplifiedTouched].map(field => [field, formData.simplified[field]]),
    ) as ProviderSimplifiedConfig
    return {
      providerId,
      name: formData.name,
      agentType: formData.agentType,
      runtimeType: formData.runtimeType,
      env,
      config: formData.config,
      settings: formData.settings,
      simplified: simplifiedTouched.size > 0 ? simplified : undefined,
      conflictResolutions,
      isDefault: formData.isDefault,
    }
  }

  const handleSave = () => {
    if (apiBaseUrlError || !validateAdvanced(false)) return
    const draft = buildDraft()
    const data = { ...draft }
    delete data.providerId
    if (providerId) delete data.runtimeType
    onSave(data)
  }

  const handleTest = () => {
    if (apiBaseUrlError || conflicts.length > 0 || !validateAdvanced(true)) return
    const requestId = testSequence.current.begin()
    setTestResult(null)
    testProvider.mutate(buildDraft(), {
      onSuccess: result => {
        if (testSequence.current.isCurrent(requestId)) setTestResult(result)
      },
      onError: error => {
        if (testSequence.current.isCurrent(requestId)) {
          setTestResult({
            ok: false,
            stage: 'connection',
            errorKind: 'unknown',
            summary: getErrorMessage(error, t('测试配置失败')),
          })
        }
      },
    })
  }

  if (!isOpen) return null

  const showSettingsPanel = hasSettingsPanel(formData.agentType)
  const isCodex = formData.agentType === AgentType.CODEX
  const usesNativeCodexConnection = isCodex && usesCodexNativeModelProvider(formData.settings)
  const apiKeyPath = formData.simplified.apiKey?.envKey ?? capability.apiKey?.path
  const apiKeyRow = apiKeyPath ? getEnvRow(apiKeyPath) : undefined
  const apiKeyStatus = getApiKeyDraftStatus(
    apiKeyRow,
    !!formData.simplified.apiKey?.configured,
    conflictResolutions.apiKey,
  )
  const apiKeyAdvancedManaged = apiKeyStatus === 'advanced'
  const keyConfigured = apiKeyStatus !== 'unconfigured'
  const saveBlocked = !formData.name.trim() || !!apiBaseUrlError || !!configError || !!permissionState.error || !!acpPermissionModeError || !!fastModeState?.error || !!websocketState?.error || !!reasoningEffortError || (!!settingsError && settingsTouched) || conflicts.length > 0

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title={initialData ? t('编辑 Provider') : t('新建 Provider')}
      className="max-w-3xl"
      action={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="outline" onClick={handleTest} disabled={testProvider.isPending || !!apiBaseUrlError || !!configError || !!permissionState.error || !!acpPermissionModeError || !!fastModeState?.error || !!websocketState?.error || !!reasoningEffortError || (!!settingsError && settingsTouched) || conflicts.length > 0}>
            {testProvider.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}
            {testProvider.isPending ? t('测试中...') : t('测试配置')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={requestClose}>{t('取消')}</Button>
            <Button onClick={handleSave} disabled={saveBlocked}>{t('保存 Provider')}</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="provider-name" className="mb-1 block text-xs font-medium text-foreground">{t('名称')}</label>
            <Input
              id="provider-name"
              value={formData.name}
              onChange={e => updateForm(previous => ({ ...previous, name: e.target.value }))}
              placeholder={t('例如: Claude Code (官方)')}
            />
          </div>
          {!initialData && (
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">{t('Agent 类型')}</label>
              <Select
                value={getProviderAgentOption(formData.agentType, formData.runtimeType)}
                onChange={handleAgentTypeChange}
                options={USER_VISIBLE_AGENT_TYPES.flatMap(agentType => (
                  AGENT_RUNTIME_SUPPORT[agentType].map(runtimeType => ({
                    value: getProviderAgentOption(agentType, runtimeType),
                    label: getProviderAgentLabel(agentType, runtimeType),
                    icon: <AgentLogo agentType={agentType} className="size-4" />,
                  }))
                ))}
                placeholder={t('选择 Agent 类型')}
              />
            </div>
          )}
          {initialData && (
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">{t('Agent 类型')}</label>
              <div className="flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-muted/30 px-3 text-sm text-muted-foreground">
                <AgentLogo agentType={formData.agentType} className="size-4" />
                <span className="min-w-0 truncate">{getProviderAgentLabel(formData.agentType, formData.runtimeType)}</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="isDefault"
            checked={formData.isDefault}
            onChange={e => updateForm(previous => ({ ...previous, isDefault: e.target.checked }))}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          <label htmlFor="isDefault" className="text-sm text-foreground">
            {t('设为该类型的默认 Provider')}
          </label>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <div className="text-sm font-medium text-foreground">{t('基本配置')}</div>
          {formData.runtimeType === RuntimeType.ACP && (
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground">{t('权限策略')}</label>
              <Select
                value={acpPermissionMode}
                onChange={permissionMode => {
                  updateForm(previous => {
                    const config: Record<string, unknown> = { ...previous.config, permissionMode }
                    delete config.acpPermissionMode
                    const next = { ...previous, config }
                    setConfigText(JSON.stringify(next.config, null, 2))
                    return next
                  })
                }}
                options={[
                  { value: 'ASK', label: t('每次询问') },
                  { value: 'UNRESTRICTED', label: t('无限制') },
                ]}
              />
              {acpPermissionMode === 'UNRESTRICTED' && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {t('Agent 将拥有完全访问电脑的权限')}
                </p>
              )}
              {acpPermissionModeError && (
                <p role="alert" className="mt-1 text-xs text-destructive">{acpPermissionModeError}</p>
              )}
            </div>
          )}
          {capability.apiBaseUrl && !usesNativeCodexConnection && (
            <div>
              <label htmlFor="provider-api-url" className="mb-1 block text-xs font-medium text-foreground">{t('API 地址')}</label>
              <Input
                id="provider-api-url"
                type="url"
                value={formData.simplified.apiBaseUrl ?? ''}
                onChange={event => updateSimple('apiBaseUrl', event.target.value)}
                placeholder={capability.apiBaseUrl.placeholder}
                aria-invalid={!!apiBaseUrlError}
                aria-describedby={apiBaseUrlError ? 'provider-api-url-error' : undefined}
              />
              {apiBaseUrlError && (
                <p id="provider-api-url-error" role="alert" className="mt-1 text-xs text-destructive">
                  {t('请输入以 http:// 或 https:// 开头的完整 API 地址')}
                </p>
              )}
            </div>
          )}
          {capability.apiKey && !usesNativeCodexConnection && (formData.agentType !== AgentType.CODEX || !!formData.simplified.apiKey) && (
            <div>
              <div className="mb-1 flex items-center justify-between gap-3">
                <label htmlFor="provider-api-key" className="text-xs font-medium text-foreground">API Key</label>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <KeyRound size={12} />
                  {apiKeyAdvancedManaged ? t('由高级配置管理') : keyConfigured ? t('已配置') : t('未配置')}
                </span>
              </div>
              {apiKeyRow?.write.action === 'replace' || !keyConfigured ? (
                <div className="flex gap-2">
                  <Input
                    id="provider-api-key"
                    type="password"
                    autoComplete="new-password"
                    value={apiKeyRow?.value ?? ''}
                    onChange={event => setEnvWrite(apiKeyPath!, { action: 'replace', value: event.target.value }, event.target.value)}
                    placeholder={t('输入 API Key')}
                  />
                  {formData.simplified.apiKey?.configured && (
                    <Button variant="outline" size="sm" onClick={() => setEnvWrite(apiKeyPath!, { action: 'keep' })}>{t('取消替换')}</Button>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEnvWrite(apiKeyPath!, { action: 'replace', value: '' })}>{t('替换')}</Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(t('确定清除此 API Key？'))) setEnvWrite(apiKeyPath!, { action: 'clear' })
                    }}
                  >
                    {t('清除')}
                  </Button>
                </div>
              )}
            </div>
          )}
          <div>
            <label htmlFor="provider-model" className="mb-1 block text-xs font-medium text-foreground">{t('模型')}</label>
            {formData.agentType === AgentType.CURSOR_AGENT ? (
              <CursorAgentModelField value={formData.simplified.model ?? ''} onChange={value => updateSimple('model', value ?? '')} />
            ) : (
              <Input
                id="provider-model"
                value={formData.simplified.model ?? ''}
                onChange={event => updateSimple('model', event.target.value)}
                placeholder={capability.model.placeholder}
              />
            )}
          </div>
          {capability.reasoningEffort && (
            <SegmentedEffortSlider
              options={(capability.reasoningEffort.options ?? []).map(value => ({
                value,
                label: t(getEffortLabel(value)),
              }))}
              value={reasoningEffort}
              onChange={value => updateSimple('reasoningEffort', value)}
              label={t('思考强度')}
              efficiencyLabel={t('更高效')}
              intelligenceLabel={t('更智能')}
              followCliLabel={t('跟随 CLI')}
              currentLabel={t('当前')}
              error={reasoningEffortError}
            />
          )}
          {fastModeCapability && fastModeState && (
            <section className="border-t border-border pt-3" data-fast-mode-control>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">{t('Fast 模式')}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t('支持的模型速度约提升至 1.5 倍，并增加用量消耗。ChatGPT 登录消耗更多额度；API Key 按 Priority 处理计费。')}
                  </div>
                </div>
                <Select
                  value={fastModeSelection}
                  disabled={!!fastModeState.error}
                  onChange={setFastMode}
                  options={[
                    { value: 'inherit', label: t('跟随 Codex') },
                    { value: 'standard', label: t('标准速度') },
                    { value: 'fast', label: 'Fast' },
                  ]}
                />
              </div>
              {fastModeState.error && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  {t('Fast 模式字段必须为 true 或 false，请在运行配置 JSON 中修正。')}
                </p>
              )}
            </section>
          )}
          {websocketCapability && websocketState && (
            <section className="border-t border-border pt-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">{t('禁用 WebSocket')}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {usesNativeCodexConnection
                      ? t('当前原生 Provider 已使用非 WebSocket 传输；此开关不会添加额外运行时覆盖。')
                      : t('仅禁用 Codex Responses API 的 WebSocket 传输；新启动和后续继续的请求将使用 HTTP。')}
                  </div>
                </div>
                <Switch
                  checked={websocketState.enabled}
                  disabled={!!websocketState.error}
                  onCheckedChange={setDisableResponsesWebsocket}
                  aria-label={t('禁用 WebSocket')}
                />
              </div>
              {websocketState.error && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  {t('禁用 WebSocket 字段必须为 true 或 false，请在运行配置 JSON 中修正。')}
                </p>
              )}
            </section>
          )}
        </div>

        {testResult && <ProviderDraftTestResultPanel result={testResult} />}

        {conflicts.length > 0 && (
          <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle size={16} className="text-warning" />
              {t('需要解决配置冲突')}
            </div>
            {conflicts.map(conflict => (
              <div key={conflict.field} className="flex flex-col gap-2 rounded-md border border-warning/20 bg-background/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{t(getDiagnosticFieldLabel(conflict.field))}</span>
                  {' · '}{t('简化字段与高级配置值不同')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {(['simple', 'advanced'] as const).map(resolution => (
                    <Button
                      key={resolution}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const field = conflict.field
                        const resolved = resolveProviderDraftConflict(formData, field, resolution, capability)
                        updateForm(() => resolved)
                        setConfigText(JSON.stringify(resolved.config, null, 2))
                        setConflictResolutions(previous => ({ ...previous, [field]: resolution }))
                        if (
                          resolution === 'advanced'
                          && (field === 'apiBaseUrl' || field === 'model' || field === 'reasoningEffort')
                        ) {
                          setSimplifiedTouched(previous => {
                            const next = new Set(previous)
                            next.delete(field)
                            return next
                          })
                        }
                        setConflicts(previous => previous.filter(item => item.field !== field))
                      }}
                    >
                      {resolution === 'simple' ? t('采用简化值') : t('保留高级值')}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <CollapsibleSection
          title={t('高级配置')}
          defaultOpen={!!configError || !!settingsError || !!permissionState.error || !!fastModeState?.error || conflicts.length > 0}
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">{t('运行配置 (JSON)')}</label>
            <Textarea
              value={configText}
              onChange={event => {
                const text = event.target.value
                setConfigText(text)
                try {
                  const parsed = JSON.parse(text) as unknown
                  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('JSON 顶层必须是对象'))
                  const config = parsed as Record<string, unknown>
                  setConfigError('')
                  setSimplifiedTouched(previous => {
                    const next = new Set(previous).add('model' as const)
                    if (capability.reasoningEffort?.kind === 'config') next.add('reasoningEffort')
                    return next
                  })
                  updateForm(previous => ({
                    ...previous,
                    config,
                    simplified: syncSimplifiedFromConfig(previous.simplified, config, capability),
                  }))
                } catch (error) {
                  commitDraftChange()
                  setConfigError(error instanceof Error ? error.message : t('JSON 语法错误'))
                }
              }}
              rows={7}
              className="font-mono"
              aria-invalid={!!configError}
            />
            {configError && <p role="alert" className="mt-1 text-xs text-destructive">{configError}</p>}
            {permissionState.error && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {t('执行权限字段必须为 true 或 false，请在运行配置 JSON 中修正。')}
              </p>
            )}
          </div>

          <div className="border-t border-border pt-3">
            <label className="mb-2 block text-xs font-medium text-foreground">{t('环境变量')}</label>
          <p className="text-xs text-muted-foreground mb-2">
            {t('注入到 Agent 进程的环境变量。Codex 的')} <code className="rounded bg-muted px-1">env_key</code> {t('指定的是变量名，实际值需在此处设置。')}
          </p>
          <div className="space-y-2">
            {formData.env.map((row, i) => row.write.action !== 'clear' && (
              <div key={i} className="flex gap-2 items-center">
                <Input
                  value={row.key}
                  disabled={row.configured}
                  onChange={e => {
                    const key = e.target.value
                    updateForm(previous => {
                      const next = [...previous.env]
                      const current = next[i]
                      if (!current) return previous
                      const updated = { ...current, key }
                      next[i] = {
                        ...updated,
                        sensitive: isProviderEnvDraftRowSensitive(updated, previous.simplified),
                      }
                      return { ...previous, env: next }
                    })
                  }}
                  placeholder={t('变量名，如 AZURE_OPENAI_API_KEY')}
                  className="flex-1 py-1.5 font-mono"
                />
                <Input
                  value={row.value}
                  type={isProviderEnvDraftRowSensitive(row, formData.simplified) ? 'password' : 'text'}
                  onChange={e => {
                    const next = [...formData.env]
                    next[i] = { ...next[i], value: e.target.value, write: { action: 'replace', value: e.target.value } }
                    updateForm(previous => ({
                      ...previous,
                      env: next,
                      simplified: row.key === capability.apiBaseUrl?.path
                        ? { ...previous.simplified, apiBaseUrl: e.target.value }
                        : previous.simplified,
                    }))
                    if (row.key === capability.apiBaseUrl?.path) {
                      setSimplifiedTouched(previous => new Set(previous).add('apiBaseUrl'))
                    }
                  }}
                  placeholder={row.configured && row.write.action === 'keep' ? t('已配置，输入新值以替换') : t('值')}
                  className="flex-1 py-1.5 font-mono"
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = [...formData.env]
                    if (row.configured) next[i] = { ...row, value: '', write: { action: 'clear' } }
                    else next.splice(i, 1)
                    updateForm(previous => ({
                      ...previous,
                      env: next,
                      simplified: row.key === capability.apiBaseUrl?.path
                        ? { ...previous.simplified, apiBaseUrl: '' }
                        : previous.simplified,
                    }))
                    if (row.key === capability.apiBaseUrl?.path) {
                      setSimplifiedTouched(previous => new Set(previous).add('apiBaseUrl'))
                    }
                  }}
                  aria-label={t('删除')}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateForm(previous => ({
                ...previous,
                env: [...previous.env, {
                  key: '', value: '', write: { action: 'replace', value: '' }, configured: false, sensitive: false,
                }],
              }))}
            >
              <Plus size={12} className="mr-1" />
              {t('添加变量')}
            </Button>
            </div>
          </div>

        {showSettingsPanel && (
          <div className="border-t border-border pt-3">
            <label className="mb-2 block text-xs font-medium text-foreground">
              {isCodex ? t('Agent 原生配置 (config.toml)') : t('Agent 原生配置 (settings.json)')}
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              {isCodex ? (
                <>
                  {t('直接填写 Codex')} <code className="rounded bg-muted px-1">config.toml</code> {t('格式的配置片段，由当前 Runtime 注入。不会修改你的')} <code className="rounded bg-muted px-1">~/.codex/config.toml</code> {t('文件。')}
                </>
              ) : (
                <>
                  {t('对应 Claude Code 的')} <code className="rounded bg-muted px-1">~/.claude/settings.json</code>，{t('由当前 Runtime 注入。在')} <code className="rounded bg-muted px-1">env</code> {t('中设置 ANTHROPIC_API_KEY、ANTHROPIC_BASE_URL 等。')}
                </>
              )}
            </p>
            <Textarea
              value={formData.settings}
              onChange={e => {
                const settings = e.target.value
                setSettingsTouched(true)
                setSettingsError('')
                let parsedSimplified: ProviderSimplifiedConfig | undefined
                if (isCodex) {
                  try {
                    parsedSimplified = syncSimplifiedFromSettings(formData.simplified, settings, AgentType.CODEX)
                    setSimplifiedTouched(current => new Set(current).add('reasoningEffort'))
                  } catch {
                    // Keep the simple value until the advanced text is valid again.
                  }
                }
                updateForm(previous => {
                  const simplified = parsedSimplified === undefined
                    ? previous.simplified
                    : syncSimplifiedFromSettings(
                        previous.simplified,
                        settings,
                        AgentType.CODEX,
                        new Set(previous.env.flatMap(row => {
                          if (row.write.action === 'clear') return []
                          if (row.write.action === 'replace') return row.value ? [row.key] : []
                          return row.configured ? [row.key] : []
                        })),
                      )
                  return {
                    ...previous,
                    settings,
                    env: markActiveCredentialEnvRowSensitive(previous.env, simplified),
                    simplified,
                  }
                })
              }}
              rows={10}
              className="font-mono"
              placeholder={getSettingsTemplate(formData.agentType, locale)}
              aria-invalid={!!settingsError}
            />
            {settingsError && (
              <p role="alert" className="mt-1 text-xs text-destructive">{settingsError}</p>
            )}
          </div>
        )}
        </CollapsibleSection>
      </div>
    </Modal>
    </>
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
          <Button variant="outline" onClick={onClose} disabled={isLoading}>{t('取消')}</Button>
          <Button onClick={onConfirm} disabled={!acknowledged || isLoading}>
            {isLoading ? t('导出中...') : t('导出备份')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-foreground">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <span>{t('导出的备份文件将包含完整的 Provider 配置，包括环境变量、CLI settings 等敏感信息。任何拿到文件的人都可能直接使用这些 Provider。')}</span>
        </div>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{t('这个功能用于备份和迁移，不用于分享配置。')}</p>
          <p>{t('导出内容只包含用户层配置：自定义 Provider，以及对内置 Provider 的覆盖。')}</p>
        </div>
        <label className="flex items-start gap-3 rounded-lg border border-border px-4 py-3 text-sm text-foreground">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={e => onAcknowledgedChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
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
    const order: Record<ProviderImportAction, number> = { CREATE: 0, OVERWRITE: 1, SKIP: 2 }
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
          <Button variant="outline" onClick={onClose} disabled={isLoading}>{t('取消')}</Button>
          <Button onClick={onConfirm} disabled={importableCount === 0 || isLoading}>
            {isLoading ? t('导入中...') : t('确认导入 {count} 项', { count: importableCount })}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <div>{t('导出时间：{value}', { value: new Date(backup.exportedAt).toLocaleString() })}</div>
          <div>{t('模式：完整备份（含敏感信息）')}</div>
          <div>{t('文件内 Provider 数量：{count}', { count: backup.providers.length })}</div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-success/25 bg-success/10 px-4 py-3">
            <div className="text-xs font-medium text-success">{t('新增')}</div>
            <div className="text-lg font-semibold text-foreground">{preview.summary.create}</div>
          </div>
          <div className="rounded-lg border border-warning/25 bg-warning/10 px-4 py-3">
            <div className="text-xs font-medium text-warning">{t('覆盖')}</div>
            <div className="text-lg font-semibold text-foreground">{preview.summary.overwrite}</div>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground">{t('跳过')}</div>
            <div className="text-lg font-semibold text-foreground">{preview.summary.skip}</div>
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto space-y-3 pr-1">
          {sortedItems.map(item => {
            const meta = getImportActionMeta(item.action)
            return (
              <div key={item.incoming.id} className="rounded-lg border border-border px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="truncate text-sm font-medium text-foreground">{item.incoming.name}</h4>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
                        {t(meta.label)}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <AgentLogo agentType={item.incoming.agentType} className="size-3.5" />
                      <span className="min-w-0 truncate">{getProviderAgentLabel(item.incoming.agentType, item.incoming.runtimeType)}</span>
                      {' · '}
                      <code className="rounded bg-muted px-1 py-0.5">{item.incoming.id}</code>
                    </div>
                  </div>
                </div>
                {item.action === 'OVERWRITE' && item.existing && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('将覆盖当前已有的 Provider：{name}', { name: item.existing.name })}
                  </p>
                )}
                {item.action === 'SKIP' && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('当前同 ID Provider 配置一致，本次不会重复写入。')}
                  </p>
                )}
                {item.action === 'CREATE' && (
                  <p className="mt-2 text-xs text-muted-foreground">
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

function ProviderDetailPanel({
  item,
  onEdit,
  onDelete,
}: {
  item: ProviderWithAvailability
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const provider = item.provider
  const availability = item.availability
  const normalizedConfig = normalizeProviderConfig(provider.agentType as AgentType, provider.config)
  const capability = PROVIDER_CAPABILITIES[provider.agentType as AgentType]
  const configEntries = Object.entries(normalizedConfig).filter(([k]) => (
    k !== 'cmd' && k !== capability.executionPermission.path
  ))
  const envKeys = Object.keys(provider.redactedEnv || {})

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <h3 className="min-w-0 truncate text-base font-semibold text-foreground">{provider.name}</h3>
            <AvailabilityBadge type={availability.type} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <AgentLogo agentType={provider.agentType} className="size-3.5" />
              <span className="truncate">{getProviderAgentLabel(provider.agentType, provider.runtimeType)}</span>
            </span>
            {provider.isDefault && (
              <span className="rounded-full bg-primary/[0.06] px-2 py-0.5 text-[11px] font-medium text-primary">
                {t('默认')}
              </span>
            )}
            {provider.builtIn && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {t('内置')}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil size={13} />
            {t('编辑')}
          </Button>
          <Button
            size="sm"
            variant={provider.builtIn ? 'outline' : 'destructive'}
            onClick={onDelete}
            disabled={provider.deletable === false}
          >
            {provider.builtIn ? <RotateCcw size={13} /> : <Trash2 size={13} />}
            {provider.builtIn ? t('恢复默认') : t('删除')}
          </Button>
        </div>
      </div>

      {configEntries.length > 0 && (
        <div>
          <SettingsSectionTitle className="mb-3">{t('运行配置')}</SettingsSectionTitle>
          <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border/60">
            {configEntries.map(([k, v]) => (
              <div key={k} className="flex min-w-0 flex-col items-start gap-1 bg-background px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                <span className="min-w-0 break-words text-[13px] text-muted-foreground sm:w-32 sm:shrink-0">{t(CONFIG_FIELD_LABELS[k] ?? k)}</span>
                <span className="min-w-0 max-w-full break-all font-mono text-[13px] text-foreground">{formatConfigValue(k, v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {envKeys.length > 0 && (
        <div>
          <SettingsSectionTitle className="mb-3">{t('环境变量')}</SettingsSectionTitle>
          <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border/60">
            {envKeys.map(k => (
              <div key={k} className="flex min-w-0 flex-wrap items-center gap-2 bg-background px-4 py-2.5 sm:gap-4">
                <span className="min-w-0 max-w-full break-all font-mono text-[13px] text-foreground">{k}</span>
                <span className="text-[13px] text-muted-foreground" aria-label="hidden">•••••</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {provider.settings?.trim() && (
        <div>
          <SettingsSectionTitle className="mb-3">{t('Agent 原生配置')}</SettingsSectionTitle>
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <pre className="max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {provider.settings}
            </pre>
          </div>
        </div>
      )}

      {configEntries.length === 0 && envKeys.length === 0 && !provider.settings?.trim() && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t('该 Provider 未配置额外参数。点击"编辑"添加运行配置、环境变量或 Agent 原生配置。')}
        </div>
      )}
    </div>
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editModal, setEditModal] = useState<{ id?: string; data?: ProviderFormData } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string; builtIn?: boolean } | null>(null)
  const [isExportBackupOpen, setIsExportBackupOpen] = useState(false)
  const [exportAcknowledged, setExportAcknowledged] = useState(false)
  const [importPreviewState, setImportPreviewState] = useState<{
    backup: ProviderBackupFile
    preview: ProviderImportPreview
  } | null>(null)
  const [mobileShowDetail, setMobileShowDetail] = useState(false)

  const providers = providersData ?? []
  const effectiveSelectedId = selectedId ?? providers[0]?.provider.id ?? null

  const handleCreate = (data: CreateProviderInput) => {
    createProvider.mutate(data, {
      onSuccess: () => setEditModal(null),
      onError: error => toast.error(getErrorMessage(error, t('创建 Provider 失败'))),
    })
  }

  const handleUpdate = (id: string, data: UpdateProviderInput) => {
    updateProvider.mutate(
      { id, data },
      {
        onSuccess: () => setEditModal(null),
        onError: error => toast.error(getErrorMessage(error, t('更新 Provider 失败'))),
      },
    )
  }

  const handleDelete = (provider: { id: string; name: string; builtIn?: boolean; deletable?: boolean }) => {
    const canDelete = provider.deletable ?? !provider.builtIn
    if (!canDelete) {
      toast.error(t('系统内置 Provider 不可删除'))
      return
    }
    setDeleteConfirm({ id: provider.id, name: provider.name, builtIn: provider.builtIn })
  }

  const handleConfirmDelete = () => {
    if (!deleteConfirm) return
    deleteProvider.mutate(deleteConfirm.id, {
      onSuccess: () => {
        toast.success(deleteConfirm.builtIn ? t('已恢复默认 Provider 配置') : t('Provider 已删除'))
        if (effectiveSelectedId === deleteConfirm.id) setSelectedId(null)
        setDeleteConfirm(null)
        setMobileShowDetail(false)
      },
      onError: error => toast.error(getErrorMessage(error, t('删除 Provider 失败'))),
    })
  }

  const closeExportBackup = () => {
    setIsExportBackupOpen(false)
    setExportAcknowledged(false)
  }

  const closeImportPreview = () => setImportPreviewState(null)

  const handleExportBackup = () => {
    exportProviderBackup.mutate(undefined, {
      onSuccess: backup => {
        downloadJsonFile(formatBackupFilename(backup.exportedAt), backup)
        toast.success(t('Provider 备份已导出'))
        closeExportBackup()
      },
      onError: error => toast.error(getErrorMessage(error, t('导出 Provider 备份失败'))),
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
    try { parsed = JSON.parse(await file.text()) as ProviderBackupFile } catch {
      toast.error(t('备份文件不是有效的 JSON'))
      return
    }

    previewProviderImport.mutate(parsed, {
      onSuccess: preview => setImportPreviewState({ backup: parsed, preview }),
      onError: error => toast.error(getErrorMessage(error, t('导入预览失败'))),
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
      onError: error => toast.error(getErrorMessage(error, t('导入 Provider 备份失败'))),
    })
  }

  const openEdit = (item: ProviderWithAvailability) => {
    const p = item.provider
    const capability = PROVIDER_CAPABILITIES[p.agentType as AgentType]
    const envEntries = createProviderEnvDraftRows(p, capability)
    setEditModal({
      id: p.id,
      data: {
        name: p.name,
        agentType: p.agentType as AgentType,
        runtimeType: p.runtimeType === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI,
        config: normalizeProviderConfig(p.agentType as AgentType, p.config),
        settings: p.settings ?? '',
        env: envEntries,
        simplified: p.simplified ?? {},
        diagnostics: p.diagnostics,
        isDefault: p.isDefault,
      },
    })
  }

  if (isLoading) {
    return (
      <SettingsPageContainer className="max-w-5xl">
        <SettingsMasterDetailSkeleton />
      </SettingsPageContainer>
    )
  }

  return (
    <SettingsPageContainer className="max-w-5xl">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFileChange}
      />

      <SettingsPageHeader
        title={t('Agent 配置')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={handleOpenImportFile} disabled={previewProviderImport.isPending || importProviderBackup.isPending}>
              <Upload size={13} />
              {t('导入')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setIsExportBackupOpen(true)} disabled={exportProviderBackup.isPending}>
              <Download size={13} />
              {t('导出')}
            </Button>
            <Button size="sm" onClick={() => setEditModal({})}>
              <Plus size={13} className="mr-1" />
              {t('新建')}
            </Button>
          </>
        }
      />

      {providers.length === 0 ? (
        <SettingsEmptyState
          icon={Cpu}
          message={t('暂无 Agent 配置')}
          action={
            <Button size="sm" onClick={() => setEditModal({})}>
              <Plus size={13} className="mr-1" />
              {t('新建配置')}
            </Button>
          }
        />
      ) : (
        <SettingsMasterDetail
          items={providers}
          selectedId={effectiveSelectedId}
          onSelectItem={(id) => {
            setSelectedId(id)
            setMobileShowDetail(true)
          }}
          getItemId={(item) => item.provider.id}
          mobileShowDetail={mobileShowDetail}
          onMobileBack={() => setMobileShowDetail(false)}
          renderListItem={(item, isActive) => {
            const p = item.provider
            return (
              <>
                <AvailabilityDot type={item.availability.type} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{p.name}</div>
                  <div className={cn('flex min-w-0 items-center gap-1.5 text-[11px]', isActive ? 'text-primary-foreground/60' : 'text-muted-foreground')}>
                    <AgentLogo
                      agentType={p.agentType}
                      className="size-3.5"
                      fallbackClassName={isActive ? 'text-primary-foreground/70' : 'text-muted-foreground'}
                    />
                    <span className="min-w-0 truncate">{getProviderAgentLabel(p.agentType, p.runtimeType)}</span>
                  </div>
                </div>
                {p.isDefault && (
                  <span className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    isActive ? 'bg-white/20 text-primary-foreground' : 'bg-primary/[0.06] text-primary',
                  )}>
                    {t('默认')}
                  </span>
                )}
              </>
            )
          }}
          renderDetail={(item) =>
            item ? (
              <div className="min-w-0 p-5">
                <ProviderDetailPanel
                  item={item}
                  onEdit={() => openEdit(item)}
                  onDelete={() => handleDelete(item.provider)}
                />
              </div>
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">
                {t('选择一个 Provider 查看详情')}
              </div>
            )
          }
        />
      )}

      {editModal && (
        <ProviderFormModal
          isOpen={true}
          onClose={() => setEditModal(null)}
          providerId={editModal.id}
          initialData={editModal.data}
          onSave={data => {
            if (editModal.id) handleUpdate(editModal.id, data)
            else handleCreate(data as CreateProviderInput)
          }}
        />
      )}

      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        onClose={() => { if (!deleteProvider.isPending) setDeleteConfirm(null) }}
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
    </SettingsPageContainer>
  )
}
