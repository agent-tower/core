# Claude CLI ASK 第一阶段验收修正

- 日期：2026-10-09。
- 基线：`a063ddf9243f6eb6201397798012cd2d8a16de24`；本次固定提交 SHA 见 Team Room result。
- 状态：三项实现修正与自动验证完成，等待独立复审和真实页面重验。
- 已读取完整审查消息 `db2cce8e-02bb-479f-ab43-4f3610583ae2` 与页面测试消息 `93354992-6b80-4750-90eb-5468f015009d`。
- 保留原始 [页面报告](e2e-verification-report.md)、`e2e/` 截图及此前模型 smoke 证据；未改写原测试结论。本次没有新增模型任务、操作既有 QA 服务/数据或修改全局配置。

## 修正与证据

| 问题 | 最终行为 | 自动验证 |
| --- | --- | --- |
| 根退出后丢失最后输出 | 根进程退出立即开始整树清理，正常退出另等 stdout/stderr 结束和服务端 reader 消费 ACK。早期缓存必须重放后才 ACK。Pipeline 不以独立 PTY exit 提前 finish/unsubscribe；传输超时按失败处理，不合成成功 EOF。显式停止关闭通道，释放已卸载 reader 的等待。 | Duplex 模拟进程：根退出后延迟 350ms attach reader，仍收到 result/usage/EOF；4MB 输出配合 socket 暂停 350ms，内容完整，忽略 SIGHUP 的后代被有界清理。Pipeline：PTY exit 后延迟 150ms 交付最后 result/usage，再以 EOF finish 一次。Driver：result 后延迟 400ms 的尾部仍到达，owner cleanup 确认一次。 |
| 按旧 Provider 判断能力 | 新增 POST `/providers/capabilities`，当前草稿 config 明确替换已保存 config（包括 `{}`）。Query key 包含 Agent/Runtime/模型/Provider/草稿 config。保存、测试与实际启动保留服务端复核；响应不返回 Provider env/config/settings。 | Route 使用仅允许 ASK 的策略：导入 ASK + router，草稿移除 router 后立即可选并直接保存 ASK；新增 router/自定义命令/附加参数立即不可选，保存仍拒绝。真实 Hook + ProviderFormModal 的 happy-dom 测试覆盖同次编辑、四组独立缓存及无需 FULL_ACCESS 的保存。 |
| 不刷新时页面停止静默返回 | AgentSessionPanel 继续按 runtime activity 决定按钮；ConversationPage 不再用落后的 Conversation status 二次阻止幂等停止入口。停止成功/失败都重查 Conversation、Session detail/runtime。 | 页面回归保留 COMPLETED/CANCELLED 缓存，但 runtime 为 AWAITING_PERMISSION；点击发出 `POST /conversations/:id/stop`，无 Socket 推送时也重查并清除卡片。既有 Coordinator/CLI 模拟验证停止后 pending 失效、迟到答复被拒、目标文件不存在；HTTP 过期审批映射 409 的邻近测试通过。 |

相邻停止入口已检查：TaskDetail/MobileTaskDetail 仅校验 session id 和提交中状态，没有 Conversation status 二次 guard；AgentSessionPanel 按相同 runtime activity 校验，未作无关修改。

Driver 原有 250ms 逻辑收尾也会拆除读流，因此 duplex 另设有界输出等待；普通 PTY 的原有收尾语义保持。进程树身份无法确认时，沿现有规则保留 owner，不把传输完成视为树清理证据。

## 自动验证结果

17 个相关 Vitest 文件，去重共 **290 项通过**：

| 文件组 | 数量 |
| --- | --- |
| process-launch / duplex / Pipeline / Claude CLI Driver / control / CLI lifecycle | 33 + 5 + 12 + 11 + 12 + 7 |
| Provider Route / Claude CLI capabilities / ExecutionPermissionService | 63 + 3 + 5 |
| RuntimeCoordinator / Session runtime Route / Claude token Parser / SessionManager lifecycle | 26 + 8 + 17 + 47 |
| ProviderSettingsPage / 草稿能力 / ConversationPage stop / use-runtime-state | 28 + 1 + 2 + 10 |

- `shared → server → web` 构建通过。Web 只有现有大 chunk 提示。
- `pnpm docs:build`、skill quick_validate、`git diff --check` 通过；生成的文档构建目录未纳入修正。
- SessionManager lifecycle 在并行构建期间有一次既有等待断言超时；该用例单独重跑和整文件重跑（47 项）均通过，未放宽测试时间或改动其实现。
- 真实进程/数据库验证使用测试临时目录并完成 teardown；本次没有启动长期开发服务。

复现入口：

```sh
pnpm exec vitest run --fileParallelism false packages/server/src/utils/process-launch.test.ts packages/server/src/utils/cli-duplex-channel.test.ts packages/server/src/pipeline/__tests__/agent-pipeline.test.ts packages/server/src/runtime/__tests__/claude-cli-driver.test.ts packages/server/src/runtime/__tests__/claude-cli-control.test.ts packages/server/src/runtime/__tests__/cli-driver-lifecycle.test.ts
pnpm exec vitest run packages/server/src/routes/__tests__/providers.test.ts packages/server/src/services/__tests__/claude-cli-capabilities.service.test.ts packages/server/src/services/__tests__/execution-permission.service.test.ts
pnpm exec vitest run packages/server/src/services/__tests__/session-manager.lifecycle.test.ts packages/server/src/runtime/__tests__/runtime-coordinator.test.ts packages/server/src/routes/__tests__/sessions-runtime.test.ts packages/server/src/output/__tests__/claude-code-parser-token.test.ts
pnpm exec vitest run packages/web/src/pages/__tests__/ProviderSettingsPage.test.tsx packages/web/src/pages/__tests__/ProviderSettingsPage.capabilities.test.tsx packages/web/src/pages/__tests__/ConversationPage.stop.test.tsx packages/web/src/hooks/__tests__/use-runtime-state.test.tsx
```

## 支持门槛与模型证据

真实批准、拒绝、ASK resume、FULL_ACCESS → ASK resume 的模型证据仍然只有兼容 Anthropic 协议的 **deepseek-v4-pro**。本次没有补跑其他模型，不将官方 Anthropic 模型或其他模型描述成已完成 smoke。

当前支持门槛判断原生控制通道：Darwin arm64、Claude 2.1.293 的已记录 SHA-256 构建、实际 executable、非 Electron、无 router/自定义命令/附加参数；启动仍检查 initialize 与 `set_permission_mode(default)` ACK。

“控制通道不按模型白名单筛选”是协议层判断：Driver 在发送 user 任务前执行上述握手；审批 DTO/响应由原生 CLI 和 codec 处理，不通过模型生成批准，也没有模型分支。此前无模型探针确认握手，真实工具请求由上述唯一模型 smoke 补充验证。这些依据说明协商与答复不需要模型参与，**不证明其他模型的工具请求、允许规则或恢复行为已验收**。公开文档与开发指导已同步这一边界。

## 复审与页面重验范围

复审请覆盖 `a063ddf9243f6eb6201397798012cd2d8a16de24..本次固定SHA`；期间既有自动保存提交仅包含页面测试报告/截图，也应保留。

重点：输出 EOF/消费 ACK 与 owner cleanup 的独立屏障、显式停止解除 ACK 等待、Driver 逻辑 result 收尾、草稿替换与缓存隔离、ASK-only 导入修复和保存/启动复核、停止 guard 与 runtime 重查。

独立页面测试尚未重跑。负责人应安排测试成员基于固定 SHA 重验原 D1 / 用例 10：出现审批卡片后不刷新，点击停止确实发送请求，pending/卡片失效，迟到批准返回 409，目标文件未写入；同时回归批准、拒绝、续聊、刷新恢复及草稿新增/移除覆盖。使用独立临时环境，保留 `permission-ui-fix-qa` 服务/数据。自动测试不能替代这一真实页面结论。

未扩展 Agent 模式、问答、多用户/RBAC 或平台支持；没有合并、发布或上线。
