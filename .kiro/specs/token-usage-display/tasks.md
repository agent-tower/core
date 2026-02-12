# 实现计划：Token 用量追踪与展示

## 概述

基于现有的 NormalizedEntry 管道，在 Parser 层提取 Token 数据，通过 LogAdapter 传递到前端，并在 UI 中展示累计摘要。实现按数据流方向从后端到前端逐步推进。

## 任务

- [ ] 1. 扩展 ClaudeCodeParser 提取 Token 用量
  - [ ] 1.1 扩展 `ClaudeCodeMessage` 接口添加 `usage` 字段，修改 `handleResultMessage` 方法在 `subtype: "success"` 时提取 Token 数据并调用 `createTokenUsageInfo()` 生成 NormalizedEntry
    - 导入 `createTokenUsageInfo` 和 `addNormalizedEntry`
    - 缺失字段默认为 0，整体包裹 try-catch
    - _Requirements: 1.1, 1.3, 7.1_

  - [ ] 1.2 编写 ClaudeCodeParser Token 提取属性测试
    - **Property 1: Claude Code Token 提取正确性**
    - 使用 fast-check 生成随机 usage 对象（含部分字段缺失情况），验证提取结果
    - **Validates: Requirements 1.1, 1.3**

  - [ ] 1.3 编写 ClaudeCodeParser 错误容错属性测试
    - **Property 7: Parser 错误容错**
    - 使用 fast-check 生成格式异常的 usage 字段，验证 Parser 不抛异常
    - **Validates: Requirements 7.1**

  - [ ] 1.4 编写 ClaudeCodeParser Token 边界用例单元测试
    - 测试 result 消息无 usage 字段时不生成 token_usage_info（需求 1.2）
    - 测试 usage 字段全部为 0 时仍生成条目
    - _Requirements: 1.2_

- [ ] 2. 扩展 CursorAgentParser 提取 Token 用量
  - [ ] 2.1 修改 `parseLine` 中 `result` 类型的处理逻辑，从 `result.result.usage` 中提取 Token 数据
    - 支持 `input_tokens`/`inputTokens` 两种命名风格
    - 无 usage 数据时不生成条目，整体包裹 try-catch
    - _Requirements: 2.1, 2.2, 7.1_

  - [ ] 2.2 编写 CursorAgentParser Token 提取属性测试
    - **Property 2: Cursor Agent Token 提取正确性**
    - 使用 fast-check 生成随机 result 消息，验证提取结果
    - **Validates: Requirements 2.1**

  - [ ] 2.3 编写 CursorAgentParser Token 边界用例单元测试
    - 测试 result 消息无 Token 数据时不生成条目（需求 2.2）
    - _Requirements: 2.2_

- [ ] 3. Checkpoint - 确保 Parser 层测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [ ] 4. 扩展 LogAdapter 传递结构化 Token 数据
  - [ ] 4.1 在 `LogEntry` 接口中添加可选的 `tokenUsage` 字段，修改 `normalizedEntryToLogEntry` 中 `token_usage_info` 的映射逻辑，将结构化 Token 数据附加到 LogEntry
    - _Requirements: 3.3_

  - [ ] 4.2 编写 LogAdapter Token 转换属性测试
    - **Property 4: LogAdapter Token 转换正确性**
    - 使用 fast-check 生成随机 token_usage_info NormalizedEntry，验证转换结果
    - **Validates: Requirements 3.3**

  - [ ] 4.3 编写 MsgStore Token 往返属性测试
    - **Property 3: Token 用量数据 MsgStore 往返一致性**
    - 使用 fast-check 生成随机 token_usage_info 条目，推入 MsgStore 后从 snapshot 取出验证
    - **Validates: Requirements 3.2, 6.1**

- [ ] 5. 实现前端 Token 聚合 Hook
  - [ ] 5.1 创建 `packages/web/src/hooks/useTokenUsage.ts`，实现 `useTokenUsage` Hook 从 LogEntry 数组中聚合 Token 用量
    - 返回 `TokenUsageSummary | null`，无 Token 数据时返回 null
    - `totalTokens = inputTokens + outputTokens`
    - 过滤异常数据条目
    - _Requirements: 4.1, 4.3, 7.2_

  - [ ] 5.2 编写 Token 聚合属性测试
    - **Property 5: Token 聚合正确性**
    - 使用 fast-check 生成随机 LogEntry 数组，验证聚合结果
    - **Validates: Requirements 4.1, 4.3**

  - [ ] 5.3 编写前端聚合错误容错属性测试
    - **Property 8: 前端聚合错误容错**
    - 使用 fast-check 生成混合正常和异常 tokenUsage 的 LogEntry 数组，验证仅有效条目被累加
    - **Validates: Requirements 7.2**

- [ ] 6. 实现 TokenUsageBar UI 组件
  - [ ] 6.1 创建 `packages/web/src/components/agent/TokenUsageBar.tsx`，实现 Token 用量摘要栏
    - 展示输入/输出/总计 Token 数，cacheReadTokens > 0 时额外展示
    - summary 为 null 时返回 null
    - 使用 `formatNumber` 格式化大数字（K/M）
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ] 6.2 编写 TokenUsageBar 渲染属性测试
    - **Property 6: TokenUsageBar 渲染完整性**
    - 使用 fast-check 生成随机 TokenUsageSummary，验证渲染输出包含必要数值
    - **Validates: Requirements 5.2**

  - [ ] 6.3 编写 TokenUsageBar 边界用例单元测试
    - 测试 summary 为 null 时不渲染（需求 5.4）
    - 测试 cacheReadTokens > 0 时展示缓存信息（需求 5.3）
    - 测试 formatNumber 的 K/M 格式化
    - _Requirements: 5.3, 5.4_

- [ ] 7. 集成 TokenUsageBar 到 LogStream
  - [ ] 7.1 在 `LogStream.tsx` 中引入 `useTokenUsage` Hook 和 `TokenUsageBar` 组件，将 Token 用量摘要栏固定在日志流区域底部
    - _Requirements: 5.1, 5.5_

- [ ] 8. 最终 Checkpoint - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

## 备注

- 所有任务均为必需，包括属性测试和单元测试
- 每个任务引用了具体的需求编号以保证可追溯性
- 属性测试验证通用正确性，单元测试覆盖具体边界情况
- Checkpoint 任务确保增量验证
