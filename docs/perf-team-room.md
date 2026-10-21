# 团队房间输入与任务切换卡顿修复

2026-10-21，基于 `0f4485fa` 工作区。

## 原因与边界

`RoomTimeline` 把输入草稿、提及选择、附件上传和全部历史消息放在同一个渲染组件中。输入一个字符会再次访问房间翻译查询，并遍历、渲染全部历史 Markdown；每条消息还会挂载查询、布局测量和 ResizeObserver。任务切换则需要一次性挂载全部历史。

之前 `LogStream` 的日志虚拟化仍在，但团队房间使用独立实现，没有这层保护。

修复将历史和翻译订阅放到 memo 化的 `RoomMessageList`，保持输入回调与历史 props 稳定。`VirtualRoomMessageList` 只挂载可见消息、审批和 overscan 行；滚动测量独立于房间查询，初次解析容器和隐藏面板也不会全量挂载。原文展开状态在房间层保留；行高动态测量，沿用日志的滚动锚点策略。跳到底部和高度修正使用即时滚动，避免遍历途中大量挂载；新消息不夺走历史阅读位置。

## 浏览器对照

同机 Chromium、Vite 开发模式、真实 RoomTimeline/Streamdown/Query，使用隔离 transport 的固定消息 fixture；不访问运行中的团队或启动 Agent。输入指标为 15 次逐字 input 到下一次 requestAnimationFrame 的耗时，**不是生产 INP**；切换指标为 fixture Task A/B 切换到下一帧，不含真实任务 API 和首次模块下载。

| 指标 | 修复前，500 条 | 修复后，500 条 | 修复后，3000 条 |
| --- | ---: | ---: | ---: |
| 页面 DOM 节点（初始稳定状态） | 12,902 | 257 | 257 |
| 挂载历史行 | 500 | 8 | 8 |
| 输入耗时范围 | 48–120 ms | 1.2–10.4 ms | 1.3–16.6 ms |
| 输入耗时中位数 | 51.6 ms | 1.5 ms | 2.0 ms |
| 输入期间 >50 ms 长任务 | 10 | 0 | 0 |
| 任务切换到下一帧 | 617 ms | 37 ms | 36 ms |

390 × 844 紧凑模式、3000 条消息：初始 9 行 / 283 个节点，输入中位数 1.5 ms、最大 3.2 ms，输入与切换期间无长任务。桌面 500 条切换后仍观测到一次 54 ms 长任务；虚拟化不保证任意单条复杂 Markdown 都能在一帧内完成。

三组浏览器场景均确认：可回看第一条；离屏行卸载；展开长消息后离屏再返回仍保持展开；阅读旧消息时追加不跳动；回到底部、底部追加和发送后距离底部 ≤1 px；切换任务清空草稿；窄屏无横向溢出。

## 回归与复现

- 新增桌面/紧凑输入隔离和千条隐藏历史有界渲染用例；在旧实现上 3 项全部失败（编辑期间历史 Markdown 被重渲染 150 次），修复版通过。
- 团队组件、提交恢复和翻译相关 58 项测试通过；`pnpm --filter web build` 通过。定向 ESLint 无错误；TanStack Virtual 仍有 React Compiler 不兼容提示，虚拟器实例仅在该非 memo 组件内消费。
- 开发指南同步记录输入/历史/滚动三层边界，防止视觉组件重建时重新合并。

使用工作区后台服务运行 web Vite，打开 `/src/components/team/__tests__/room-timeline.fixture.html?count=500`，或改成 `count=3000`；加 `&compact` 并设置窄视口验证移动布局。fixture 的 `Task A` / `Task B`、`Append reply` 和输入框均只修改内存。`window.roomMetrics` 提供 React Profiler commit 时长和 Long Task 记录，`window.roomFixture` 标识当前数据规模；测量前等待最后一条消息可见并清空 metrics，期间不要触发 HMR。

```bash
pnpm exec vitest run packages/web/src/components/team/__tests__ packages/web/src/hooks/__tests__/use-team-run-translations.test.tsx packages/web/src/hooks/__tests__/team-room-submission.test.tsx
pnpm --filter web build
```
