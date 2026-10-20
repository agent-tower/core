# 本机冲突受理与恢复回归

使用当前生产 Route、Git、SQLite、MessageDelivery 和 SessionManager，CLI 投递确认由确定性 duplex fixture 提供。不调用外部 Provider，不启动长期服务。仅验证本机 POSIX 路径；Windows 原生观察器尚未接入，35 秒全链预算及其他会话延迟上限未认证。Windows 或 `--mode=full` 返回 NOT_RUN、退出 2。

从仓库根执行，使用 package.json 指定的 Node/pnpm，安装锁定依赖后构建 shared 并生成 Prisma Client：

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-tower/shared build
pnpm --filter @agent-tower/server exec prisma generate

# 生产受理：默认15场景；uuid与recovery分别补充6和9个并发交错场景。
node scripts/acceptance/conflict-platform/production-run.mjs --out=output/conflict-admission/basic
node scripts/acceptance/conflict-platform/production-run.mjs --case=uuid --out=output/conflict-admission/uuid
node scripts/acceptance/conflict-platform/production-run.mjs --case=recovery --out=output/conflict-admission/recovery

# 跨进程恢复：issue完全退出后，verify再修改现场并导入服务。
node scripts/acceptance/conflict-platform/production-run.mjs --suite=route --kind=rebase --case=restart --out=output/conflict-admission/restart
node scripts/acceptance/conflict-platform/production-run.mjs --suite=route --kind=all --case=all --out=output/conflict-admission/route
```

也可把 `--out` 指向分支外目录。每次运行独立临时 Git、SQLite、data dir；导入 Prisma 前设置隔离路径。共用 Vitest 配置按 worker 文件过滤，外层 POSIX 进程组设置有限截止并核对整树退出。受理 worker 最长170秒，恢复每阶段120秒；未确认清理时保留 fixture、停止后续 worker，不能据根进程退出宣称整树清理。不要直接运行需要外层 fixture 的 worker。

生产受理支持 `--case=success|cold|prepare-slow|final-slow|key-change|scene-change|expiry-24h|expiry-7d|expiry-create|queue-timeout|shutdown-queued|shutdown-prepare|ticket-pressure|tx-timeout|no-retry`；并发单场景名见 `production-worker.test.ts`。覆盖原 UUID 优先恢复、真实 PREPARE/FINAL 预算、取消/队列容量、事务回滚和禁自动重试，以及并发提交、未知结果、丢回执、旧 null 恢复读取交错。断言最终 row/receipt/写入唯一性及 owner/意图/目的边界。

恢复 suite 支持 `--kind=rebase|no_ff|squash|all`、`--case=restart|offline-rebuild|fast-rebuild|unstaged|all`、`--translation=on|off` 和 `--iterations=1..1000`（快速同字节重建默认20次）。覆盖完全退出后的只读换签、24小时/固定七日期限、真实目录代际变化、源/目标接收范围、已受理 UUID 在密钥失效后继续恢复，以及真实 SessionManager 的投递确认。

观察只通过调用原方法的 spy、真实查询后的有限屏障、现场文件/密钥变化及请求局部时钟投影进行；不替换生产校验、事务 options 或截止逻辑。`cold` 为注入延迟，不是 native 冷启；`tx-timeout` 为已进入 create 的真实超时回滚，未独立制造连接获取超时。受理 suite 的七日投影同时越过24小时，固定七日不可延期另由恢复 suite 与 `message-delivery.integration.test.ts` 验证。没有完整浏览器认证、真实网络丢回执或付费 Agent 验证。

`report.json` 保存状态、生产/测试源码 hash 和有限观察，不复制包含正文或 token 的原始 worker 输出。日常行为回归另见 `packages/server/src/services/__tests__/message-delivery.integration.test.ts`、`conflict-admission.test.ts`、`conflict-recovery-key.test.ts`；整体维护入口为 [语言转换](../../../docs/conversation-language-translation.md)。
