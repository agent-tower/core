# Provider 配置系统实现计划

## 概述

引入 **Provider（提供者）** 概念，作为用户在创建任务时选择 Agent 的一等公民。每个 Provider 绑定一个 AgentType + 连接配置（API URL、Key、Model 等环境变量）+ 运行模式配置。替代现有的 profiles/variant 系统。

## 核心概念

```
Provider = AgentType + 名称 + 环境变量(连接配置) + 运行参数
```

示例：
```
├── Claude Code (官方)     → CLAUDE_CODE + { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-xxx" }
├── Claude Code (中转)     → CLAUDE_CODE + { ANTHROPIC_BASE_URL: "https://proxy.example.com", ANTHROPIC_API_KEY: "sk-yyy", model: "claude-opus-4-20250514" }
├── Gemini CLI (默认)      → GEMINI_CLI + {}
└── Codex (默认)           → CODEX + {}
```

## 数据模型

### 新配置文件结构：`providers.json`

替换现有的 `profiles.json`，存储在 `$AGENT_TOWER_DATA_DIR/providers.json`：

```json
{
  "providers": [
    {
      "id": "claude-official",
      "name": "Claude Code (官方)",
      "agentType": "CLAUDE_CODE",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
        "ANTHROPIC_API_KEY": "sk-ant-xxx"
      },
      "config": {
        "dangerouslySkipPermissions": true,
        "model": "claude-sonnet-4-20250514"
      },
      "isDefault": true,
      "createdAt": "2026-03-17T00:00:00Z"
    },
    {
      "id": "claude-proxy",
      "name": "Claude Code (中转)",
      "agentType": "CLAUDE_CODE",
      "env": {
        "ANTHROPIC_BASE_URL": "https://proxy.example.com",
        "ANTHROPIC_API_KEY": "sk-proxy-yyy"
      },
      "config": {
        "dangerouslySkipPermissions": true,
        "model": "claude-opus-4-20250514"
      },
      "isDefault": false,
      "createdAt": "2026-03-17T00:00:00Z"
    }
  ]
}
```

字段说明：
- `id`: 唯一标识符（自动生成或用户自定义 slug）
- `name`: 显示名称
- `agentType`: 底层 Agent 类型（CLAUDE_CODE / GEMINI_CLI / CURSOR_AGENT / CODEX）
- `env`: 环境变量，启动进程时注入（API URL、API Key 等敏感信息）
- `config`: Agent 运行参数（对应现有 VariantConfig，如 dangerouslySkipPermissions、model、plan 等）
- `isDefault`: 是否为该 AgentType 的默认 provider（每个 AgentType 最多一个默认）

### 内置默认 Providers：`default-providers.json`

替换现有 `default-profiles.json`，为每个 AgentType 提供一个开箱即用的默认 Provider：

```json
{
  "providers": [
    {
      "id": "claude-code-default",
      "name": "Claude Code",
      "agentType": "CLAUDE_CODE",
      "env": {},
      "config": { "dangerouslySkipPermissions": true },
      "isDefault": true,
      "builtIn": true
    },
    {
      "id": "gemini-cli-default",
      "name": "Gemini CLI",
      "agentType": "GEMINI_CLI",
      "env": {},
      "config": { "yolo": true },
      "isDefault": true,
      "builtIn": true
    },
    {
      "id": "cursor-agent-default",
      "name": "Cursor Agent",
      "agentType": "CURSOR_AGENT",
      "env": {},
      "config": { "force": true, "model": "auto" },
      "isDefault": true,
      "builtIn": true
    },
    {
      "id": "codex-default",
      "name": "Codex",
      "agentType": "CODEX",
      "env": {},
      "config": { "fullAuto": true },
      "isDefault": true,
      "builtIn": true
    }
  ]
}
```

### DB Schema 变更

Session 表新增 `providerId` 字段：

```prisma
model Session {
  // ... 现有字段
  agentType    String           // 保留，仍然需要知道底层 agent 类型
  variant      String  @default("DEFAULT")  // 保留向后兼容，新逻辑不再使用
  providerId   String?          // 新增：关联 Provider ID
  // ...
}
```

> 保留 `agentType` 字段不变，因为 parser 选择、能力检测等仍然依赖它。`providerId` 作为新增字段，旧数据 providerId 为 null 时走原有逻辑。

## 实现步骤

### 第一步：后端 Provider 配置管理

**新建** `packages/server/src/executors/providers.ts`

替代 `profiles.ts` 的角色，负责：
- 加载 `default-providers.json`（内置默认）
- 加载 `$AGENT_TOWER_DATA_DIR/providers.json`（用户自定义）
- 合并逻辑：内置 providers 始终存在，用户可新增 provider、覆盖内置 provider 的 config
- CRUD 操作：getAll / getById / create / update / delete
- 导出 `getProviderExecutor(providerId)` —— 根据 provider 创建配置好环境变量的 executor

核心类型：

```typescript
interface Provider {
  id: string;
  name: string;
  agentType: AgentType;
  env: Record<string, string>;      // 注入到进程的环境变量
  config: Record<string, unknown>;   // Agent 运行参数（原 VariantConfig）
  isDefault: boolean;
  builtIn?: boolean;                 // 标记是否内置
  createdAt?: string;
}
```

核心函数：

```typescript
// 获取所有 providers（内置 + 用户自定义合并）
function getAllProviders(): Provider[]

// 根据 ID 获取
function getProviderById(id: string): Provider | null

// 根据 agentType 获取所有 providers
function getProvidersByAgentType(agentType: AgentType): Provider[]

// CRUD
function createProvider(data: Omit<Provider, 'id' | 'createdAt'>): Provider
function updateProvider(id: string, data: Partial<Provider>): Provider
function deleteProvider(id: string): boolean

// 根据 provider 创建 executor（核心，替代 getExecutor）
function getExecutorByProvider(providerId: string): BaseExecutor | undefined
```

**新建** `packages/server/src/executors/default-providers.json`

### 第二步：改造 Executor 工厂

**修改** `packages/server/src/executors/index.ts`

- 新增 `getExecutorByProvider(providerId)` 函数
- 内部逻辑：
  1. 从 providers 获取配置
  2. 将 `provider.env` 设置到 `CmdOverrides.env`
  3. 将 `provider.config` 作为 executor 配置
  4. 调用 `createExecutor(agentType, mergedConfig)` 创建实例
- 保留 `getExecutor(agentType, variant)` 做向后兼容（老 session 恢复时使用）

**修改** `packages/server/src/executors/execution-env.ts`

- `ExecutionEnv` 新增 `withProviderEnv(env: Record<string, string>)` 方法，将 provider 级别的环境变量注入

### 第三步：改造 Session 创建与启动流程

**修改** `packages/server/src/services/session-manager.ts`

- `create()` 新增 `providerId` 参数
- `start()` 中：
  - 如果 `session.providerId` 存在，使用 `getExecutorByProvider(providerId)`
  - 同时将 provider 的 `env` 注入到 `ExecutionEnv`
  - 否则走原有 `getExecutor(agentType, variant)` 逻辑（向后兼容）
- `sendMessage()` 同理

**修改** `packages/server/src/routes/sessions.ts`

- `createSessionSchema` 新增 `providerId` 可选字段
- 当传入 `providerId` 时，自动从 provider 推导 `agentType`

**修改** `packages/server/prisma/schema.prisma`

- Session 模型新增 `providerId String?` 字段
- 生成 migration

### 第四步：后端 Provider API

**新建** `packages/server/src/routes/providers.ts`

```
GET    /api/providers                — 获取所有 providers（带可用性检查）
GET    /api/providers/:id           — 获取单个 provider 详情
POST   /api/providers               — 创建 provider
PUT    /api/providers/:id           — 更新 provider
DELETE /api/providers/:id           — 删除 provider（内置不可删）
```

返回格式新增 `available` / `availabilityType` 字段（复用现有可用性检查逻辑）。

**改造** `GET /demo/agents` API

返回改为基于 provider 的列表，而不是 agentType 列表，保持向后兼容。

### 第五步：前端设置页 - Provider 管理

**重写** `packages/web/src/pages/ProfileSettingsPage.tsx` → 改为 Provider 配置页面

新的 UI 设计：
- 顶部有「新增 Provider」按钮
- 列表展示所有 provider，按 agentType 分组
- 每个 provider 卡片显示：名称、AgentType 图标/标签、默认标识、关键配置摘要
- 操作：编辑、删除（内置不可删）、设为默认

**新增/修改 Provider 的表单**（Modal 或抽屉）：
- Agent 类型选择（下拉：Claude Code / Gemini CLI / Cursor Agent / Codex）
- 名称输入
- 环境变量配置（key-value 编辑器，支持动态增删行）
  - 常用 key 有提示（如 ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_MODEL, GEMINI_API_KEY 等）
  - Value 输入框用 password 类型隐藏敏感信息
- Agent 参数配置（JSON 编辑器，与原 variant config 一致）
- 是否设为默认

**新建** `packages/web/src/hooks/use-providers.ts`

```typescript
function useProviders()              // GET /providers
function useCreateProvider()         // POST /providers
function useUpdateProvider()         // PUT /providers/:id
function useDeleteProvider()         // DELETE /providers/:id
```

### 第六步：前端启动 Agent 对话框改造

**修改** `packages/web/src/components/task/StartAgentDialog.tsx`

- 原来展示 4 个 AgentType 按钮 → 改为展示所有 provider 按钮
- 每个按钮显示 provider 名称（如 "Claude Code (官方)"、"Claude Code (中转)"）
- 不可用的仍然灰掉
- 选择后，API 请求中传 `providerId` 而不是 `agentType`

### 第七步：MCP 适配

**修改** `packages/server/src/mcp/types.ts`

- `StartWorkspaceSessionInput` 的 `agent_type` 字段保留向后兼容
- 新增可选的 `provider_id` 字段
- 当 `provider_id` 存在时优先使用，否则按 `agent_type` 找默认 provider

**修改** `packages/server/src/mcp/tools/workspaces.ts`

- `start_workspace_session` 传递 `provider_id`

### 第八步：清理旧代码

- 保留 `profiles.ts` 和 `default-profiles.json` 但标记为 deprecated（向后兼容旧 session）
- 删除 `packages/server/src/routes/profiles.ts` 中的旧 API（或标记 deprecated）
- 前端删除 `use-profiles.ts` hook（被 `use-providers.ts` 替代）
- 设置页路由 `/settings/agents` 指向新的 Provider 管理页面

## 向后兼容策略

1. **旧 Session 数据**：`providerId` 为 null 的 session，启动时仍走 `getExecutor(agentType, variant)` 老路径
2. **MCP 接口**：`agent_type` 参数继续支持，找到该类型的默认 provider 来使用
3. **内置默认 Provider**：每个 AgentType 至少有一个默认 provider，不配置的用户体验完全不变
4. **profiles.json 迁移**：首次启动时检测旧 `profiles.json`，自动转换为 `providers.json` 格式

## 文件变更清单

### 新建文件
- `packages/server/src/executors/providers.ts` — Provider 配置管理核心
- `packages/server/src/executors/default-providers.json` — 内置默认 providers
- `packages/server/src/routes/providers.ts` — Provider CRUD API
- `packages/web/src/hooks/use-providers.ts` — 前端 Provider hooks
- `packages/server/prisma/migrations/xxx_add_provider_id/` — DB migration

### 修改文件
- `packages/server/src/executors/index.ts` — 新增 getExecutorByProvider
- `packages/server/src/executors/execution-env.ts` — Provider env 注入
- `packages/server/src/services/session-manager.ts` — 支持 providerId
- `packages/server/src/routes/sessions.ts` — createSession 支持 providerId
- `packages/server/src/routes/demo.ts` — agents API 返回 provider 列表
- `packages/server/src/mcp/types.ts` — MCP schema 新增 provider_id
- `packages/server/src/mcp/tools/workspaces.ts` — 传递 provider_id
- `packages/server/prisma/schema.prisma` — Session 新增 providerId
- `packages/shared/src/types.ts` — 新增 Provider 类型定义
- `packages/web/src/pages/ProfileSettingsPage.tsx` — 重写为 Provider 管理页
- `packages/web/src/components/task/StartAgentDialog.tsx` — 选择 provider
- `packages/server/src/routes/index.ts` — 注册 provider routes

### 可能删除/废弃
- `packages/server/src/executors/profiles.ts` — 标记 deprecated
- `packages/server/src/executors/default-profiles.json` — 标记 deprecated
- `packages/server/src/routes/profiles.ts` — 标记 deprecated
- `packages/web/src/hooks/use-profiles.ts` — 被 use-providers 替代
