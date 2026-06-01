# Pipeline 与 Executor 模式

## AgentPipeline

**范本文件**：`packages/server/src/pipeline/agent-pipeline.ts`

数据流：
```
PTY.onData → MsgStore.pushStdout + EventBus('session:stdout') + Parser.processData()
PTY.onExit → Parser.finish() + MsgStore.pushFinished() + EventBus('session:exit')
MsgStore.onPatch → EventBus('session:patch') → Socket.IO
```

## Executor

**基类**：`packages/server/src/executors/base.executor.ts`
**范本实现**：`packages/server/src/executors/claude-code.executor.ts`
**工厂注册**：`packages/server/src/executors/index.ts`

需要实现的接口方法：
- `getAvailabilityInfo()` — 检查 CLI 是否可用
- `getCapabilities()` — 声明 sessionFork / contextUsage 能力
- `spawn(options)` — 启动新 Session
- `spawnFollowUp(options)` — 续接已有 Session

`BaseExecutor` 提供辅助方法：
- `spawnInternal()` — 通过 node-pty 启动子进程
- `spawnWithStdin()` — 通过临时文件传递 stdin

## Output Parser

**类型定义**：`packages/server/src/output/types.ts`（NormalizedEntry、ActionType、ToolStatus 等）
**Patch 工具**：`packages/server/src/output/utils/patch.ts`（RFC 6902 JSON Patch 生成）
**范本 Parser**：`packages/server/src/output/claude-code-parser.ts`

Parser 需要实现：
- `processData(data)` — 处理增量输出，生成 JSON Patch
- `finish()` — 进程退出时调用
- `onPatch(handler)` — Patch 回调
- `onSessionId(handler)` — Session ID 回调

所有 Agent 输出归一化为 `NormalizedEntry`，通过 `types.ts` 中的工厂函数创建。

## MsgStore

**范本文件**：`packages/server/src/output/msg-store.ts`

- `SessionMsgStoreManager.getInstance()` 单例管理
- `getSnapshot()` 增量缓存机制
- `restoreFromSnapshot()` 用于 Session 续接
