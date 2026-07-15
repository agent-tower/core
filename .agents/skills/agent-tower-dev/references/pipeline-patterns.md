# Pipeline、Executor 与 Parser

## 职责

```text
SessionManager -> Executor -> SpawnedChild -> AgentPipeline -> Parser/MsgStore -> EventBus
```

- `SessionManager` 选择 provider/executor，组装环境，维护 session/process DB 状态、pipeline map、持久化和结束后补偿。
- `BaseExecutor` 构造 CLI 命令并拥有 PTY spawn/cancel 与启动期事件交接。
- `AgentPipeline` 处理单个 PTY 的 data/exit、parser 和 MsgStore listener 生命周期。
- Parser 将 agent stream 转为 `NormalizedEntry` JSON Patch；MsgStore 保存 raw/patch/session id 并生成 snapshot。

Route 不直接 spawn PTY，Parser 不更新 Prisma 或 Task 状态。

## 启动与结束

spawn 与 Pipeline attach 之间存在竞态。保留 `collectEarlyPtyEvents()` / `takeEarlyEvents()` 一次性交接，否则短命进程可能丢失 exit 并永久停在 RUNNING。

Session 结束后的 DB 状态、snapshot、auto-commit、commit message、Task review 和 TeamRun reconciliation 由 SessionManager/Team services 负责。修改结束路径时覆盖正常完成、非零退出、stop、启动失败、并发删除和 server shutdown。

## AgentPipeline

`OutputParser` 只有 `processData(data)` 和 `finish(exitCode?)`。Parser 构造时接收 MsgStore；Pipeline 监听 MsgStore patch/session id 后发 EventBus。

保持以下不变量：

- raw stdout 先写入 MsgStore；parser 失败仍可恢复日志。
- 捕获 `processData`/`finish` 异常，不从 node-pty callback 抛出。
- exit/destroy 竞争时 `finish()` 只运行一次。
- destroy 先 flush parser，再解除 patch listener。
- 所有退出路径释放 listener、PTY 和 cancellation 资源。

## Executor

实现 `BaseExecutor` 时提供 `agentType`、`displayName`、`buildCommandBuilder()` 和 `getAvailabilityInfo()`；按能力覆盖 slash commands、capabilities、follow-up 和 MCP config path。基类 `spawnFollowUp()` 默认抛 unsupported。

使用 `CommandBuilder`、`ExecutionEnv` 和跨平台 PTY wrapper，不拼 shell 字符串。处理 Windows ConPTY、executable 解析、stdin 临时文件权限/清理。日志不记录完整 prompt 或 secret；credential 参数加入 redaction 测试。

Provider 是主要配置入口，profiles 只保留兼容。Executor factory 根据 `AgentType` 和 provider config 动态创建实例。

## Parser 与 MsgStore

Claude Code、Cursor Agent、Codex 有结构化 parser；Gemini 当前保留 raw stdout。Parser 缓冲不完整 frame，使用 `output/utils/patch.ts` 生成 RFC 6902 patch，并在 finish 处理残留数据。不要按任意 PTY chunk 直接 `JSON.parse`，未知或坏 frame 不能阻断后续输出。

改变 `NormalizedEntry` 时同步 `shared/log-adapter.ts` 和前端 LogStream/Todo/Token。使用导出的 `sessionMsgStoreManager`，不存在公共 `SessionMsgStoreManager.getInstance()`。

MsgStore patch `seq` 单调递增，并在内存上限下把淘汰消息折叠进 base snapshot。修改时验证 seq/stale replace、memory cap、token/session/message id、snapshot restore/persist，以及前端 seq-gap 恢复。

## 新增 Agent

检查这些接触点：

1. shared `AgentType` 与公开类型。
2. executor、command config、factory/export 和 default provider。
3. `SessionManager.createParser()` 与 parser tests；无可靠协议时先返回 `null`。
4. 前端 agent meta、provider/model selector、logo 和 capability 展示。
5. slash command、skill/MCP config、CLI environment manifest。
6. shared/server/web 构建与公开 provider 文档。

测试覆盖 early data/exit、parser throw、重复 exit/destroy、spawn failure、cancel/follow-up 和 snapshot restore。
