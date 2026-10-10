# 三档执行权限首版验证与交付

日期：2026-10-09。范围以同目录实施计划及 Team Room 决策为准，实现交付后等待独立审查与界面验收。

## 实现范围

- 顶层 executionPermission 贯通 shared、Provider defaults/draft/REST/backup、legacy profile 执行入口和统一 CLI/ACP UI。
- 集中读取旧 UNRESTRICTED/AUTO_APPROVE/危险布尔值，冲突/非法值拒绝。修复后 Codex 旧 CLI/ACP ASK 或缺省均保留重选标记；其他 Agent 沿用各自兼容语义。首次迁移文件备份、版本 1/2 导入和幂等性已覆盖。
- Service 支持矩阵与可注入允许档位策略。默认 owner 开放所有支持项，受限策略直接启动 FULL_ACCESS 返回 403；Pi 禁止完全访问时无可用模式。
- Service 创建单份启动配置快照。活动 ACP 保留启动模式，CLI 新进程与 ACP 新 transport 应用当前选择；重连准备竞态拒绝并提示重试。
- 原生配置由 Executor/Definition 投影；原生剩余审批全部进入已有人工通道，AUTO_SANDBOX 不自动 allow。
- 同一三档组件、可聚焦禁用原因、失效选择保留、启动模式显示与 i18n。支持原因在编辑、启动与 API 中复用。

## 支持矩阵

| 接入 | ASK | AUTO_SANDBOX | FULL_ACCESS |
| --- | --- | --- | --- |
| 所有既有 CLI | 禁用：非交互审批通道未接入 | 禁用：未核实 | 支持 |
| Codex ACP | 支持 | 支持 | 支持 |
| Claude/Gemini/Qwen/Grok/OpenCode/DeepSeek/历史 Minion ACP | 支持 | 禁用：未核实或没有原生沙箱档 | 支持 |
| Kiro ACP | 支持 | 禁用：无原生沙箱档 | 禁用：V2/V3 信任映射未核实 |
| Cursor/Pi ACP | 禁用：未核实或无完整审批门 | 禁用：未核实或无原生沙箱档 | 支持 |

Cursor/Kiro/Grok 的新 transport resume/load 明确拒绝，因为尚不能可靠覆盖恢复会话的旧权限。活动 transport 的普通续聊可继续。Minion 只保留历史读取，创建入口仍隐藏。

## 验证

最终针对 17 个受影响测试文件运行 Vitest：479 项通过，0 失败。覆盖旧值、Provider 保存/测试/导入、策略交集与直接启动、CLI 参数、ACP 模式协商及恢复限制、剩余审批、迟到/取消、活动复用/断线重启、临时 SQLite 的启动/清理生命周期、统一 UI 与启动模式。完整命令使用下列文件列表：

```text
packages/shared/src/__tests__/execution-permission.test.ts
packages/server/src/services/__tests__/execution-permission.service.test.ts
packages/server/src/services/__tests__/provider-config.service.test.ts
packages/server/src/services/__tests__/session-manager.lifecycle.test.ts
packages/server/src/routes/__tests__/providers.test.ts
packages/server/src/executors/__tests__/providers.test.ts
packages/server/src/executors/__tests__/codex.executor.test.ts
packages/server/src/executors/__tests__/claude-code.executor.test.ts
packages/server/src/runtime/__tests__/acp-agent-definitions.test.ts
packages/server/src/runtime/__tests__/acp-driver.test.ts
packages/server/src/runtime/__tests__/acp-driver-lifecycle.test.ts
packages/server/src/runtime/__tests__/runtime-coordinator.test.ts
packages/web/src/components/provider/__tests__/ExecutionPermissionSelector.test.tsx
packages/web/src/components/provider/__tests__/provider-draft.test.ts
packages/web/src/components/agent/__tests__/RuntimePermissionPrompt.test.tsx
packages/web/src/pages/__tests__/ProviderSettingsPage.test.tsx
packages/web/src/pages/__tests__/ProviderSettingsPage.browser.test.tsx
```

shared → server → web 构建通过；docs:build、skill quick_validate 和 git diff --check 通过。前端有既有 chunk 大小提示。文档站构建产物仅用于验证，交付源文档，不提交生成 build 目录。

## 原生核对与缺口

本机版本探测（有界，不运行模型任务）：Codex CLI 0.161.0、Codex ACP adapter 1.10.0、Claude ACP adapter 0.59.0、Grok 0.2.112、Cursor Agent 2026.06.26-7079533、Kiro CLI 2.13.0。Codex adapter 的历史 read-only 实际为 workspace-write + 人工 reviewer；agent 使用 auto_review；agent-full-access 使用原生 bypass。Grok 根权限/沙箱参数、Cursor CLI 配置及 Kiro V3 迁移说明已核对。OpenCode 官方 agent/config 源码确认 OPENCODE_PERMISSION 在普通配置之后合并，Agent permission 也能覆盖全局规则，因此两处均投影规范选择并保留显式 deny。

主要依据：

- Codex：https://learn.chatgpt.com/docs/sandboxing/auto-review
- Cursor：https://cursor.com/docs/cli/reference/configuration
- Grok：https://docs.x.ai/build/features/permissions 和 /sandbox
- Kiro：https://kiro.dev/docs/cli/v3/acp-migration
- OpenCode：https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/agent/agent.ts 和 config/config.ts

未覆盖真实模型执行的逐 Agent smoke，以及真实浏览器视觉/完整 E2E。支持矩阵表示当前适配契约，不证明所有原生版本、平台、模型和部署均可用；参数或模式协商失败会报错，不自动回退。普通用户档位政策扩展已证明，完整身份/RBAC/隔离/即时撤权不在首版。

公开说明：packages/docs-site/docs/integrations/agent-providers.md。开发边界同步到 agent-tower-dev 的 pipeline/frontend/workspace-security references。

可重查的本机验证记录：/tmp/tower-permission-delivery-tests.json，/tmp/tower-shared-build.log，/tmp/tower-server-build.log，/tmp/tower-web-build.log，/tmp/tower-permission-docs-build.log。

## 独立审查后三项修复（2026-10-09）

修复基线为 `75150c39b6b3bf57414b4a903e89ff7894bc3f5f`，审查消息 `6c436085-f23e-41a1-af7a-d598a51eca37`。保留原交付和 QA 阻塞报告，不扩展安全治理，不合并发布。以下结果取代原交付中“明确旧 Codex ACP ASK 保留”的结论。

1. **Gemini CLI 参数重复**：规范字段生成 `--approval-mode yolo --no-sandbox`；只有缺少规范字段的直接旧 profile 才生成 `--yolo`，两者不同时出现。工厂生成的完整 initial/follow-up 命令在 PTY wrapper 单测中核对。原生解析使用 Tower 固定版本 **0.23.0** 的 `parseArguments`，涵盖规范配置、规范配置加旧 yolo=true、纯旧 yolo=true 三种工厂输入，共 **6 个成功解析**；每组补回 `--yolo` 的对照均退出 1 并报重复参数。每次原生子进程限制 10 秒，仅解析参数，不启动模型/会话、不读取或修改用户配置。
2. **Session/Provider 一致性**：Service 新启动授权前核对快照 Agent/runtime 与 Session；冲突返回 `PROVIDER_EXECUTION_MISMATCH`，无 Driver 打开/无执行进程。真实 Provider backup 同 ID 覆盖并 reload，结合临时 SQLite，覆盖旧 CLI Session `start`/`startFollowUp` × ACP `ASK`/`AUTO_SANDBOX` 共 4 个路径。CLI Driver 保护 open、每次新进程及无快照的旧入口；ACP Driver 保护 open 与重连投影。活动 ACP transport 的后续 turn 保持启动快照，已有及新增复用测试通过。
3. **Codex ACP 旧 ASK 兼容**：固定 adapter 1.10.0 的旧 Definition 未设置 mode，默认 Agent/auto_review，不能将旧 ASK 标签直接解释为新人工模式。集中 reader 对旧 permissionMode/acpPermissionMode=ASK 与缺省产生 `LEGACY_PERMISSION_REVIEW_REQUIRED`；marker 经规范化持久化、原文件备份、导出、导入、reload 保留。测试实际调用 Service authorize 证明执行阻止，单改名称仍有诊断；显式重选 ASK 后诊断消除、持久化/reload 后可授权。Codex ACP 投影也拒绝未确认配置，UI 组件测试证明旧选择需点选确认才能保存/测试，新的规范 ASK 仍按人工 mode 配置。

最终验证：原 17 个文件加 `packages/server/src/executors/__tests__/stdin-prompt.executors.test.ts`、`packages/server/src/runtime/__tests__/cli-driver-lifecycle.test.ts`，**19 个文件、511 项通过，0 失败**。按 `shared → server → web` 的受影响构建通过；docs:build、skill quick_validate、git diff --check 通过。web 保留既有 chunk 大小提示。未增加依赖或持久化字段。

可复现原生参数检查（依赖已安装的 Gemini CLI 包目录）：

```bash
pnpm --filter @agent-tower/server exec tsx ../../scripts/verify-gemini-permission-args.mts <installed-gemini-cli-package-directory>
```

本次本机使用 npm cache 中已安装的 0.23.0；脚本会打印实际版本和工厂 final command，不下载/运行模型。解析不是认证、沙箱隔离或真实 Agent smoke 验收。

记录：`/tmp/tower-permission-fixes-final-tests.json`、`/tmp/tower-permission-fixes-final-tests.log`、`/tmp/tower-gemini-0.23.0-parse.log`、`/tmp/tower-permission-fixes-{shared,server,web,docs}-build.log`。

**剩余缺口**：无真实模型 smoke；真实浏览器交互覆盖仍为 **0**，测试成员的 MCP 审批策略阻塞尚未解除，不能把 happy-dom 测试视为真实浏览器通过。QA 报告未修改；独立隔离启动方法、工具清单、收尾及受限策略 fixture 限制见 `2026-10-09-execution-permission-ui-handoff.md`。本次未启动长驻服务、未改变成员权限或绕过工具拒绝。交付后等待负责人安排复审与恢复 UI 验收。
