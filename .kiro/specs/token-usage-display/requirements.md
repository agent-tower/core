# 需求文档：Token 用量追踪与展示

## 简介

为 Agent Tower 添加 Token 用量追踪与展示功能。各 Agent（Claude Code、Cursor Agent、Gemini CLI）在执行过程中会消耗 Token，系统需要从各 Agent 的 stream-json 输出中提取 Token 用量数据，通过现有的标准化管道传递到前端，并在 Web UI 中以持久化摘要的形式展示累计 Token 消耗。

## 术语表

- **Parser**: 将 Agent CLI 的 JSONL 输出转换为 `NormalizedEntry` 对象的解析器（如 `ClaudeCodeParser`、`CursorAgentParser`）
- **NormalizedEntry**: 系统内部标准化的日志条目类型，所有 Agent 输出最终都转换为此格式
- **token_usage_info**: `NormalizedEntry` 的一种 `entryType`，专门用于承载 Token 用量数据
- **LogEntry**: 前端 UI 层使用的日志显示类型，由 `NormalizedEntry` 通过 `log-adapter` 转换而来
- **MsgStore**: 服务端消息存储，管理 JSON Patch 历史并重建会话快照
- **AgentPipeline**: 连接 PTY → Parser → MsgStore → EventBus → WebSocket → 前端的数据管道
- **TokenUsageSummary**: 前端聚合后的 Token 用量摘要数据结构，包含累计输入/输出/缓存 Token 数

## 需求

### 需求 1：Claude Code Token 数据提取

**用户故事：** 作为用户，我希望系统能从 Claude Code 的输出中提取 Token 用量数据，以便了解每次交互的 Token 消耗。

#### 验收标准

1. WHEN Claude Code 输出包含 `type: "result"` 且 `subtype: "success"` 的消息时，THE Parser SHALL 从该消息的 `usage` 字段中提取 `input_tokens`、`output_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens` 并生成一个 `token_usage_info` 类型的 NormalizedEntry
2. WHEN Claude Code 的 result 消息中 `usage` 字段缺失时，THE Parser SHALL 跳过 Token 用量提取并继续正常处理其他字段
3. WHEN Claude Code 的 result 消息中 `usage` 字段部分缺失（如仅有 `input_tokens` 而无 `cache_read_input_tokens`）时，THE Parser SHALL 将缺失字段视为 0 并仍然生成 `token_usage_info` 条目

### 需求 2：Cursor Agent Token 数据提取

**用户故事：** 作为用户，我希望系统能从 Cursor Agent 的输出中提取可用的 Token 用量数据，以便在不同 Agent 之间获得一致的用量展示体验。

#### 验收标准

1. WHEN Cursor Agent 输出包含 `type: "result"` 的消息且该消息包含 Token 用量数据时，THE Parser SHALL 提取可用的 Token 字段并生成一个 `token_usage_info` 类型的 NormalizedEntry
2. WHEN Cursor Agent 的 result 消息中不包含 Token 用量数据时，THE Parser SHALL 不生成 `token_usage_info` 条目并继续正常处理

### 需求 3：Token 用量数据标准化传输

**用户故事：** 作为开发者，我希望 Token 用量数据通过现有的标准化管道传输到前端，以便保持架构一致性。

#### 验收标准

1. THE Parser SHALL 使用现有的 `createTokenUsageInfo()` 辅助函数生成 `token_usage_info` 类型的 NormalizedEntry
2. THE MsgStore SHALL 通过现有的 JSON Patch 机制存储和传输 `token_usage_info` 条目，与其他 NormalizedEntry 类型保持一致
3. WHEN 前端通过 WebSocket 接收到包含 `token_usage_info` 条目的 Patch 时，THE LogAdapter SHALL 将其转换为前端可用的 LogEntry 格式

### 需求 4：前端 Token 用量累计聚合

**用户故事：** 作为用户，我希望看到当前会话的累计 Token 用量，而不仅仅是单次交互的数据。

#### 验收标准

1. WHEN 前端接收到一个或多个 `token_usage_info` 类型的 LogEntry 时，THE TokenUsageSummary SHALL 将所有 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` 分别累加
2. WHEN 新的 `token_usage_info` 条目到达时，THE TokenUsageSummary SHALL 立即更新累计值
3. THE TokenUsageSummary SHALL 计算并展示总 Token 数（输入 + 输出之和）

### 需求 5：Token 用量 UI 展示

**用户故事：** 作为用户，我希望在会话界面中看到一个持久化的 Token 用量摘要区域，以便随时了解当前会话的 Token 消耗情况。

#### 验收标准

1. THE UI SHALL 在日志流区域上方或下方展示一个固定的 Token 用量摘要栏
2. WHEN Token 用量数据可用时，THE UI SHALL 展示输入 Token 数、输出 Token 数和总 Token 数
3. WHEN 缓存 Token 数据可用时，THE UI SHALL 额外展示缓存读取 Token 数
4. WHEN 没有任何 Token 用量数据时，THE UI SHALL 隐藏 Token 用量摘要栏
5. WHEN Token 用量数据更新时，THE UI SHALL 平滑更新显示的数值而不引起页面闪烁

### 需求 6：Token 用量数据序列化与反序列化

**用户故事：** 作为开发者，我希望 Token 用量数据能正确地通过 JSON 序列化和反序列化传输，以确保数据在服务端和前端之间的一致性。

#### 验收标准

1. FOR ALL 有效的 `token_usage_info` NormalizedEntry 对象，THE System SHALL 保证序列化为 JSON 后再反序列化能得到等价的对象（round-trip 属性）
2. WHEN `tokenUsage` 中的数值字段为 0 时，THE System SHALL 在序列化和反序列化过程中保留该 0 值而非将其省略

### 需求 7：错误容错

**用户故事：** 作为用户，我希望 Token 用量提取失败不会影响正常的会话功能。

#### 验收标准

1. IF Parser 在提取 Token 用量数据时遇到异常（如字段类型不匹配、数值溢出），THEN THE Parser SHALL 记录警告日志并跳过该条 Token 用量数据，继续正常解析后续输出
2. IF 前端接收到格式异常的 Token 用量数据，THEN THE UI SHALL 忽略该条数据并保持当前累计值不变
