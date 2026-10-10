# Codex CLI ASK 实施与验证记录

- 日期：2026-10-09；范围仅工具执行审批。
- 对照基线：`bd55f89ec855e55d76d107064e64b0abbbfc6a2a`。保留该提交删除输入框上方权限标记的行为。
- 前置依据：[原生交互源码调查](2026-10-09-vibe-kanban-interaction-analysis.md)、OpenAI Docs [app-server / approvals](https://learn.chatgpt.com/docs/app-server#approvals)、实际安装包生成的 v2 schema，以及有界原生探针。

## 用户会看到什么

Codex 原生需要人工批准的命令或文件修改，进入现有审批卡片。用户点“本次批准”或“本次拒绝”，Tower 将结果送回等待中的同一个原生请求。已被原生工作区沙箱或规则允许的操作仍可能直接执行，因此 ASK 不表示每条命令都询问。

刷新页面可通过既有 runtime REST 快照恢复有效请求。停止、取消和替换任务使旧请求失效；下一轮不接收上一轮的答复。未知构建保持置灰，不自动升权。

## 原生证据与最小接入

已验证 Darwin arm64、Codex CLI `0.161.0`：

| 文件 | SHA256 |
| --- | --- |
| 原生 binary | `12ac11d2c7eee27cfae34393986d7b7c9ed0dea537cb749831cdd7033893e6de` |
| 官方 npm `bin/codex.js` | `61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70` |

用该安装版本的 `codex app-server generate-ts --out <temporary-directory>` 读取 `InitializeParams`、`ThreadStart/ResumeParams/Response`、`TurnStartResponse`、工具审批参数/决策及通知 schema。schema 证明协议字段，不能独立证明模型会发出请求或动作真的执行。

接入顺序为 `initialize → initialized → thread/start 或 thread/resume → turn/start`。新建与 resume 均显式要求 `approvalPolicy=on-request`、`approvalsReviewer=user`、`sandbox=workspace-write`，并检查响应正向确认上述策略及 `sandbox.type=workspaceWrite`。失败时不发送任务。`turn/start` 响应和 `turn/started` 通知允许先后交换，但必须绑定同一个原生 turn。

仅显式 `executionPermission=ASK` 改用 app-server stdio。FULL_ACCESS 保持原有 exec；ACP 与其他 CLI 不切换协议。每轮仍启动新进程，续聊复用原生 thread；不增加跨轮常驻进程。

专属 codec 处理 JSONL/RPC；专属 projector 投影并发工具、assistant/reasoning/plan delta、command output、file changes、MCP、usage 和原生 thread ID。输出预览有界，最终聚合结果不会恢复无界内容。公共 Driver/Coordinator 继续负责持续读流、公共请求归属、恢复视图、一次答复、取消与清理。

工具审批绑定 Tower Session/turn/runtime 与原生 thread/turn/RPC/item ID；数字和字符串 RPC ID 不混用。公共 DTO 只包含有界脱敏动作摘要，不暴露原生 payload。批准发 `accept`，拒绝发 `decline`，不使用 acceptForSession、规则 amendment 或目录持久授权。

该构建的建议命令菜单可能包含 `accept`、amendment、`cancel`，未列 `decline`；实际 schema 定义 `decline`，原生拒绝与 resume 测试确认它生效。拒绝不被偷换成取消。文件 probe 的 `grantRoot=null`；非空持久目录 grant 明确不支持。

服务端沿既有模式授权，Coordinator/codec 在写入前再次复核。一旦写入结果不确定，停止本轮、使按钮失效，不重放批准。普通终端输入不能写入该控制通道。独立问答、计划确认、MCP elicitation、独立资源授权及持久目录授权仍属不同交互，本阶段明确失败，不猜文本、不由 FULL_ACCESS 代答。

## 启用与置灰

`codex-cli-capabilities.service.ts` 仅认可表中构建与平台：先核验已知 npm entrypoint 或 native binary，固定已验证 native 路径，再有界读取版本。未知 wrapper 不运行版本探针。检测结果缓存按文件身份/时间变化刷新；保存/测试/admission 读取准备结果，Executor 启动再检查，原生协议仍须确认模式。

其他版本/平台、Electron/desktop runtime、自定义命令、附加参数、Provider PATH/PATHEXT 覆盖均返回未验证原因并置灰。CLI AUTO_SANDBOX 没有新增支持。旧 Codex ASK 的迁移确认标记继续保留；用户必须明确重选。

构建门槛验证的是协议，不是模型白名单。真实模型证据仅 `gpt-6-sol` 的既有 OpenAI-compatible 连接。`gpt-6.1-sol` 在该连接返回 503/no channel，不能作为审批成功证据；没有改产品默认模型。

## 验证结果及证据边界

| 场景 | 结果 / 证据 |
| --- | --- |
| 命令本次批准/拒绝 | 真实 Executor → CLI Driver → Coordinator；答复前无文件，批准后创建，拒绝未创建 |
| 工作区外文件批准/拒绝 | 同上；目标位于临时 cwd 和原生默认临时可写根之外，apply_patch 确实触发审批 |
| exec FULL_ACCESS → ASK resume；后续 ASK resume | 真实模型每轮重新确认权限；原生 thread ID 与 usage 保留，五个 launch 清理确认 |
| 等待审批取消 → 立即 resume | 真实模型；旧动作不执行、旧按钮失效、旧 cleanup 先于新 started |
| 执行中取消 → 立即 resume | 真实模型；批准后观察命令在临时目录写入开始标记，再取消，30 秒延迟的最终写入未发生；旧 cleanup 先于新 started |
| 刷新恢复、一答一次、同 native ID 新轮、拒绝普通输入 | 协议/Coordinator fixture 测试；未做浏览器页面验收 |
| 403 写入前复核、重复/迟到答复、写入失败、初始化失败 | 针对性自动化测试 |
| 等待/运行中 stop、cancel、abandon 与立即替换 | Claude/Codex 共用真实系统进程 fixture；旧 wrapper/native-root/后代退出断言发生于测试最终 teardown 之前 |
| 正常 result/usage/EOF、尾部排空、异常断连、清理失败保留 owner | 原有 duplex/lifecycle 回归及 Codex fixture；未改变退出门槛，未合成 ACK/EOF/cleanup |

一次取消 smoke 以 stdout 文本为“正在执行”判据未通过；改用实际文件效果后通过。前者不计为执行中取消证据。

完成验证：

- 初轮受影响 runtime/executor/service/duplex/pipeline 分组 207 项通过；邻近 Provider/审批 API、临时 DB Session lifecycle、ACP、shared 和 UI 分组 173 项通过。两组含重叠，不相加宣称唯一测试数量。
- 最后 codec/projector 与相关回归：6 个文件、152 项通过（包含有界输出和 turn/start 响应先到的竞态）；构建按 shared → server → web 通过。
- 公开文档构建通过；`agent-tower-dev` skill validation 通过。构建生成的 docs-site/build 不纳入源码交付。

有界真实 smoke 可复现命令（需要已安装的验收构建及可用的本机认证/连接）：

```bash
pnpm --filter @agent-tower/shared build
TOWER_CODEX_SMOKE_MODEL=gpt-6-sol pnpm --filter @agent-tower/server exec tsx ../../scripts/smoke-codex-cli-ask.mts
TOWER_CODEX_SMOKE_MODEL=gpt-6-sol TOWER_CODEX_SMOKE_STOP=1 TOWER_CODEX_SMOKE_STOP_ONLY=1 pnpm --filter @agent-tower/server exec tsx ../../scripts/smoke-codex-cli-ask.mts
```

smoke 使用私有临时 Codex home、0600 认证/连接副本和临时工作区，退出只在既有 Coordinator 整树清理确认后删除临时状态。没有修改全局配置、用户数据库或 QA 环境，没有跨 turn 后台服务。

## 未覆盖与后续

- 交由负责人安排独立代码审查和页面验收；本次没有承担最终审查。
- 未验证其他模型、官方 OpenAI 登录链路、其他平台/构建、Electron 或自定义 wrapper；不宣称它们可用。
- 只实现工具执行审批；问答/计划交互、CLI 沙箱自动同意、多用户主体和资源隔离不纳入本次。
- 有限 smoke 不证明长期反复运行或应用异常崩溃后的回收；既有清理 owner、失败重试及 admission 门槛保持不变。
- 审查范围应使用 `bd55f89..最终提交`，包括 Tower 自动提交 `0b4239f3` 与本次收尾提交；临时原生探针已从最终树删除。不推送、合并或发布。
