# Claude CLI ASK 取消与替换修复

- 日期：2026-10-09。
- 工作基线：`49bf1815d57564fef53094874429d98db72d6106`。相对原实现基线 `d3e215a4e7fb4a2a8d686f25c760c5044c1cb537`，中间提交只有已通过的页面复验报告和截图。
- 固定交付 SHA、验证结果与复审范围见本轮 Team Room result。
- 已读取完整原派活 `ae5ae84f-5d93-4a9c-9899-4e1ac0be1de2`、完整复审 `49ea2206-b74d-4338-836d-b84fb9112c54`，仅修复其取消/替换回归。

## 上一调用核查

恢复时工作区干净、队列为空，HEAD 仍为上述页面复验提交，房间没有上一调用的修复 result 或新代码交付。因此没有可复用的修复产物；现有房间与仓库证据不足以判断上一调用是否进入实现、在哪一步中断。本轮已在房间确认开始，并实际复现和修复同一缺陷。

## 根因与修复

`SessionManager.sendMessage()` 替换当前轮时调用 `RuntimeCoordinator.abandonTurn()`，它复用同一 DriverSession，经 CLI `cancelTurn()` 取消旧轮。原取消分支直接取消进程并销毁 Pipeline，却没有关闭 duplex。reader 卸载后，wrapper 等不到真实输出消费 ACK，立即启动新轮会触发原有 2 秒 `process_exit_timeout`。

CLI `cancelTurn()` 现在先确定 `turn_cancelled` 结果，再调用现有 `requestProcessStop` owner。该 owner 先关闭控制与 duplex 通道，解除被放弃输出的等待，再取消、销毁 reader 并按既有 PTY owner 清理。先确定结果避免通道同步 disconnect 改写取消原因。

没有延长超时、伪造输出 ACK/EOF/树清理，或绕过旧 owner。新轮依然等待真实整树退出和持久进程事件确认。正常 result、usage、EOF 与消费 ACK 的排空链路保持原实现。

## 复现前后证据

使用真实 owned wrapper/duplex/CLI Driver/Coordinator 和模拟原生进程；没有运行模型任务。临时工作区内创建原生进程及存活后代，通过 IPC ready 确认两者存活后才进入取消测试。

| 原轮状态 | 入口 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| 等待审批 | abandonTurn → 立即 startTurn | process_exit_timeout | 新轮审批及结束成功 |
| 动作运行中 | abandonTurn → 立即 startTurn | process_exit_timeout | 新轮审批及结束成功 |
| 等待审批 | cancelTurn → 立即 startTurn | process_exit_timeout | 新轮审批及结束成功 |
| 动作运行中 | cancelTurn → 立即 startTurn | process_exit_timeout | 新轮审批及结束成功 |

四项核心回归先在未修改的生产源码上运行，均复现退出等待超时。修复后回归加强到新轮也收到审批请求：即使原生 request/tool ID 相同，旧轮迟到批准仍返回 `permission_not_found`，不会消费新轮请求；新轮自己的拒绝正常送达并完成。运行中用例先批准并确认动作已开始，再取消，旧轮最终写文件动作没有执行。

关键断言全部位于 `destroyAll()` / dispose 兜底之前：旧请求清空、旧 completion 以取消失败、新轮 ID 不同、旧 `tree_cleanup_completed` 先于第二次 `started`、旧 wrapper/原生根/后代 PID 均已死亡、旧动作文件不存在，以及新轮自身确认清理。该集成契约对应 SessionManager 的同 DriverSession 替换路径；既有 stopping 测试的清理断言也移到了 finally 前。

## 验证

8 个受影响/邻近 Vitest 文件共 **157 项通过**，包含四项新增替换回归；原退出等待/清理证据缺失/持久事件失败的阻断测试仍通过。按 `shared → server → web` 顺序构建全部通过，Web 只有已有的大 chunk 提示。skill quick_validate 和 `git diff --check` 通过。

```sh
pnpm exec vitest run --fileParallelism false packages/server/src/utils/process-launch.test.ts packages/server/src/utils/cli-duplex-channel.test.ts packages/server/src/pipeline/__tests__/agent-pipeline.test.ts packages/server/src/runtime/__tests__/claude-cli-driver.test.ts packages/server/src/runtime/__tests__/claude-cli-control.test.ts packages/server/src/runtime/__tests__/cli-driver-lifecycle.test.ts packages/server/src/runtime/__tests__/runtime-coordinator.test.ts packages/server/src/services/__tests__/session-manager.lifecycle.test.ts
pnpm --filter @agent-tower/shared build
pnpm --filter @agent-tower/server build
pnpm --filter web build
python3 /Users/shitian/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/agent-tower-dev
git diff --check
```

正常输出回归沿用已有测试：根退出后延迟 350ms 挂接 reader、PTY exit 后延迟 150ms 交付 result/usage/EOF、逻辑 result 后延迟 400ms 尾部、4MB 完整背压输出和消费前后 wrapper/后代状态。**4MB 背压测试的 350ms 暂停从 hello 开始，不能称为根退出后计时。**

## 保留范围与下一步

原实现报告、验收修正报告、两轮页面报告、全部截图及唯一真实模型 smoke 证据保持原样；已通过的页面重验无需重做。没有启动长期服务、操作 `permission-ui-fix-qa` 服务/数据、改全局配置、扩大 Agent/权限功能、合并或发布。

原支持条件与模型限制继续适用：真实 allow/deny/resume smoke 仅 deepseek-v4-pro，不能宣称其他模型已验收。本轮证据是无模型的模拟原生进程集成回归，并非额外页面/模型验证。请负责人交独立审查仅复核本项取消/替换修复及正常输出/owner 门槛；上一调用中断原因仍未能从现有证据确认。
