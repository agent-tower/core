# Claude CLI ASK 第一阶段交付

日期：2026-10-09。实施完成，等待独立代码审查及页面审批验证；未合并、发布或重启现有 QA 服务。

审查起点：`777737032a1fa7098442852709cb9d26854483f8`。最终交付 SHA 以 Team Room result 为准；审查整个起点到交付 SHA 的差异，包含工作区自动保存提交。

## 实现范围

- 通用 `CliDuplexIO` / `pipe-duplex`：每次启动独立私有 IPC、真实持续 stdin、独立 stdout/stderr、串行写入和 ACK、EOF、连接/写入超时与断连。沿用 PTY wrapper、身份标记、launch claim、started 持久化屏障和整树清理。
- Claude 专属 control codec：initialize → 明确 default ACK → 发布 ASK 快照 → 用户任务。新建与 resume 共用；仅 can_use_tool 的本次批准/拒绝，不返回 updatedPermissions。
- 沿用 Coordinator 的审批等待、REST 恢复、Socket 和页面。两层请求绑定 session/turn/runtime generation，一次答复占用；持续读取消、结果和 EOF。服务端保存原始输入，页面仅展示有界脱敏动作摘要，禁止任意 terminal input 写入协议。
- Service 按本轮实际模式检查部署授权，并在实际 stdin 写入前再次检查。403 保留部署拒绝含义，409 表示过期/重复等冲突。迟到 ACK 不修改取消状态或下一轮请求；不确定的 allow 不重试。
- result 先记录文本/usage，再完成逻辑轮次并关闭 stdin；根退出、整树清理及持久化确认分别处理。清理记录未确认时阻止 replacement，并保留可重试 owner。stdout 被后代继承时仍有界开始整树清理。
- 独立 RuntimeQuestionRequest/Answer 预留稳定 questionId 和本轮归属；未开放问答 API、Claude AskUserQuestion、计划确认或 Codex app-server。FULL_ACCESS 没有替用户答题的分支。
- 已更新公开 Provider 文档和 agent-tower-dev runtime reference。

主要模块：`executors/{base,claude-code}.executor.ts`、`utils/{cli-duplex-channel,process-launch}.ts`、`runtime/{claude-cli-control,cli-driver,runtime-coordinator,contracts}.ts`、Claude Parser/Pipeline、执行权限/能力/Session Service、Provider/Session Route、shared DTO 和原有审批卡片。

## 四组审查边界与证据

| 边界 | 结论与验证 |
| --- | --- |
| 启动、模式及支持门槛 | 模拟进程验证 started 屏障前没有输入；initialize/default ACK 前没有任务；握手期间停止清理 owner；resume 模式拒绝没有新建 fallback。能力和启动固定到同一原生实际路径。原生及 Tower 真实 allow/deny/resume 均通过后才纳入支持构建。 |
| 一次答复与取消 | codec/Coordinator 测试覆盖重复、native cancel、停止、迟到 ACK、下一轮请求、取消状态及写入失败。部署策略撤销在延迟 stdin 写入前返回 403；失效请求返回 409。 |
| 控制帧、日志及输入隔离 | ASK 原始 stdout 不进入 MsgStore/Socket；Parser 唯一分帧入口分流控制消息。测试确认原始 control_request 不进入快照、任意 terminal input 被拒绝、敏感值/长详情脱敏截断、问答/计划请求安全失败。 |
| 结果、EOF 与清理 | 模拟进程验证正常 result、无末尾换行 result/EOF、异常 EOF、模式失败、握手停止、后代保留 stdio、断连及清理持久化失败。旧 owner 在恢复前阻止替代进程。真实运行四次启动均取得整树清理确认。 |

## 真实 smoke

实际环境：Darwin arm64，Claude Code 原生 2.1.293，构建 SHA-256：
`4e21122a227857da1178aca3299700c1fd7f2b77c93f12e73c2c76db796a105e`。

验证使用独立临时工作区、Claude 配置目录和数据库路径；复用现有认证/模型环境但未修改全局配置。实际模型为兼容 Anthropic 协议的 `deepseek-v4-pro`，不把该证据描述成官方 Anthropic 模型的全部组合验收。

1. 无模型探针：initialize 成功；set_permission_mode 返回 `{mode: default}`。这项证据单独不代表支持审批。
2. 原生 stream-json smoke：拒绝后 denied.txt 未创建；新进程 resume 并重设 default 后批准，approved.txt 创建；两轮 result、EOF 和 exit 0。见 [native-smoke.json](native-smoke.json)。
3. Tower Executor → owned wrapper → Driver → Coordinator smoke：拒绝、批准 + resume、历史 FULL_ACCESS → ASK resume 后拒绝均产生真实 can_use_tool；拒绝未写目标文件，批准才写文件。runtime 权威恢复视图含当前请求和 ASK 快照，四次启动均完成 tree_cleanup_completed。见 [tower-smoke.json](tower-smoke.json)。
4. 临时进程及目录已清理；现有 `permission-ui-fix-qa` 保持原 PID/运行代际。本次没有新增长期服务，也没有修改该服务的数据或 Provider。

可复现 Tower smoke：

```sh
pnpm --filter @agent-tower/server exec tsx ../../scripts/verify-claude-cli-ask.mts <含认证环境的settings.json>
```

文件参数可省略，省略时使用进程认证环境。脚本仅读取其中的 ANTHROPIC_* 环境值，写入临时目录；报告不保存认证或原生 payload。

## 自动验证

相关 15 个 Vitest 文件分批运行，共 260 个测试通过：control 12、CLI ASK Driver 10、CLI 生命周期 7、duplex 3、wrapper 33、Claude 能力 3、权限 Service 5、Session 生命周期 47、Coordinator 26、ACP Driver 14、Provider Route 62、Session Route 8、Claude Executor 3、Claude token Parser 17、Pipeline 10。

`shared → server → web` 构建通过；末次 server 构建复核通过。`pnpm docs:build`、skill quick_validate 和 diff whitespace 检查通过。Web 构建仅有现有大 chunk 提示。

## 支持与未验证项

仅开放上述平台、版本及摘要匹配的原生构建，Executor 固定到检测的实际原生路径；每次启动仍检查初始化和模式 ACK。未知 wrapper 不执行版本探针。构建、路径或文件元数据变化失效缓存。

其他版本、同版本不同构建、Linux/Windows、Electron、router、自定义命令或附加启动参数保持 CAPABILITY_UNVERIFIED；缺 CLI 返回 RUNTIME_MODE_UNSUPPORTED。CLI AUTO_SANDBOX 及其他 Agent 支持矩阵保持原规则。

未完成独立审查、真实浏览器按钮/断线重连操作、其他平台和官方 Anthropic 模型组合 smoke；这些不能从单元测试或握手成功推断。原生取消和写入失败使用模拟进程/传输测试，未宣称真实模型能稳定触发全部异常竞态。stderr 独立传输，当前不把其原文广播到 UI。

保留原生按需审批语义：原生 allow 规则已允许的操作可能直接执行，ASK 不提供资源隔离。本阶段只复核现有部署模式资格，不新增 RBAC、租户隔离或风险分类器。

## 独立审查重点

检查 capability 构建门槛及实际路径固定、握手/started 顺序、双层 pending 与授权回调、control 原始数据不进入日志、ACK/取消竞争、EOF 与后代 stdio、失败清理 owner 保留，以及 Provider 保存/导入和其他 CLI/ACP 的兼容行为。API 成功表示答复已写入原生 stdin，工具是否执行以原生后续结果为准。
