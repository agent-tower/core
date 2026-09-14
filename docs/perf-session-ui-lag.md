# Session 会话变长后前端卡顿 — 性能定位报告

> 范围：dsh (DeepSeek Hermes) ACP runtime 输出很快，但**会话内容越多界面越卡**。
> 本文只做定位与方案，未修改 `packages/**` 业务代码（唯一例外：§10.4 披露的 debug-gated 打点，默认关闭、不改变行为）。
> 测量日期：2026-09-11。测量机：Apple Silicon macOS，Node v22.19.0，Chrome 152.0.7977.83。
>
> **v2 修订**：本文在独立审查（APPROVED_WITH_CHANGES）后补齐了三项阻断验证，其中两项**推翻了 v1 的关键前提**。
> 请先读 §0.2「v1 → v2 更正」。
>
> **v3 修订（2026-09-11，P0-3 修复轮）**：基准 fixture 的每-entry 体积被证实**低估 2.6×**
> （旧 fixture 3.27 KB/entry vs 真实长会话 **8.89 KB/entry**）。fixture 已按本机真实会话快照的实测分位数重新标定
> （§1.1），并回填独立复测的**真实数据**实测结果（§14）。结论更正：**真实长会话下 1000 档就已需要 P0-2**（§0.3）。
>
> **v5 修订（2026-09-11，P0-3 收尾修复轮）**：修掉显示/隐藏转换期间的虚拟化告警与测量丢弃（§14.7）；
> §14.6 的 A/B 表补「**读者所在行的视口位移**」列，并把锚定边界措辞对齐到**含容器 `padding-top` 的库坐标系**；
> 标注 `out/anchor-*.json` 的**驱动可信度**问题（长阻塞脚本经 `agent-browser eval` 会并发重放，绝对数字不作定论）。
> **阅读规则**：§4、§9、§13 的数字（除明确标注外）来自**合成 fixture**，绝对量级系统性偏低；§14 全部来自**真实会话快照**。

---

## 0. 结论速览（v2）

### 0.1 修正后的结论

卡顿的机制是**每次会话更新都按"整个会话"付成本**，但**触发频率远低于 v1 的假设**：

1. **每一条 patch 的成本随会话长度线性增长**：真实 Chrome 实测单 patch 主线程阻塞
   **117 ms @1000 entries / 221 ms @3000 entries**（tool 类 patch），其中
   - 客户端 store 的一次全文档深拷贝（`applyPatch(..., mutateDocument=false)`）占 **37 / 74 ms**，
   - 其引发的分配 + GC 才是主项：**纯 store 对照（不挂载 LogStream、无 React 渲染）单 patch 仍是 99 ms @3000 entries，
     而 `ScriptDuration` 只记到 4 ms**，主线程 `TaskDuration` 10.0 s / 10 s 窗口 —— 即成本几乎全部是分配与 GC，不是 JS 执行、也不是排版绘制。
2. **patch 频率不是 300–400/s**（v1 的核心前提，已实测推翻）：真实 dsh `--profile acp` **按"步"批量下发**，
   一条消息 / 一段思考 / 一次工具调用各一帧，实测 **0.5–1 帧/s，突发时 2–3 帧挤在 ~10 ms 内**（§11）。
   "1 token = 1 patch" 与"单条消息累计传输 O(len²) = 8 MB"都不成立（真实值：整轮 24.7 s / 13 帧 / 总计 65 KB）。
3. 因此用户感知的卡顿来自三件事，按实测影响排序：
   - **每步一次的全量重算**（本篇 §9）：每个 patch 阻塞主线程 100–360 ms（长会话），
     一个 30 次工具调用的回合累计 3–20 s 的卡顿；
   - **打开/切换长会话时的挂载**（§9.4）：1000 entries 阻塞 **1.8–4.8 s**，3000 entries 阻塞 **5.8–9.2 s**；
   - **`session/load` 回放的整数组 replace**（§10）：4.66 MB/帧的尖峰，**低频但会发生**（触发链见 §10.2）。

**修正后的根因排序**（全部为真实 Chrome 实测，不再是 happy-dom）：

| 排序 | 层 | 根因 | 真实 Chrome 单 patch 成本（1000 → 3000 entries） | 证据 |
|---|---|---|---|---|
| **1** | B. 客户端 store | 每个 patch 对整个 conversation 做 `JSON.parse(JSON.stringify(...))`；**成本 ≈ 分配 + GC**（JS 自时间几乎为 0） | **37 → 74 ms**（纯 store 对照 32 → 99 ms；GC 尖峰到 296 ms） | §9.2、§9.3 |
| **2** | C. React 渲染 | `LogStream` 无虚拟化，每帧重建整棵元素树（挂载后 4789 → 14369 个 DOM 节点） | **+80 → +139 ms**（DOM 安静等待时间） | §9.2 |
| **3** | D. markdown | 流式 assistant 消息每个 patch 用累计全文重渲染 `Streamdown` | tool patch 117 ms → md/code patch **238 ms** @1000（真实浏览器里 D 比 happy-dom 显示的更大） | §9.2 |
| —（已排除） | A. 服务端/传输 | 每步一帧的批量下发（**不是** 1 token 一帧），累计传输很小 | 整轮 13 帧 / 65 KB（模型生成 24.7 s） | §11 |
| **4** | A. 服务端 | `reconcileLoadedHistory` 整数组 `replace /entries`，一帧等于整个会话（**低频**） | 1461 entries → **4.66 MB/帧**；触发链与频率见 §10 | §10.3 |

**不是**主因（已实测排除）：`normalizedEntriesToLogEntries`（0.5–15 ms @3000–5000）、
`groupExecutionDetails`/`splitConversationTurns`、服务端 `pushPatch` 快路径（0.004 ms）、
以及**排版绘制**——真实 Chrome 单 patch 的 `Recalculate Style + Layout + Paint` 合计只有 **1–5 ms**（§9.3），
审查怀疑的"14k 节点让 C 更重（Recalculate Style/Layout/Paint）"**没有发生**。

**一句话方案**（v2 顺序）：先做 **P0-2 结构化共享 + adapter 引用缓存**（干掉每步一次的深拷贝 GC 风暴），
再做 **P0-3 虚拟化**（把挂载从秒级降到百毫秒级、把单帧渲染从 O(entries) 降到 O(视口)），
`P0-1 合帧`因实测频率过低**降级为可选优化**，`P1-2` 保持"加守卫 + 打点"。

> **v3 数量级修正**：上表的绝对数字来自**旧合成 fixture（3.27 KB/entry）**。按真实长会话（8.89 KB/entry）复测，
> store 成本约为表中数值的 2–3 倍：**1000 档单 patch store 中位 60.3 ms、地板 avg 18.95 ms / Long Task 13.69%**，
> 即 **1000 档就已需要 P0-2**（§0.3、§14.2）。

### 0.2 v1 → v2 更正（审查阻断项）

| # | v1 的说法 | v2 实测结论 |
|---|---|---|
| 1 | 「300–400 patch/s → 每秒需要 5–20 秒 CPU，必然堆积卡顿」 | **频率前提错误**。dsh 按步批下发，实测 **0.5–1 帧/s**（§11）。真正的问题是**每帧 100–360 ms 的阻塞**，不是每秒几百帧。合帧（P0-1）因此从"第一优先级"降级。 |
| 2 | 「流式 delta 携带整段累计文本，单条 2000 token 消息累计传输 8.07 MB（O(len²)）」 | **模型化假设错误**（bench c1 假设 1 token = 1 chunk）。真实 dsh 一条消息只有 1–3 帧、累计 65 KB/轮（§11.4）。传输不是主要成本。 |
| 3 | 「排序 C 渲染 > B 深拷贝 > D markdown（happy-dom）」 | **排序方向保留、差距和机制都变了**（§9.5）：真实浏览器里 B（37→74 ms）与 C（80→139 ms）只差 ~1.2–1.9×，且 B 的成本几乎全是 GC；D 的绝对值比 happy-dom 显示的大得多。**§4.4 的 happy-dom 绝对数字不再作为结论依据。** |
| 4 | 「通常 happy-dom 更慢」 | 无交叉证据，**撤回**。实测多数场景 happy-dom 更快（它没有真实树构建/样式/布局，也没有同量级 GC）。 |
| 5 | 「发一条消息会触发整个会话回放、单帧 4.66 MB」 | **有条件成立**：需要"非终态 + 外部 session id + 新 driver 实例 + agent 回放有更新 + reconcile 有变化"同时成立（§10.2）。线上频率量化见 §10.3，判断：**低频（每周量级）但后果严重**，维持 P1-2 的守卫 + 打点，不做整表重写。 |

### 0.3 v3 更正（2026-09-11，P0-3 修复轮）：fixture 体积标定 + 真实数据回填

| # | v2 的说法 | v3 实测结论 |
|---|---|---|
| 1 | 「fixture 3.27 KB/entry，可作为规模标定」 | **标定错误，低估 2.6×**。本机真实长会话实测 **8.89 KB/entry**（§14.1）：同为 3000 entries，旧 fixture 9.6 MB vs 真实 **24.9 MB**。已把 fixture 校准到 **9.0 KB/entry**（§1.1、§14.3），后续基准不再系统性看轻问题。 |
| 2 | 「P0-3 后 1000 档基本达标（avg 16.67–18.12 ms，LT 0–5.38%）」 | **在真实尺寸下不成立**。1000 entries 真实数据（6.9 MB）单 patch store 中位 **60.3 ms**、10 s 窗口 store-only 地板 avg **18.95**、Long Task **13.69%** → 1000 档同样不达标，且同样由 store 深拷贝造成（§14.2）。 |
| 3 | 「**3000 档**门槛仍需 P0-2」 | 更正为「**真实长会话下 1000 档就已需要 P0-2**」——P0-2 的优先级与收益按真实尺寸计算，比 v2 估计更高。 |

**数据来源标注（v3 起强制）**：

| 来源 | 章节 | 说明 |
|---|---|---|
| **合成 fixture（旧，3.27 KB/entry）** | §4（happy-dom）、§9（Chrome）、§13.2–13.4（P0-3 前后对比） | 相对量级与归因仍有效；**绝对成本偏低约 2.6×**（store 类成本与文档字节线性相关，见 §14.2 的缩放表）。 |
| **合成 fixture（已校准，9.0 KB/entry）** | §1.1、§14.3 | 每-entry 体积与分布对齐真实快照；§14.3 给出校准后的 Node 实测。 |
| **真实会话快照** | §3、§14 | 本机 `~/.agent-tower/data.db` 的 `Session.logSnapshot`（只读导出），最大的两个会话 3238 entries / 28.10 MiB。 |

---


## 1. 复现方式

### 1.1 基准脚本

脚本放在仓库的 **gitignored scratch 目录**（未提交、未改业务代码）：

```
node_modules/.at-perf/            # 本仓库内（.gitignore: node_modules/）
├── fixtures.ts                   # 生成拟真 ACP 会话（v3 校准后 ~9.0 KB/entry，见下）
├── calibrate-fixture.ts          # fixture 体积标定自检（分类占比 + 分位数 + store 成本）
├── bench-a-apply-patch.ts        # (a) applyPatch 深拷贝成本
├── bench-b-log-adapter.ts        # (b) adapter / LogStream 纯函数派生成本
├── bench-c-acp-frames.ts         # (c) 真实 AcpProjector + MsgStore 的 patch 字节数
├── bench-d2-react.ts             # (d) happy-dom + 真实 LogStream 的 React commit 成本
├── bench-e-fix-sim.ts            # (e) 候选修复的效果模拟
└── stub-i18n.ts                  # 仅供 bench：替换 useI18n（Provider 依赖 react-query）
```

**fixture 体积标定（v3，2026-09-11）**：v1/v2 的 fixture 每-entry 只有 **3.27 KB**，比真实长会话低 **2.6×**，
会让所有基准系统性看轻问题。v3 以本机 `~/.agent-tower/data.db` 的真实快照为参照重新标定：

| 项 | 数值 |
|---|---|
| 参照数据 | 最大的两个真实会话（`4527a14c…` + `78eaeba4…`）拼接：3238 entries / 28.10 MiB |
| 真实每-entry 体积 | **8.89 KB/entry**（前 3000 条 = 24.9 MiB） |
| 真实类型占比 | tool_use 78.0% / thinking 15.7% / assistant_message 5.6% / usage 0.3% / user 0.2% / error 0.1% |
| 真实分位数 | p10 0.19 / p25 0.30 / p50 4.02 / p75 11.07 / p90 19.82 / p99 65.93 KB |
| **校准后的 fixture** | **9.0–9.2 KB/entry**（1000 → 9.00 MiB，3000 → 26.41 MiB）；分位数 p50 3.4–3.8 / p90 20.9–22.2 / p99 66.5–67.0 KB；类型占比误差 <1pp |

分位数表与生成规则写在 `fixtures.ts` 文件头（含标定依据），自检命令：

```bash
ESB=node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild
$ESB node_modules/.at-perf/calibrate-fixture.ts --bundle --platform=node --format=esm \
  --outfile=node_modules/.at-perf/out/calibrate.mjs \
  --alias:fast-json-patch=./packages/web/node_modules/fast-json-patch
node node_modules/.at-perf/out/calibrate.mjs
```

> fixture 与脚本都在 gitignored scratch 目录（沿用 v1 约定，不提交业务代码之外的文件），
> 因此标定依据同步记录在本节与 §14.3，`pnpm clean` 后可按上表重建。

另外有一份副本在 `/tmp/at-perf-scripts/`（`pnpm clean` 后仍可用）。

构建与运行（`node_modules/.at-perf/node_modules` 是指向 `packages/web/node_modules` 的软链，用于解析 react 等依赖）：

```bash
ESB=node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild
ln -sfn "$PWD/packages/web/node_modules" node_modules/.at-perf/node_modules

# (a) (b) (c)
$ESB node_modules/.at-perf/bench-a-apply-patch.ts --bundle --platform=node --format=esm \
  --outfile=node_modules/.at-perf/out/bench-a.mjs \
  --alias:fast-json-patch=./packages/web/node_modules/fast-json-patch
node node_modules/.at-perf/out/bench-a.mjs

# (d) 需要 --jsx=automatic（web 的 tsconfig 是 project references，esbuild 不会继承 jsx 设置）
$ESB node_modules/.at-perf/bench-d2-react.ts --bundle --platform=node --format=esm --splitting \
  --outdir=node_modules/.at-perf/out/d2 --jsx=automatic --loader:.css=empty \
  --alias:@/lib/i18n=./node_modules/.at-perf/stub-i18n.ts \
  --alias:@agent-tower/shared/log-adapter=./packages/shared/src/log-adapter.ts
node node_modules/.at-perf/out/d2/bench-d2-react.js
```

完整原始输出：`/tmp/at-perf-bench.txt`。

### 1.2 测量口径与偏差说明

- **(a) (b) (c)** 是 Node 纯 CPU 测量，与浏览器同量级，可直接采信。
- **(d)** 用 **happy-dom** 而不是真实 Chrome：绝对耗时与 Chrome 有差异（通常 happy-dom 更慢），但**被测的是真实组件代码 + 真实 store + 真实数据流**，
  量级与随规模增长的斜率是可信的；`<Profiler>` 的 `actualDuration` 只统计 React 提交内的工作，
  因此**深拷贝等同步工作被单独记为 `syncApply_ms`**，两者相加才是单 patch 真实成本。
- 每次 patch 用 `setTimeout(0)` 分隔，模拟"一个 socket 事件一个宏任务"，与浏览器 Socket.IO 的派发粒度一致（实测 **2 次 commit/patch**）。
- 会话规模 101 / 1001 / 3001 entries；**真实数据库里最大的 ACP 会话是 1461 entries / 14.9 MB**（见 §3），
  即 benchmark 的中间档就是线上真实规模。
- **v3 标注**：本节及 §4、§9、§13 的 fixture 数据在 v2 时是 **3.27 KB/entry** 的合成数据（现已校准为 9.0 KB/entry）。
  按真实尺寸回填的实测数字见 §14；**跨版本的绝对数字不要混用**，只能比较同表内的前后列。
- 逐次运行抖动约 ±30%（GC），本文引用的是同一轮完整跑批（`/tmp/at-perf-bench.txt`）的数字。

---

## 2. 完整数据流（定位地图）

```
ACP agent (dsh)
  └─ sessionUpdate notification (每个 token 一个 agent_message_chunk)
      └─ AcpProjector.projectContent()                        server/src/runtime/acp/projector.ts:100
          ├─ existing.content += text                          ← 累计全文
          └─ pushPatch(updateEntryContent(index, 累计全文))     output/utils/patch.ts:61
              ├─ MsgStore.push → dropStaleReplaces              output/msg-store.ts:166   (服务端内存)
              └─ sink.stream({conversation_patch})              projector.ts:233
                  └─ SessionManager.handleRuntimeTurnEvent      services/session-manager.ts:1505
                      └─ EventBus 'session:patch'
                          └─ SocketGateway.onPatch              socket/socket-gateway.ts:135
                              └─ socket.emit('session:patch', {sessionId, patch, seq})   ← 每 token 一帧
                                  ▼
浏览器 useNormalizedLogs.handlePatch                    web/src/lib/socket/hooks/useNormalizedLogs.ts:274
  ├─ setState × 2（isOutputActive / isLoading）           :277,:321
  └─ sessionLogStore.applyPatch(sessionId, patch, seq)   :300  ← ① 全文档深拷贝          [根因 2]
      └─ zustand set → useSyncExternalStore 触发重渲染    stores/session-log-store.ts:135
          └─ useMemo(normalizedEntriesToLogEntries)      :668  ← ② 全量重建 LogEntry[]（新对象）
              └─ <LogStream logs={logs}/>                components/agent/LogStream.tsx:817
                  ├─ splitConversationTurns(logs) 全量     :819  ← ③ 每个 turn/entry 重建元素树
                  ├─ groupExecutionDetails(logs) 全量      :750
                  ├─ 渲染全部 turn（无虚拟化）              :849   ← ④ 根因 1（4793~14373 DOM 节点）
                  └─ 流式那条 assistant 消息重跑 Streamdown :496   ← ⑤ 根因 3
```

---

## 3. 真实数据基线（用户本机 `~/.agent-tower/data.db`，只读查询）

会话越长越卡 → 先确认线上到底有多长：

```sql
SELECT COUNT(*) FROM Session WHERE logSnapshot IS NOT NULL;                                  -- 5998
SELECT COUNT(*) FROM Session WHERE length(logSnapshot) > 1000000;                           --  101
SELECT COUNT(*) FROM Session WHERE length(logSnapshot) > 5000000;                           --    5
SELECT COUNT(*) FROM Session WHERE json_array_length(json_extract(logSnapshot,'$.entries')) > 500;  -- 36
SELECT COUNT(*) FROM Session WHERE json_array_length(json_extract(logSnapshot,'$.entries')) > 1000; --  7
```

Top 会话（按快照字节）：

| session | runtime | entries | logSnapshot |
|---|---|---|---|
| 4527a14c… | ACP | **1461** | 14.9 MB |
| 78eaeba4… | CLI | 1777 | 13.6 MB |
| 026311ba… | ACP | 1368 | 8.35 MB |
| 05ffc6ed… | ACP | 1459 | 7.29 MB |

- 样本整体 **≈9.8 KB/entry**（比 benchmark 用的 3.27 KB/entry 更重，即线上更糟）。
  **v3 复核（实测）**：按字节最大的 12 个会话合并为 **6.91 KB/entry**（11512 entries / 77.68 MiB），
  单会话区间 **4.09–11.96 KB/entry**；其中最大的两个会话（独立复测使用的同一份数据）为 **8.89 KB/entry**
  （3238 entries / 28.10 MiB）——v3 fixture 即以此为准（§1.1、§14.1）。
- 只要会话进入 **500–1500 entries 区间**（长会话最常见的量级），当前实现就已经远超 16.7 ms/帧的 60 fps 预算。

---

## 4. 逐条验证

### 4.1 线索 1 — `applyPatch(..., true, false)` 深拷贝：**确认（且比预想更严重）**

`packages/web/src/stores/session-log-store.ts:135`

```ts
const result = applyPatch(current, patch, true, false)   // mutateDocument = false
```

`fast-json-patch@3.1.1` 的 `applyPatch`：

```js
if (!mutateDocument) { document = helpers_js_1._deepClone(document); }   // = JSON.parse(JSON.stringify(obj))
```

所以**每一个流式 delta** 都会对整个 conversation 做一次 JSON 序列化 + 反序列化。

`bench a`（patch 只改最后一条 entry 的 content，patch 本身 ~4 KB）：

| entries | 文档大小 | `mutateDocument=false` | `mutateDocument=true` | 倍数 |
|---|---|---|---|---|
| 100 | 311 KB | **0.48 ms** | 0.003 ms | 158× |
| 1000 | 3.27 MB | **3.91 ms** | 0.005 ms | 751× |
| 5000 | 16.3 MB | **21.4 ms** | 0.003 ms | 8554× |

两个衍生结论：

1. **成本与 patch 大小无关，与整个会话大小成正比**——这正是"会话越长越卡"的直接来源。
2. **所有 entry 的对象标识每 patch 都变**（`untouchedEntryNewIdentity: true`，bench a 末列），
   于是 `LogStream.tsx` 里所有 `memo(...)`（`ToolBlock`/`ToolGroupItem`/`ThinkingBlock`/`AssistantMessage`/`MarkdownMessage`）**必然失效**，
   把根因 1 的渲染成本也一起放大了。
3. `useNormalizedLogs.ts:502` 在快照对齐时对缓冲 patch 也用了同一调用（同样深拷贝），只是频率低。

### 4.2 线索 2 — `normalizedEntriesToLogEntries` 全量重算：**确认存在，但不是主因**

`packages/web/src/lib/socket/hooks/useNormalizedLogs.ts:668`，依赖 `conversation.entries`（每 patch 新引用）。
`bench b`（真实 `packages/shared/src/log-adapter.ts` + `LogStream` 中同名纯函数副本）：

| entries | `normalizedEntriesToLogEntries` | `getPersistedCursorActivity` | `splitConversationTurns + groupExecutionDetails` | 合计 | 是否产生新 LogEntry 对象 |
|---|---|---|---|---|---|
| 100 | 0.014 ms | 0.008 ms | 0.027 ms | **0.049 ms** | 是 |
| 1000 | 0.201 ms | 0.032 ms | 0.128 ms | **0.361 ms** | 是 |
| 5000 | 0.156 ms | 0.055 ms | 0.161 ms | **0.372 ms** | 是 |

- 绝对量级 <0.4 ms/patch（400 patch/s → 0.15 CPU·s/s），**不是主因**，但它产生的新对象是 memo 失效链条的一环（配合 §4.1 一起修才有意义）。
- 对照组 `bench d2`：把 store 更新 + adapter 保留、但不渲染 `LogStream`（只渲染 `<div>`），
  每 patch React 提交 0.01 / 0.11 / 0.47 ms（100/1000/3000）——**说明这些纯函数不是问题**。

### 4.3 线索 3+4 — 服务端 patch 帧与 `updateEntryContent`：**确认**

`projector.ts:100-118` 明确把 delta **追加到累计文本**再整段下发：

```ts
existing.content = sanitizeText(`${existing.content}${text}`)   // :108
this.pushPatch(updateEntryContent(existing.index, existing.content))  // :109 → replace /entries/N/content = 累计全文
```

`bench c1`（真实 `AcpProjector` + `MsgStore`，4 字符/token，逐 token 一帧，统计 `JSON.stringify({sessionId,patch,seq})`）：

> ⚠️ **v2 更正**：本节表格建立在"1 token = 1 个 `agent_message_chunk`"的假设上。§11 用真实 dsh 实测证明该假设**不成立**
> （一条完整消息 = 1 帧，一次工具调用 = 2 帧，实测 0.5–1 帧/s）。因此下面的字节数**只说明"若按 token 流式，成本会是多少"**，
> 不能作为线上真实传输量的结论。真实传输量见 §11.4（整轮 65 KB）。O(len²) 的性质本身仍成立，但常数与频率都不适用。

| 最终字符数 | ≈token | patch 数 | 末帧字节 | **累计传输** | 每字符摊到的字节 |
|---|---|---|---|---|---|
| 2000 | 500 | 500 | 2128 | 552 KB | 282 |
| 4000 | 1000 | 1000 | 4129 | 2.08 MB | 533 |
| 8000 | 2000 | 2000 | 8129 | **8.07 MB** | 1033 |

→ 长度翻倍，总字节 **4 倍**：严格 **O(len²)**（`≈ len²/(2·chunk)`）。300–400 tok/s 输出一条 2000 token 的回答 ≈ 8 MB / 6 s ≈ **1.3 MB/s**。
本机 localhost 能扛，经 Cloudflare tunnel 就是明确的带宽/解析压力。

`bench c3`（`reconcileLoadedHistory`，`acp-driver.ts:678` `[{op:'replace', path:'/entries', value: mergedEntries}]`）：

| entries | 单帧 |
|---|---|
| 500 | 1.60 MB |
| 1461（真实最大值） | **4.66 MB** |
| 5000 | 15.96 MB |

触发条件已确认（不是每轮都发生，但可复现）：
`session-manager.ts:759` 只有在 **session 状态已是终态** 时才用 `resumeMode='resume'`（`hasCompletePersistedSnapshot`，:112 要求 status ∈ COMPLETED/FAILED/CANCELLED）；
而 `claimRuntimeLaunch`（:1386）在**每次起新 turn 时会把状态置为 RUNNING**。
因此在 RUNNING 状态下追加消息（TeamRun 唤醒、连续追问、turn 结束但 finalization 未落库的窗口）会走 `session/load` → 全量历史回放 → 一帧 4.66 MB 的整数组替换。
客户端收到这一帧后还要再叠加一次 §4.1 的深拷贝 + §4.4 的全树重渲染 → **发一条消息界面冻结数秒**。

`bench c4/c5`（服务端热路径）：

| entries | `pushPatch` 快路径 | `pushPatch` 慢路径（`dropStaleReplaces` 倒序全扫） | `getSnapshot()` 全量重建 | 15 s checkpoint `stringify+sha256` |
|---|---|---|---|---|
| 100 | 0.0044 ms | 0.008 ms | 0.23 ms | 1.9 ms (1.6 MB) |
| 1000 | 0.0043 ms | 0.032 ms | 1.82 ms | 6.7 ms (4.66 MB) |
| 5000 | 0.0043 ms | **0.202 ms** | 7.71 ms | 16.7 ms (15.96 MB) |

- 快路径 OK；**慢路径 O(messages) 且 messages 随 entry 数增长**（`:193` 每次都从头扫到尾）。
- `scheduleSnapshotPersist`（`session-manager.ts:188` `SNAPSHOT_CHECKPOINT_MS = 15_000`）每 15 s 会**同步**做：
  `getSnapshot()`（因 `dropStaleReplaces` 每次都会置空 cache，`:186/:214`，所以这里必然是**全量重放**）+ 全量 `JSON.stringify` + `sha256`。
  5000 entries 合计 ≈ **25 ms 的 event loop 阻塞**，期间所有 socket 广播（包括流式 patch）一起被推迟。

### 4.4 线索 5 — `LogStream` 是否虚拟化 / 是否全量重渲染：**确认，且是最大头**

`packages/web/src/components/agent/LogStream.tsx`：

- `:817-870` 主组件把 `turns.map(...)` **全量**渲染，**没有任何虚拟化**（`@tanstack/react-virtual` 已在 `packages/web/package.json` 依赖里但 `src` 中零引用）。
- `:750` `renderLogItems` 每次 render 都重新跑 `groupExecutionDetails(logs)`（新数组、新 key），`:819` 每次 render 重跑 `splitConversationTurns`。
- 每个 entry 在 render 阶段都会走 `renderItem()` 新建 React element（1000 entries ≈ 4793 个 DOM 节点，3000 entries ≈ 14373 个）。

`bench d`（happy-dom + 真实 `LogStream` + 真实 store，逐 patch 用 `<Profiler>` 统计提交耗时）：

> ⚠️ **v2 更正**：happy-dom 没有真实样式/布局/绘制，本节数字只是"组件提交工作"的排序，**不能作为浏览器成本依据**。
> 真实 Chrome 的交叉验证见 **§9**（结论：排序方向不变，但 B 与 C 的差距从 ~2.2× 缩到 ~1.2–1.9×，且排版绘制只有 1–5 ms/patch）。
> 另外，`<Profiler>` 在生产构建里不触发（只有 `react-dom/profiling` 才统计），因此 §9 改用 MutationObserver 判定提交完成。

| entries | DOM 节点 | 首屏 mount | 快照大小 | `JSON.parse` | sync（深拷贝，§4.1） | **React commit 中位** | React p95 | **单 patch 合计** |
|---|---|---|---|---|---|---|---|---|
| 101 | 513 | 99 ms | 0.30 MB | ~0 ms | 0.45 ms | **0.92 ms** | 6.35 ms | 1.37 ms |
| 1001 | 4793 | 239 ms | 3.19 MB | 2 ms | 4.06 ms | **9.25 ms** | 17.8 ms | **13.3 ms** |
| 3001 | 14373 | 946 ms | 9.58 MB | 5 ms | 16.37 ms | **35.4 ms** | 105 ms | **51.8 ms** |

- **实测 2 次 React commit / patch** → 300–400 patch/s 即 **600–800 commit/s**。
- 换算 CPU 预算：1000 entries 需要 **≈5.3 CPU·s/s**，3000 entries 需要 **≈20.7 CPU·s/s**（400 patch/s）。
  单核预算只有 1 s/s，**缺口 5–20 倍**——这就是"界面明显卡顿"的定量解释。
- 关键对照实验（`bench d` 的 tool-patch 分组：只改一条 **tool** entry 的 content，markdown 完全不变）：
  仍然要 **9.25 / 35.4 ms**。→ **渲染成本的大头是"整棵树每 patch 重走一遍"，不是 markdown**。
- markdown 影响（同样 120 patch，内容逐步变长；下表两列都是**均值**，可比）：
  | entries | 流式纯文本 markdown patch | 流式 fenced code + 表格 markdown patch |
  |---|---|---|
  | 101 | 3.28 ms | **6.61 ms** |
  | 1001 | 13.58 ms | 17.51 ms |
  | 3001 | 51.25 ms | 49.40 ms |

  对照上面的 tool patch 中位数（0.92 / 9.25 / 35.38 ms）：小会话时 markdown 解析把单帧成本放大了 3–7 倍（根因 3 成立）；
  会话很大时它被根因 1 的整树重走淹没（所以排序第 3）。同时 markdown 的**绝对值随消息长度增长**（同一条消息 120 个 delta 从 0 涨到满长度），
  即单条长消息总成本 O(len²)。

### 4.5 修复效果模拟（`bench e`）：哪些改法真有用

在同一个 happy-dom harness 里模拟两种候选修复：
① 结构化共享的 patch apply（只克隆被改的 entry）；
② 保标识的 adapter（用 `WeakMap<NormalizedEntry, LogEntry>` 缓存，未变 entry 返回同一 `LogEntry` 对象）。

| entries | 现状 sync | 现状 React | 现状合计 | 修复① sync | 修复①+② React | 修复后合计 | 20 patch 合并成 1 次更新 | 提速 |
|---|---|---|---|---|---|---|---|---|
| 1001 | 3.70 ms | 8.99 ms | 12.69 ms | **0.016 ms** | 6.89 ms | 6.91 ms | 6.68 ms | 1.8× |
| 3001 | 13.09 ms | 26.0 ms | 39.09 ms | **0.023 ms** | 26.7 ms | 26.7 ms | 24.9 ms | 1.5× |

结论（**决定了方案排序**）：

- 结构化共享能把 store 侧从 13–16 ms/patch 打到 **0.02 ms/patch（~500×）**，几乎免费，必做。
- 但**它救不了 React**：只降 15–20%。因为 `renderItem()` 仍为全部 N 条 entry 新建 element，React 仍要遍历全部 fiber 做 props 比较/bailout。
- 真正的杠杆是**把每帧的工作量从 O(entries) 降到 O(视口)**：
  - **合帧（coalescing）**：bench 里把 20 条 patch 合并成一次 store 更新，成本 24.9 ms 覆盖 20 个 patch（而不是 20×26 ms）；
    线上按 16 ms 时间窗合帧，400 patch/s 时约 6–7 条 patch 一次 flush，渲染 CPU 直接除以 6–7。
  - **虚拟化**：把渲染量从 3000 条降到可见的几十条，可再降一个数量级。

---

## 5. 非实时链路：REST 快照 / 历史加载

`GET /sessions/:id/logs`（`packages/server/src/routes/sessions.ts:426-459`）直接返回 `msgStore.getSnapshot()` 或数据库里的 `logSnapshot`，**没有分页、没有截断、没有 preview DTO**。

- 3000 entries：响应体 9.58 MB；真实 1461-entry 会话 14.9 MB。
- 服务端每次请求都要把整个快照 `JSON.stringify` 一遍（Fastify 序列化），没有缓存。
- 客户端 `loadSnapshot` 拿到后 `setConversation` → 首屏 mount **946 ms @3000 entries**（bench d 实测，happy-dom），并且这次 mount 会把每条 entry 的 markdown 全部解析一遍。
- 结论：**长会话"打开面板/切换回来"同样会卡**，与实时链路是两个独立问题；`attach()` 里 `isTerminalStatus || isTruncated` 还会触发二次 revalidate（`useNormalizedLogs.ts:628-638`），终态会话每次挂载再拉一次全量。

`TRUNCATE_ENTRIES = 500`（`session-log-store.ts:17`）只在 session 组件卸载且已终态时裁剪（`useNormalizedLogs.ts:379-382`），**运行中的会话完全不裁剪**。

---

## 6. 修复方案（按 收益/成本 排序）

> ⚠️ **v2 优先级修订**（依据 §9 真实浏览器数据 + §11 真实频率）：
>
> | 方案 | v1 定位 | **v2 定位** | 原因 |
> |---|---|---|---|
> | P0-2 结构化共享 + adapter 引用缓存 | 与 P0-1 同批 | **第一优先**（单独可交付） | 每 patch 37→74 ms 的 store 成本几乎全是它引起的分配/GC；去掉后单帧阻塞直接减半 |
> | P0-3 LogStream 虚拟化 | 第三 | **与 P0-2 并列第一** | 长会话"打开就卡 1.8–9.2 s"只有它能解；单帧渲染也从 O(entries) 降到 O(视口) |
> | P0-1 客户端合帧 | 第一（前提 400 patch/s） | **降级为可选微优化** | 实测 patch 频率 0.5–1/s，只有"2–3 帧挤在 10 ms 内"的突发能受益；前提不成立 |
> | P1-2 去掉整数组 replace | 第二步 | **维持：先加"无变化不发帧"守卫 + debug 打点**，整表 diff 留到 P0 之后 | 触发频率低（§10.3），但单次后果严重（秒级冻结） |
> | P2-2 REST 分页/preview | 按需 | **优先级上升**（可提前到 P0-3 之前作为止血） | 长会话挂载 5.8–9.2 s 的直接来源 |
>
> 下面各小节的**技术方案本身不变**，只是排序与前提标注需要按上表理解。

### P0-1 客户端合帧：把 300–400 次状态更新/s 压到 30–60 次/s

- **改哪里**：`packages/web/src/lib/socket/hooks/useNormalizedLogs.ts:274-322`（`handlePatch`）+ `packages/web/src/stores/session-log-store.ts`（新增批量入口）。
- **怎么改**：
  1. `handlePatch` 不再直接 `store.applyPatch`，而是 `pendingOpsRef.current.push(payload)`，用 `requestAnimationFrame`（或 32 ms 定时器）flush 一次；
  2. flush 时把这一批 payload 的 `patch` 数组合并成**一个 Operation[]**，一次 `store.applyPatch(sessionId, mergedOps, maxSeq)`（顺序语义天然正确，`seq` 取批内最大值）；
  3. 会话不可见（面板关闭 / document.hidden）时降频到 250 ms 或直接暂停 flush。
- **收益**：commit 次数直接除以批大小。400 patch/s（实测 2 commit/patch = 800 commit/s）、16 ms 批间隔 → **~60 commit/s，即 13× 更少**；单次 flush 仍只付一次渲染成本。
- **成本/风险**：约 40 行；需保留 `snapshotLoadedRef`、缓冲队列与 `seq` 去重逻辑；`isOutputActive`/`isLoading` 的 setState 也要一并在 flush 时调用。
- **注意**：合帧**只减少次数、不降低单次成本**。3000 entries 时单次渲染仍要 ~36 ms，60 次/s = 2.2 CPU·s/s，仍然跟不上，必须配合 P0-3。
- **验证**：`handlePatch` 计数日志（`DEBUG_LOGS=true`）应显示 flush 次数 ≈ 1/6 patch 数（400 patch/s、16 ms 批）；`bench e` 的 coalesced 分组（24.9 ms 覆盖 20 个 patch）。

### P0-2 结构化共享的 patch apply：干掉每 patch 的全文档深拷贝

- **改哪里**：`packages/web/src/stores/session-log-store.ts:135`（以及 `useNormalizedLogs.ts:497-507` 的缓冲重放）。
- **怎么改**：不再用 `applyPatch(current, patch, true, false)`。新增一个只处理会话 patch 形状（`/entries/{i}`、`/entries/{i}/content`、`/entries/{i}/metadata/*`、`/sessionId`）的 `applyConversationPatch`：
  ```ts
  const entries = conversation.entries.slice()          // 浅拷贝数组
  // 只对 op 命中的下标做 entry 浅拷贝（{...entry, metadata:{...entry.metadata}}），未命中的 entry 保持原引用
  const next = { ...conversation, entries }             // 顶层浅拷贝
  ```
  对不认识的 path 保留一个 `fast-json-patch` 兜底分支（并 `console.warn`），保证契约不破。
- **收益**：store 侧 **13–16 ms/patch → 0.02 ms/patch（~500×）**；同时**未变更 entry 保持对象标识**，`LogStream` 的 `memo` 边界恢复生效（`bench e` 实测再省 ~15–20%）。
- **成本/风险**：约 60 行 + 单测（`packages/web/src/stores/__tests__`）；必须与 server 端 `packages/server/src/output/utils/patch.ts` 的 op 形状保持同步——建议在同一次改动里把 op 形状收敛成 shared 常量/类型，避免两侧漂移。
- **注意**：**不要**简单改成 `mutateDocument=true`——那会破坏 zustand 的引用变更通知，React 不会重渲染。

### P0-3 `LogStream` 虚拟化 + 消除 O(n) 的 render 期重建

- **改哪里**：`packages/web/src/components/agent/LogStream.tsx`（`:742-754`、`:817-870`）。
- **怎么改**：
  1. 用已在依赖里的 `@tanstack/react-virtual` 做**turn 级 + item 级**两层虚拟化：外层按 `turns` 虚拟化，展开的 turn 内部再按 `RenderItem` 虚拟化（`measureElement` 处理不定高）；
  2. `groupExecutionDetails` 结果按 `logs` 引用缓存（`useMemo` 提升到 `LogStream` 里、按 turn 拆分），避免每帧重建数组导致 `ExecutionDetailsGroup` 的 `memo` 失效；
  3. `renderConversationTurn` 里的 `findFinalResponseIndex` / `getTurnDuration` / `processedLogs.some` 全部按 turn 用 `useMemo` 缓存（目前 400 个 turn 每帧各跑一遍 O(turn)）。
  4. 长会话默认折叠历史 turn（已有 `ProcessedGroup` 折叠机制，只需默认 `isOpen=false` 并按可视区懒展开）。
- **收益**：单帧渲染从 **O(entries) → O(视口)**。按 bench d 外推，3000 entries 的 35 ms/patch 可降到 **1–3 ms**；DOM 节点从 14k 降到 ~1k；首屏 mount 从 946 ms 降到 ~100 ms 量级。
- **成本/风险**：LogStream 交互较多（`useStickToBottom` 跟随底部、展开/折叠、`scrollToBottom` 命令式句柄、`onUserToggleDetails`），虚拟化后需要重新校准"跟随底部"和 `data-processed-content` 的展开动画（`grid-template-rows` 过渡与虚拟化冲突，建议展开项不做高度动画）。**这是本方案里唯一的中等规模重构**，建议单独一个 PR + 手工回归。

### P1-1 流式 delta 只传增量（去掉 O(len²) 传输）

- **改哪里**：`packages/server/src/runtime/acp/projector.ts:100-118` + `packages/server/src/output/utils/patch.ts:61` + 客户端 store（P0-2 的 `applyConversationPatch`）。
- **怎么改**：为流式文本新增一个自定义 op（例如 `{ op: 'append', path: '/entries/N/content', value: chunk }`），
  服务端 `MsgStore` 的重放（`applyStoredPatch`）和客户端 `applyConversationPatch` 都实现 `append`；
  `dropStaleReplaces` 的"同 path 覆盖"语义需要为 `append` 单独考虑（append 不可丢，但可以合并到前一条 append）。
- **收益**：单条消息传输量从 **8.07 MB → ~8 KB（2000 token 消息）**，同时每帧 JSON 解析成本从 KB 级降到十几字节。
- **成本/风险**：改的是**跨端 patch 契约**（server MsgStore 重放 + 客户端 apply + 历史快照兼容），需要同步 `packages/shared` 类型与两侧单测；旧客户端遇到未知 op 必须能安全回退（保留 `applyPatch` 兜底 + 触发一次 snapshot 重拉）。

### P1-2 `reconcileLoadedHistory` 不要整数组替换

- **改哪里**：`packages/server/src/runtime/acp/acp-driver.ts:658-682`。
- **怎么改**：
  - 首选：让 `reconcile` 输出**最小 diff**（按 entry id/timestamp 对齐，只在尾部 append + 对差异 entry 发 `replace /entries/N`），而不是 `replace /entries`；
  - 或者：当 `turn.msgStore.getSnapshot().entries` 已经覆盖回放历史（id/时间戳对齐）时**直接跳过整数组替换**（现在 `reconcileAcpHistoryEntries` 已返回 `undefined` 表示"无需合并"，可以扩展这个判断）；
  - 兜底：给整数组替换加一个"仅当 merged 与现有长度差 > 阈值才发"的守卫，并把大帧分片。
- **收益**：消除 4.66 MB（1461 entries）/ 15.96 MB（5000 entries）的单帧尖峰，以及随之而来的客户端全量重渲染。
- **成本/风险**：需要可靠的 entry 对齐键（现有 `historyBoundaryEntryId` 机制可复用）；diff 逻辑写错会导致历史错乱，必须有针对性单测（`packages/server/src/runtime/__tests__/`）。

### P2-1 15 s checkpoint 不要阻塞 event loop

- **改哪里**：`packages/server/src/services/session-manager.ts:2136-2200`（`scheduleSnapshotPersist`/`persistSnapshot`）+ `packages/server/src/output/msg-store.ts:294-351`。
- **怎么改**：
  1. `dropStaleReplaces` 不再无条件置空 `cachedSnapshot`（改为标记"仅 last patch 被替换"的增量失效），让 `getSnapshot()` 走增量路径而不是全量重放；
  2. `JSON.stringify` + `sha256` 的量级已经到 16.7 ms（5000 entries）：把 checkpoint 改成**按 entry 数自适应间隔**（如 `max(15s, entries/500 * 15s)`），或把序列化/哈希挪到 `worker_threads`/`setImmediate` 分片；
  3. 顺带把 `dropStaleReplaces` 慢路径换成 `Map<path, messageIndex>` 索引（现状 0.20 ms/patch @5000）。
- **收益**：消除周期性（每 15 s）≈25 ms 的服务端卡顿，以及慢路径 0.2 ms/patch 的线性开销。
- **成本/风险**：低。纯服务端内部，改完跑 `msg-store`/`session-manager` 现有测试即可。

### P2-2 REST `/logs` 分页化 / preview

- **改哪里**：`packages/server/src/routes/sessions.ts:426-459` + `packages/web/src/lib/socket/hooks/useNormalizedLogs.ts:459-520`。
- **怎么改**：`GET /sessions/:id/logs?limit=300&before=<cursor>` 只返回**尾部 N 条** + `hasMore`/`totalEntries`/`seq`；
  客户端 `loadSnapshot` 拿尾部即可，向上滚动时再拉更早的区间；`isTruncated` 语义正好可以复用（已有 `truncateSession` 的标记）。
- **收益**：长会话首屏从 9.58 MB / 946 ms 降到 ~1 MB / ~100 ms；同时服掉服务端每次请求的全量 `JSON.stringify`。
- **成本/风险**：中。要处理"截断后的 seq 对齐"（现有 `shouldReplaceConversationWithSnapshot` + `pendingPatches` 缓冲机制可复用，但需要仔细设计 cursor 与 patch 的竞态）。

### P3 其它

- `AgentSessionPanel.tsx:95-96` 每帧跑 `useTodos(entries)` / `useTokenUsage(logs, ...)`（都依赖每帧变化的引用）——随 P0-2/P0-3 一起变成增量即可，量级 <0.5 ms，不单独做。
- `handlePatch` 里每 patch 两次 `setIsOutputActive/setIsLoading`（`:277,:321`）——合帧后自然收敛。
- 会话运行中也按 `TRUNCATE_ENTRIES` 保留窗口（如运行中保留最近 1000 条 + "加载更早"），可作为 P0-3 未落地前的**兜底止血**，改动 5 行、收益立竿见影（成本从 O(全部) 变 O(1000)）。

---

## 7. 预期收益汇总（v2：区分实测点与外推点）

**实测点**（真实 Chrome / 真实 dsh / 真实会话快照）：

| 指标 | 实测值 | 来源 |
|---|---|---|
| 单 patch 主线程阻塞 @1001 entries（tool patch） | **117 ms**（store 37 + 渲染/等待 80） | §9.2 |
| 单 patch 主线程阻塞 @3001 entries（tool patch） | **221 ms**（store 74 + 渲染/等待 139） | §9.2 |
| 其中 store 深拷贝 + GC（纯 store 对照，无 React） | **32 ms @1001 / 99 ms @3001**（JS 自时间仅 1.4 / 0.8 ms） | §9.2 |
| 其中排版绘制（Recalculate Style + Layout + Paint） | **0.7–1.4 ms @1001 / 0.9–3.5 ms @3001** | §9.3 |
| 长会话挂载（打开面板） | **1.8–4.8 s @1001 / 5.8–9.2 s @3001** | §9.4 |
| 真实 dsh patch 频率 | **0.5–1 帧/s**（突发 2–3 帧 / ~10 ms） | §11.3 |
| 真实 dsh 单轮通知/字节 | 13 帧 / 65 KB（24.7 s，2 轮） | §11.4 |
| `replace /entries` 单帧（真实 1461-entry 会话） | **4.66 MB**（`bench c3`，Node 实测） | §4.3 |
| 线上快照 >500 entries 的会话数（全 runtime） | 36 个（>500）/ 7 个（>1000） | §3 |
| 高危人口（RUNNING + 外部 id + 快照） | **6 条 ACP 会话** | §10.2 |

**外推点**（标注依据，不作为承诺）：

| 方案 | 3000 entries 单次更新成本 | 改动规模 | 风险 | 依据 |
|---|---|---|---|---|
| 现状（实测） | **≈221 ms/patch**（tool）/ 362 ms（md） | — | — | §9.2 |
| 仅 P0-2 结构化共享（外推） | 预估 ~147 ms/patch（去掉 74 ms store） | ~60 行 + 单测 | 中（见规范文档） | 实测 store 占比 |
| P0-2 + adapter 引用缓存（外推） | 再降 15–20%（memo 恢复） | +~20 行 | 低 | `bench e`（happy-dom） |
| P0-2 + P0-3 虚拟化（外推） | 单帧渲染 O(视口)，预估 **~50–80 ms/patch**；挂载 5.8–9.2 s → 亚秒级 | 中等重构 | 中高 | 需按 §12 口径实测确认 |
| P0-1 合帧（实测频率下） | 仅对 2–3 帧突发有效，收益 <2×，**不改变量级** | ~40 行 | 中（seq 语义，见审查意见 4） | §11.3 |
| P1-2 去掉整数组替换 | 消除 4.66 MB 单帧尖峰 | ~80 行 | 中 | §10 |
| P1-1 增量 delta | 单轮传输本来就只有 65 KB，**收益远小于 v1 估计** | 跨端契约 | 中高 | §11.4 |
| P2-1 checkpoint | 消除每 15 s ≈25 ms 阻塞（Node 实测） | ~50 行 | 低 | §4.3 |
| P2-2 REST 分页 | 挂载 5.8–9.2 s → 预估 ~1 s 量级 | ~120 行 | 中 | §9.4 + 外推 |

**落地顺序（v2）**：

1. **P0-2 + adapter 引用缓存**（按 `docs/perf-p0-2-conversation-patch-contract.md` 的规范实现）：去掉每帧 37–74 ms 的深拷贝与 GC。
2. **P0-3 虚拟化**（先做单层 turn 虚拟化原型，在真实 Chrome 按 §12 验收）：解决挂载 1.8–9.2 s 与单帧 O(entries)。
3. **P1-2 守卫**（"merged 与当前 entries 等价则不发帧" + debug 打点）：成本极低，消除低频尖峰。
4. **P2-2 REST 分页/preview**：可与 P0-3 并行，作为长会话挂载的止血。
5. 按需：P0-1（突发合帧）、P1-1、P2-1。

> 若需要**当天见效的兜底止血**：把 `TRUNCATE_ENTRIES`（`session-log-store.ts:17`）的裁剪从"仅终态会话卸载时"扩展到**运行中会话也保留最近 N 条**（建议 800–1000），
> 5 行改动即可把 O(全部历史) 变成 O(N)，代价是滚动到很靠上的历史时需要重新拉取（复用 `isTruncated` + REST 快照即可）。
> v2 实测支持这个做法：@3001 entries 的挂载占 5.8–9.2 s，裁剪到 1000 条可把打开会话的成本压回 1000 条档位。

---

## 8. 不确定项与未验证部分（v2）

1. **Happy-dom 数字已废弃**：§4.4 的绝对毫秒数不再作为结论依据，只保留其"排序假设"的历史价值；浏览器结论一律以 §9 为准。
2. ~~真实 dsh 的分片粒度~~ **已测**（§11）：一条消息一帧，不是 1 token 一帧。**仍未测**：其它 ACP agent（Codex ACP / pi-acp / claude-code ACP）与 CLI parser 的分片粒度——它们可能真的按 token 流式；若如此，P0-1 的优先级需要按 agent 分别判断，建议用同一打点口径分别测量。
3. **`resumeMode='load'` 频率**：已给出结构量化与高危人口统计（§10.2），但**精确线上频率仍未实测**——本轮只加了 debug-gated 打点（§10.4），需要开启开关跑一段时间才能得到确切值。
4. **仍未测**：`useStickToBottom` 的强制 layout 成本、`AgentSessionPanel` 上层兄弟组件重渲染、`add /entries/N`（新增条目）路径的样式/布局成本（§9 只测了 `replace .../content`，增量插入可能让 Layout 略高）。
5. **仍未测**：移动端（`MobileTaskDetail.tsx` 也用了 `LogStream`）在长会话下的表现，预期同样受根因 1/2 影响。
6. **测量环境**：§9 的 Chrome 是 `--headless=new`（SwiftShader 软件光栅 + focus 模拟）。样式/布局/绘制与真实窗口同引擎，但 GPU 光栅化路径不同；如需签字级验收，请在真实窗口按 §12 口径复测一次。

---

## 9. 真实浏览器交叉验证（阻断项 1）

### 9.1 方法

> **v3 标注**：本节（§9）全部数字来自 **v2 的合成 fixture（3.27 KB/entry）**，绝对成本偏低（store 类约 2.6×，
> 见 §14.2 的真实缩放表）。相对排序与归因仍然有效；真实数据实测见 §14。

审查指出：§4.4 的 happy-dom 没有真实 layout/style/paint，`<Profiler>` 也不含浏览器合成与绘制，所以「C 渲染 > B 深拷贝 > D markdown」只是**组件提交工作的排序**。

交叉验证采用审查给出的**退路方案**（最小 harness + 真实 Chrome），因为真实 dsh 流无法在 profiling 窗口内稳定复现——§11 实测证明它根本不是"每 token 一帧"的高频流：

- **真实组件 + 真实 store + 真实 adapter**：`packages/web/src/stores/session-log-store.ts`、`packages/shared/src/log-adapter.ts`、`packages/web/src/components/agent/LogStream.tsx`，用 esbuild 打包进单文件，在 **Chrome 152 / Blink**（非 happy-dom）里挂载。
- **真实 DOM 结构与样式**：容器结构与 `AgentSessionPanel.tsx:233-260` 一致，样式使用 `packages/web/dist` 的**生产构建 CSS**（vite build）。
- **生产 React**：`platform=browser` + `process.env.NODE_ENV=production`，与线上构建一致。
- **视口/帧率**：1400×900，deviceScaleFactor=1；空载 rAF 实测 **p50 = 16.70 ms / p95 = 50 ms**（99 帧/2 s），确认 60 Hz 帧管线正常。
- **关键环境修正**：headless 下 `document.visibilityState === 'hidden'`（macOS 原生窗口遮挡计算），会让 `requestAnimationFrame` 完全停止 → 必须加
  `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding` + `Emulation.setFocusEmulationEnabled`，
  否则测出的"卡顿"全是假象。这一条对后续用 Chrome 做验收的人是必须知道的坑。
- **提交完成判定**：生产构建里 `<Profiler>` 不产出数据（React 只在 `react-dom/profiling` 构建里统计），改用 **MutationObserver**：patch 后等到容器连续 3 帧无 DOM 变更，记为"已提交/已稳定"。
- **成本口径**：
  - `sync` = `store.applyPatch()` 的同步阻塞时间（含深拷贝 + 它触发的 GC）；
  - `settle` = 之后到 DOM 稳定的时间（React 渲染 + 提交 + 样式 + 布局 + 绘制 + 帧调度）；
  - 驱动侧用 `Performance.getMetrics` 的 `ScriptDuration / RecalcStyleDuration / LayoutDuration / TaskDuration` 差值，
    以及 `longtask` / `long-animation-frame` PerformanceObserver、rAF 间隔分布；
  - 收尾用 CDP `Tracing`（devtools.timeline + v8.execute + frame 分类）做 JS / Style / Layout / Paint / DroppedFrame 的自时间分解。
- **规模**：1000 / 3000 entries（fixture ~3.27 KB/entry，与 §4 同一套 fixture，便于与 happy-dom 对照），
  每个配置 **重复 3 次**（重复之间不重载页面，避免冷启动差异；配置切换时重载页面）。
- 脚本（scratch，gitignored）：`node_modules/.at-perf/chrome/{harness.tsx,drive.mjs}`；原始结果 `/tmp/at-chrome-results.json`；trace `/tmp/at-chrome-traces/`。

### 9.2 单 patch 成本（隔离模式：一个 patch 占一个可测帧，3 次重复的中位数）

| 配置 | DOM 节点 | `sync`（store，含 GC） | `settle`（React+样式+布局+绘制+帧） | 单 patch 总阻塞 | `ScriptDuration`/patch | Style/patch | Layout/patch |
|---|---|---|---|---|---|---|---|
| 1001 tool/full | 4789 | **37.4 ms** | **79.8 ms** | **117.4 ms** | 49.0 ms | 0.62 ms | 0.23 ms |
| 1001 mdcode/full | 4789 | 42.7 ms | 154.4 ms | 237.5 ms | 129.7 ms | 10.3 ms | 0.92 ms |
| 1001 mdcode/store（无 LogStream） | 1 | 32.0 ms | 33.9 ms | 66.4 ms | 1.9 ms | 1.4 ms | 0 ms |
| 1001 mdcode/raw（无 adapter + 无渲染） | 1 | 31.8 ms | 36.3 ms | 70.6 ms | **1.4 ms** | 0.56 ms | 0 ms |
| 3001 tool/full | 14369 | **73.5 ms** | **139.1 ms** | **220.8 ms** | 100.8 ms | 0.6 ms | 0.32 ms |
| 3001 mdcode/full | 14369 | 135.5 ms | 209.7 ms | 362.0 ms | 137.1 ms | 1.99 ms | 1.52 ms |
| 3001 mdcode/store | 1 | 112.8 ms | 37.7 ms | 150.7 ms | 4.5 ms | 0.93 ms | 0 ms |
| 3001 mdcode/raw | 1 | **98.6 ms** | 35.6 ms | 135.6 ms | **0.8 ms** | 0.61 ms | 0 ms |

（`mdcode` = 流式 assistant 消息逐帧追加 markdown + 代码块；`tool` = 只改一条 tool entry 的 content，markdown 完全不变 → 用来分离 D。）

**关键读数**：

- **B（深拷贝）在真实浏览器里比 happy-dom 显示的贵 3–6 倍，而且几乎全部不是 JS**：
  `raw`/`store` 对照里 `sync` 是 32→99 ms，而 `ScriptDuration` 只有 1.4→0.8 ms；
  1000 条文档 3.19 MB、3000 条 9.58 MB，`JSON.stringify` 单独就要 17.6 / 48.2 ms（`JSON.parse` 2.7 / 10.4 ms）。
- 把 React 完全摘掉（`raw`，不挂载任何 React root；`probeCloneOnly` 对照）后，单进程 25 次 patch 的实测吞吐是
  **17.1 patch/s @1001 / 4.4 patch/s @3001**，`TaskDuration` 1.65 s / 6.04 s —— 主线程几乎全程占用，`LayoutDuration = 0`。
  即：**只做"每 patch 全量深拷贝"这一件事，就足以让 3000 条的会话掉到 4 patch/s 的处理能力**。
- `settle` 随规模增长：79.8 → 139.1 ms（tool），说明 React 侧仍是 O(entries)（与 v1 结论一致）。
- **D（markdown）在真实浏览器里被 v1 显著低估**：同一棵树、同一规模，`mdcode` 比 `tool` 多 47 ms @1001（117→238 ms）——因为 Streamdown 的真实解析/高亮/树构建在 happy-dom 里大部分没跑。

### 9.3 浏览器管线分解（CDP Trace 主线程自时间，10 s 持续压测窗口）

| trace | 场景 | JS | Style | Layout | Paint | DroppedFrame | BeginFrame |
|---|---|---|---|---|---|---|---|
| `trace-1000` | 1000 entries / full | **8982 ms** | 62 ms | 151 ms | 137 ms | **54** | 641 |
| `trace-3000` | 3000 entries / full | **8770 ms** | 42 ms | 291 ms | 174 ms | **57** | 651 |
| `trace-3000-storeonly` | 3000 entries / 纯 store（无渲染） | **8396 ms**（其中 `RunMicrotasks` 7912 ms、`FunctionCall` 仅 475 ms） | 42 ms | **0.7 ms** | 18 ms | 14 | 645 |

- **Recalculate Style / Layout / Paint 合计只占窗口的 1–5%**：审查怀疑的"14k 节点让 C 更重（Recalculate Style/Layout/Paint）"在真实引擎里**没有发生**——
  Blink 对"只改一个文本节点"的样式/布局是增量的，单 patch 1–5 ms。
- 真正的开销在 JS/微任务侧；纯 store 对照里 `FunctionCall` 只有 475 ms、`RunMicrotasks` 却有 7912 ms，
  且 `V8.GC_*`（Scavenger / 增量标记）大量出现 —— 与"深拷贝每帧分配 3–10 MB → GC 风暴"一致。
- `TaskDuration` 在 10 s 窗口里都是 **10.0–10.9 s**（主线程 100% 占用），丢帧是必然结果：1000 条 10 s 内丢 107–121 帧，3000 条几乎全丢。

**持续压测（400 patch/s 注入、10 s、3 次重复）**：

| 配置 | 实际吸收 | 吸收率 | 帧 p50 / p95 / max | 丢帧 | Long Task 总时长 | LoAF blocking |
|---|---|---|---|---|---|---|
| 1000 entries / full | 102–126 帧（10–13 帧/s） | **3%** | 50–67 / 167–217 / 450–483 ms | 107–121 / 125–155 | 6.5–7.5 s | 3.7–4.3 s |
| 3000 entries / full | 36–46 帧（3.5–4.5 帧/s） | **1%** | 133–217 / 367–417 / 417–567 ms | 43–49 / 50–75 | 9.5–10.1 s | 6.9–7.5 s |
| 3000 entries / 纯 store | 92 帧（9.1 帧/s） | 2% | 83 / 183 / 367 ms | 92 / 122 | 9.4 s | 5.4 s |
| 3000 entries / raw | 96 帧（9.6 帧/s） | 2% | 67 / 233 / 283 ms | 97 / 124 | 8.9 s | 5.3 s |

（这个 400 patch/s 是**压力上限测试**，不是 dsh 的真实频率——真实频率见 §11。它证明了"每帧 O(全部会话)"的实现连 10 帧/s 都吃不下。）

### 9.4 长会话挂载（打开面板 / 切换任务）

| entries | DOM 节点 | 挂载阻塞（3 次范围） | JS | Style | Layout | Task |
|---|---|---|---|---|---|---|
| 1001 full | 4789 | **1.76–4.76 s** | 2.83 s | 223 ms | 485 ms | 3.83 s |
| 3001 full | 14369 | **5.81–9.18 s** | 5.31 s | 299 ms | 1.21 s | 6.92 s |
| 1001 store（只跑 adapter） | 1 | 40–55 ms | 1 ms | 0.6 ms | 0.2 ms | 44 ms |
| 3001 store（只跑 adapter） | 1 | 46–120 ms | 9 ms | 3 ms | 0.7 ms | 317 ms |

- adapter 本身很便宜（`probeAdapter`：1000 / 3000 / 5000 entries = **0.5–15 ms**，与 §4.2 的 0.2–0.4 ms 同量级）；
  挂载成本几乎全部来自**渲染整棵树 + 真实样式/布局**（3001 条要建 14369 个节点、1.2 s Layout）。
- 这条对用户体感最重要：**"会话内容多了之后打开就卡好几秒"**在这里被量化，而 v1 只有 happy-dom 的 946 ms。
- 线上真实快照更重（≈9.8 KB/entry vs fixture 3.27 KB/entry），1461 entries 的会话挂载比上表 1001 档更差。

### 9.5 结论：真实浏览器里排序是否改变？

**排序方向不变，但权重和机制变了**（对审查问题的直接回答）：

| 分量 | happy-dom（v1） | **真实 Chrome（v2）** | 变化 |
|---|---|---|---|
| B 深拷贝（store） | 4.1 → 16.4 ms | **37 → 74 ms**（tool 档；md 档 43 → 136 ms） | 贵 3–8×，且 **95% 不是 JS 而是分配/GC** |
| C 整树渲染（settle 减去 store 对照） | 9.3 → 35.4 ms（Profiler commit） | **~46 → ~101 ms**（79.8−33.9 / 139.1−37.7） | 贵 3–5×；机制是 React 工作 + 帧调度，**不是排版绘制**（后者 1–5 ms） |
| D markdown | 3.3–6.6 ms（小会话） | **+47 ms @1001**（117→238 ms，tool → mdcode） | 明显更大，与"Streamdown 在 happy-dom 里没真跑"一致 |
| **B : C 比值** | ~0.44 : 1 | **~0.79 : 1**（1001）/ **0.53 : 1**（3001） | 差距从 ~2.2× 缩到 **~1.2–1.9×** |

**结论**：

1. `C ≥ B > D` 的排序**仍然成立**（C 依然最大）；
2. 但 B 不再是"顺手就能拿掉的便宜项"，它与 C 同量级，且是**唯一能靠一次小改动（结构化共享）直接归零**的分量；
3. 审查猜测的"真实 Chrome 让 C 因为 14k 节点排版绘制变得更重"**不成立**；
4. 审查猜测的"真实 Chrome 会暴露 D 未计入的成本"**成立**（markdown 相对成本翻了几倍）；
5. 由此 **P0-2 的相对收益比 v1 估计更高**（一次消掉 1/3–1/2 的单帧阻塞），P0-1 的收益因真实频率过低而大幅缩水（§11）。

---

## 10. `session/load` 触发条件链与频率量化（阻断项 2）

### 10.1 精确触发条件链（含代码位置）

`replace /entries` 只在 `AcpDriverSession.reconcileLoadedHistory`（`packages/server/src/runtime/acp/acp-driver.ts:665-711`）里产生，
唯一调用入口是 `ensureAgentSession`：

```ts
// acp-driver.ts:650-654
if (requestedExternalId && resumeMode === 'load') {
  this.reconcileLoadedHistory(turn, sink, matchingUpdates);
} else if (!requestedExternalId) { /* 新会话：正常逐条投影，不回放 */ }
```

因此**五个条件必须同时成立**：

| # | 条件 | 代码位置 | 说明 |
|---|---|---|---|
| 1 | **驱动实例是新的**（`sessionReady === false`） | `acp-driver.ts:576`（`if (this.sessionReady) return;`） | DriverSession 只要还活着（同进程复用），`ensureAgentSession` 直接返回，**永不 load**。新实例只来自：进程重启、`disposeSession`、`abandonTurn` 返回 false、传输 reset |
| 2 | **`resumeMode === 'load'`** | `services/session-manager.ts:759-762` | 仅当 runtime 是 ACP **且** `hasCompletePersistedSnapshot(session) === false` |
| 3 | **会话非终态（或无快照）** | `session-manager.ts:112-121` | `hasCompletePersistedSnapshot` 要求 `status ∈ {COMPLETED, FAILED, CANCELLED}` 且 `logSnapshot` 非空可解析。注意 `handleSessionExit`（`:2533`）在**每个回合结束时**就把状态置为 COMPLETED（ACP 进程仍活着），所以"回合间追问"通常是 `resume`，**不是** `load` |
| 4 | **存在外部 session id** | `session-manager.ts:811-812` → `acp-driver.ts:581` | `session.externalSessionId ?? resolveAgentSessionId(...)`；为空则走 `session/new`。若 agent 不支持 load 且不支持 resume，会抛 `load_unsupported`（`acp-driver.ts:593-595`） |
| 5 | **回放有更新且 reconcile 判定"有变化"** | `acp-driver.ts:671-676`、`history-reconciler.ts:142` | `updates.length === 0` 直接返回；`reconcileAcpHistoryEntries` 返回 `undefined`（无变化）也直接返回，**不发帧** |

**最容易踩中的真实路径**：

- **P-a：进程重启 / 崩在回合中间**。服务端启动时**不会**把遗留 RUNNING 会话改成终态（全仓无此类恢复逻辑），
  所以下次对这条会话发起回合时满足条件 1–4 → `session/load` → 回放 → 若本地快照落后于 agent 历史则 `changed = true` → **整数组 replace**。
- **P-b：回合进行中追问且取消失败**。`sendMessage`（`session-manager.ts:759`）先按**当时**状态算 `resumeMode`（RUNNING → `load`），
  再 `abandonTurn`（`:802`）；若 10 s 内取消失败 ⇒ `disposeSession`（`:804`）⇒ 新 driver ⇒ 条件 1–4 全部成立。
  这是**唯一"用户主动发消息就可能触发"**的路径，也是 v1 说的"发一条消息冻住几秒"的真实版本。

**v1 表述纠正**：v1 说"RUNNING 状态下追加消息就会整数组替换"——只在**取消失败**时成立；
`abandonTurn` 正常返回 true 时 driver 被复用、`sessionReady` 仍为 true，**不会 load**。

### 10.2 频率量化（真实库 + 代码结构）

只读查询用户本机 `~/.agent-tower/data.db`（2026-09-11 快照）：

| 指标 | 数值 | 含义 |
|---|---|---|
| ACP 会话总数 | **955** | 历史累计 |
| 其中 RUNNING | 10 | 当前状态 |
| **`RUNNING` + `externalSessionId` + 非空 `logSnapshot`** | **6**（0.63%） | **"下一次新 driver 回合就会走 load + reconcile"的高危人口**；其中 4 条是 8/5–8/27 遗留的僵尸 RUNNING（进程早已不在），2 条是今天在跑的 TeamRun 会话 |
| 有 ≥2 个回合（`ExecutionProcess` 行数 >1）的 ACP 会话 | **35**（3.7%） | 只有这些会话可能进入 `sendMessage` 路径 |
| 累计"追问回合"数 | **67**（35 条会话，约 6.5 个月） | 追问 ≈ **0.34 次/天**；只有其中"取消失败"的部分会命中 P-b |
| ACP 会话无 `logSnapshot` | 48 | 即使终态也会被判为 `load`（仍需新 driver + 外部 id） |
| 真实最长会话 | 1461 entries / 14.9 MB → replace 帧 **4.66 MB** | 单次触发的最坏帧 |

> 注：`ExecutionProcess` 是**每回合**一行（`claimRuntimeLaunch`，`session-manager.ts:1349`），不是"每个进程实例"一行，
> 所以它用于统计"回合数/追问数"，不能直接当 driver 实例数。driver 实例数无法从库里恢复，只能靠 §10.4 的打点。

**结论（P1-2 的优先级判断）**：

- **频率非零但很低**：结构上界是"每个应用重启周期 × 每条非终态会话一次"，实测高危人口 6 条；
  P-b 由 67 次追问中的取消失败次数决定（正常路径 10 s 内取消成功）。量级判断：**每周几次，而不是每次发消息**。
- **后果很重**：4.66 MB 单帧 → 客户端 `JSON.parse` + §9.2 的全量深拷贝 + §9.4 的全量重渲染 ⇒ **秒级冻结**。
- 因此 **P1-2 的"守卫 + 打点"应与 P0 同批完成**（成本极低：merged 与现有 entries 等价就不发帧，并把频率/字节数写进 debug 日志）；
  **整表 diff 重写留到 P0 之后**。审查建议的"不要用长度阈值静默丢弃"被采纳为硬约束。

### 10.3 为什么没有给出"精确线上频率"

- 服务端**当前没有任何**该路径的日志/计数（`reconcileLoadedHistory` 无日志、无 metrics）；
- 用户正在运行的 server 是全局安装的构建，本轮不能对它热加载新代码；
- 数据库里没有 patch 级历史（只有 `Session.logSnapshot` 快照），也没有 launch → reconcile 的痕迹，
  因此**只能给出结构量化 + 高危人口统计 + 上界**，无法给出精确发生率。

### 10.4 本轮新增的 debug-gated 打点（已披露）

> 这是本轮**唯一**的 `packages/**` 改动：默认关闭、只在日志开关打开时输出、不改变任何行为。

`packages/server/src/runtime/acp/acp-driver.ts`：

- 新增 `const DEBUG_ACP_RECONCILE = process.env.DEBUG_ACP_RECONCILE === 'true'`；
- `reconcileLoadedHistory` 在**原有返回值分支**上各加一条 `console.log`：
  - 有变化：`action=replace-all-entries replayUpdates=… localEntries=… replayedEntries=… mergedEntries=… frameBytes=… seq=…`
  - 无变化：`action=skip(no-change) …`
- 为不引入额外开销，`getSnapshot()` 结果被 hoist 成局部变量复用（**调用次数与改动前完全一致**，不增加重放）。

开启方式：`DEBUG_ACP_RECONCILE=true` 启动 agent-tower。跑一段时间即可得到
「load 次数 / 其中 reconcile 变化次数 / 每次帧字节」的精确分布，把 §10.2 的"每周量级"升级为实测值。

---

## 11. 真实 dsh ACP 分片粒度实测（次要项）

### 11.1 方法

- 用与产品**完全相同**的启动方式：`dsh --profile acp`（`runtime/acp/agents/deepseek-hermes.ts:127-131`），
  `DSH_HOME=<dataDir>/deepseek-harness/8a6f8956`，provider env（`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 取自 `providers.json`），
  `DSH_PERMISSION_MODE=danger-full-access`；
- 通过 ACP SDK（`@agentclientprotocol/sdk@1.4.0`）走真实 JSON-RPC：`initialize → session/new → set_config_option(model, reasoning_effort=max) → session/prompt`；
- 记录每个 `session/update` 通知的**到达时间、类型、文本长度、帧字节**；
- 脚本（scratch）：`node_modules/.at-perf/acp-measure.mjs`；原始数据 `/tmp/at-acp-probe-raw.json`；
- 三轮独立探测：① 900 词技术说明；② 900 词 + 一次 120 KB 输出的 bash 工具调用；③ 15 次 `sleep 0.6` 的长命令（9.2 s）。

### 11.2 实测：dsh **不按 token 流式**

| 轮次 | 提示 | 通知总数 | 分布 |
|---|---|---|---|
| ① | 900 词输出 | **3** | `agent_thought_chunk` ×1（1799 字符）、`agent_message_chunk` ×1（**7163 字符**）、`usage_update` ×1 |
| ② | 900 词 + 工具调用 | **13** | thought ×3（556–6936 字符）、message ×2（305 / 6189 字符）、tool_call ×2、tool_call_update ×2（**单帧 50 238 B**）、usage ×4 |
| ③ | 15 次 sleep 的长命令 | **8** | thought ×1（104 字符）、message ×2（2 / 122 字符）、tool_call ×1、tool_call_update ×1（366 B，**命令结束那一刻才到**）、usage ×3 |

时间分布（第 ② 轮）：

```
t=21215 (+21215) agent_thought_chunk chars=6936
t=21217 (   +2) agent_message_chunk chars=6189
t=21227 (  +10) usage_update
t=23524 (+2297) agent_thought_chunk chars=1303
t=23526 (   +2) tool_call
t=23618 (  +92) tool_call_update bytes=50238
t=25794 (+2176) agent_thought_chunk chars=556
...
```

**结论**：dsh 在 ACP 模式下把一条消息 / 一段思考 / 一次工具结果**攒完再整帧下发**。
`agent_message_chunk` 的粒度 = 整条消息（p50 = 1303、p95 = 6936、max = 6936 字符）；
工具结果即使耗时 9.2 s，也是**结束时一帧 366 B**。实测 **总通知数 / 总时长 = 0.53 帧/s**，
帧间隔要么 2–10 ms（同一批），要么 0.8–2.3 s（步与步之间）。

### 11.3 对"1 token = 1 patch"假设的判定

**不成立**。真实 patch 频率 = **0.5–1 帧/s（突发 2–3 帧挤在 ~10 ms）**，比 v1 假设的 300–400 帧/s 低 **2–3 个数量级**。
这直接推翻了 v1 的 CPU 预算算法（"400 patch/s × 52 ms = 20.7 CPU·s/s"），也是 P0-1 合帧降级的依据。

⚠️ 适用范围：本轮只测了 **dsh**。其它 ACP agent（Codex ACP / pi-acp / claude-code ACP）与 CLI parser 可能真的按 token 逐帧；
建议用同一打点口径分别测量后再决定 P0-1 是否需要。

### 11.4 传输量重算

| 量 | v1 假设（1 token/帧） | **v2 实测** |
|---|---|---|
| 单条 2000 token 消息的 patch 数 | 2000 | **1–3** |
| 单条消息累计传输 | 8.07 MB | **~15 KB**（7163 字符 + 帧头） |
| 整轮（2 轮对话 / 24.7 s / 含工具调用） | — | **13 帧 / 65 KB**（其中工具结果单帧 50 KB） |
| 每秒字节 | ~1.3 MB/s | **~2.6 KB/s** |

→ **传输与 JSON 解析不是瓶颈**（P1-1 的收益随之大幅缩水）；真正的成本是"每帧都要把整个会话重算一遍"。

---

## 12. Chrome 验收口径（采纳审查建议）

后续 P0-1 / P0-2 / P0-3 / P1-2 的验收统一用以下口径（真实 Chrome、生产构建、真实 dsh 会话或等价的真实 patch 序列）。

**性能门槛（可见会话）**

| 指标 | 门槛 |
|---|---|
| 平均帧间隔 | ≤ 16.7 ms |
| p95 帧间隔 | ≤ 33 ms |
| Long Task（>50 ms）占比 | < 1% |
| 滚动 / 输入 | 无 >50 ms 的输入响应延迟 |
| 单 patch 主线程阻塞（长会话 3000 entries） | 目标 ≤ 33 ms（现状 221 ms） |

**功能场景（P0-3 虚拟化必须逐项覆盖）**

1. 底部持续输出时自动跟随；
2. 用户上滚后继续输出**不强制抢焦点**；
3. 动态 markdown / 详情展开折叠后高度重测；
4. `scrollToBottom` / 跳转命令式句柄；
5. 卸载后重新挂载（重新打开面板）；
6. 滚动锚点误差 **< 1 个可见行**，展开内容不被截断。

**P0-1（若仍实施）**：flush 次数约为原 patch 数的 1/4–1/8（按实测 patch/s 重新计算）；seq 无重复/缺口误判；注入乱序 / 重复 / 跨 snapshot 竞态均触发预期 reload。

**P0-2**：见 `docs/perf-p0-2-conversation-patch-contract.md` §5（与 fast-json-patch 的差分等价 + property-based + 引用稳定性断言）。

**P1-2**：真实触发一次 `session/load` reconcile，验证"merged 与现有 entries 等价时不发帧"；记录 replace 频率、帧字节、客户端 reload 次数；发消息期间不得出现秒级冻结。

**测量注意（§9.1 的坑）**：headless Chrome 默认 `document.visibilityState === 'hidden'`，`requestAnimationFrame` 会被冻结；
必须显式处理遮挡/焦点，或使用真实窗口；另外生产构建下 `<Profiler>` 不产出数据，完成判定要用 MutationObserver 或 trace 的 commit 事件。

---

---

## 13. P0-3 实施与实测结果（2026-09-11，实施后回填）

> **v3 标注（重要）**：§13.2–§13.4 的绝对数字来自**旧合成 fixture（3.27 KB/entry）**，因此 1000/3000 档的
> **store 成本被低估约 2.6×**，"1000 档基本达标"的判定在真实尺寸下**不成立**（§0.3、§14.2）。
> §13.5 的交互场景回归结论（0 px 漂移、不抢焦点）不受数据体积影响，仍然有效。

> 本节由 P0-3 实施者按 §12 口径回填，用来替换 §6 / §7 中 P0-3 的**外推**数字。
> 环境与 §9.1 一致（真实 Chrome 152 / Blink、生产 React 构建 + `packages/web/dist` 生产 CSS、
> 1400×900、`--disable-features=CalculateNativeWinOcclusion` 等遮挡修正、`visibilityState === 'visible'`）。
> 改造前后使用**同一份 harness**，只替换 `LogStream.tsx`（`9a9f69fa` → 改造后），
> 并额外接入真实 `use-stick-to-bottom`（容器结构与 `AgentSessionPanel.tsx` 一致）。
> `dsh` 场景按 §11 的实测节奏回放（一次通知 1–3 帧、帧间隔 0.8–2.3 s，实测 0.9–1.9 帧/s），10 s 窗口 × 3 次 × 2 轮。

### 13.1 最终形态：单层扁平虚拟化（不做嵌套）

- 把 `splitConversationTurns` 的结果摊平成一维 row：用户消息 / `已处理` 摘要 / 终态回复项 / **展开后的历史明细项**；
- 折叠的历史明细**根本不挂载**（不是 `grid-rows-[0fr]` 隐藏），所以一个折叠 turn 恒定只占 2 行；
- 明细展开后成为**顶层 row**，仍然只挂载视口 + overscan 行 → **展开态同样是 O(视口)**；
- 因此第二阶段（嵌套 item 级虚拟化）**没有必要**：那会引入内层 `scrollMargin` 与外层测量的互相反馈，
  却不会进一步减少 DOM（实测展开/折叠两种状态都是 90 个节点、14 行）。
- 行高用 `measureElement`（`getBoundingClientRect().height`，保留小数）动态测量；`getItemKey` 使用稳定 row key；
- 展开/折叠不再做高度动画（沿用 §6 的建议），只保留箭头旋转；`useStickToBottom` / `scrollToBottom` 语义不变；
- 滚动锚定策略改为"只有**本次 resize 后仍完整结束于视口上方**的行才补偿高度变化"：判定用
  `item.end + delta <= scrollOffset + scrollAdjustments`（`item.end` 是 resize 前的缓存值，`delta` 是本次尺寸变化，
  等号归上方）。跨越视口且 resize 后仍有可见像素的行（长流式消息、展开的思考块）不补偿，
  按默认策略补偿会把读者拖进新增文本。判定契约与回归测试见 §14.6。

### 13.2 挂载（打开/切换会话）

| entries | 改造前 mount | 改造后 mount | DOM 节点 |
|---|---|---|---|
| 1000 | 956–1560 ms（中位 1245） | **143–245 ms（中位 166）** | 4793 → **90** |
| 3000 | 2443–5467 ms（中位 2595） | **188–716 ms（中位 210）** | 14373 → **90** |
| 1000 store-only 对照（不挂载 LogStream） | 54–63 ms | 51–65 ms | 5 |

挂载从**秒级降到百毫秒级**，且 3000 与 1000 基本持平（O(视口) 已成立）；3000 档的 716 ms 是 GC 抖动离群值，另两轮为 188 / 215 ms。

### 13.3 单次更新（隔离模式：一个 patch 占一个可测帧，3 轮）

`tool` patch（只改一条 tool 内容、markdown 不变 —— 用于分离"整树重渲染"）：

| entries | store（未改动，属 P0-2） | settle（React+样式+布局+绘制） | 单 patch 合计 | Script/patch |
|---|---|---|---|---|
| 1000 | 9.1–13.3 → 8.2–10.2 | 42.6–58.9 → **39.1–41.6** | 52.8–72.1 → **49.3–49.9** | 142–305 → **24–30** |
| 3000 | 41.1–167.1 → 23.7–29.0 | 66.9–139.9 → **30.6–33.1** | 108.0–307.1 → **56.2–60.9** | 406–897 → **45–54** |

`mdcode` patch（末条消息持续变长的流式 markdown）：

| entries | settle 前 → 后 | 合计 前 → 后 |
|---|---|---|
| 1000 | 74.6–104.4 → 81.6–88.0 | 89.4–117.5 → 93.1–99.6 |
| 3000 | 97.4–109.2 → 87.3–122.1（另有一轮 GC 离群 186.9） | 150.4–161.3 → 126.4–177.3 |

- `tool` 路径（纯渲染侧）已被压到与 store 深拷贝同量级；`mdcode` 路径仍由 **Streamdown 重解析末条消息**主导（§4.4 根因 3）：
  虚拟化不能减少"那一条可见消息"的 markdown 成本，需要单独优化（不在 P0-3 范围）。
- **store 列前后未变**（同一份 `session-log-store.ts`）——它现在是新的成本地板。

### 13.4 真实 dsh 节奏窗口（验收口径）

10 s 窗口；`after` 为两轮独立运行共 6 个窗口：

| 配置 | frame avg | frame p95 | 掉帧 | Long Task 占比 |
|---|---|---|---|---|
| 1000 full 前 | 16.99–20.27 | 16.7–33.3 | 7–31 / 513–611 | 0.00–12.64% |
| **1000 full 后** | **16.67–18.12** | **16.7–16.8** | **0–12 / 573–623** | **0.00–5.38%** |
| 3000 full 前 | 18.89–20.81 | 16.8–33.3 | 22–30 / 499–546 | 9.75–19.66% |
| **3000 full 后** | **17.13–19.92** | **16.8** | **9–25 / 532–605** | **3.32–11.91%** |
| 3000 store-only 后（**不挂载 LogStream 的地板**） | 16.80–17.08 | 16.8 | 4–12 / 608–618 | 0.00–3.33% |

主线程自时间（`Performance.getMetrics` 差值 / 10 s 窗口）：

| 配置 | JS | Recalculate Style | Layout |
|---|---|---|---|
| 3000 full 前 | 1245–1723 ms | 60–78 ms | 19–35 ms |
| 3000 full 后 | **156–439 ms** | 48–101 ms | 9–21 ms |
| 3000 store-only 后 | 25–59 ms | 27–80 ms | 0 ms |

CDP trace（`tracefull`，含 tracing 自身开销，仅用于阶段拆分）：3000 档 **Paint 232 ms → 32–58 ms**；1000 档 Paint 101 ms → 12–63 ms。

**达标判定（§12 门槛）**：

> 下表是**旧 fixture（3.27 KB/entry）**下的判定。用**真实尺寸**数据复测时，1000 档同样不达标
> （单 patch store 中位 60.3 ms、地板 avg 18.95 / Long Task 13.69%）——结论见 §0.3、§14.2。

| 门槛 | 1000 entries | 3000 entries |
|---|---|---|
| avg frame ≤16.7 ms | 🟡 16.67–18.12（多数窗口贴线；离群由 store GC 尖峰造成） | ❌ 17.13–19.92 |
| p95 ≤33 ms | ✅ 16.7–16.8 | ✅ 16.8 |
| Long Task（>50 ms）<1% | 🟡 0.00–5.38% | ❌ 3.32–11.91% |
| 无持续 backlog | ✅ 尾部 p95 16.7–16.8 | ✅ 尾部 p95 16.7–16.8 |
| 挂载：秒级 → 百毫秒级 | ✅ 1245 → 166 ms | ✅ 2595 → 210 ms |
| 锚点误差 < 1 个可见行 | ✅ 0 px | ✅ 0 px |

**3000 档未达标的归因**：同一节奏下**完全不挂载 LogStream** 的 store-only 地板也只有 avg 16.80–17.08 ms、Long Task 0.00–3.33%。
单窗口 store 同步阻塞 38.7–55.5 ms（偶发 GC 尖峰到 537 ms），即缺口来自 §4.1 的全文档深拷贝 —— **P0-2 范围，本任务明确未碰**，不是渲染。
**该归因已在真实数据上独立复现**（3000 档：full 18.74/18.47 vs store-only 18.37/18.88，Long Task 10.98–13.74%，见 §14.2）。

### 13.5 交互场景回归（真实 Chrome）

| 场景 | 结果 |
|---|---|
| 底部持续输出自动跟随 | 收敛后距底 1 px、`isAtBottom=true`，窗口内 frame p95 16.7–16.8 ms |
| 用户上滚后继续输出 | scrollTop 完全不变、锚点误差 **0 px**、未被抢焦点 |
| 详情展开/折叠（高度变化） | 展开 14→15 行、展开与折叠锚点误差均 **0 px**、行铺排无重叠无空隙 |
| 流式 markdown 增长 | 距底 1 px、行高单调增长、无截断 |
| `scrollToBottom`（库 API） | 从顶部跳到底部、距底 1 px |
| 卸载后重新挂载 | 90 节点、挂载 135–389 ms、落底 |
| 高视口内的长流式行继续增长 | scrollTop 漂移 **0 px**、锚点误差 **0 px** |
| 渲染管线无残留 backlog | 静默尾部 p95 16.7–16.8 ms |

### 13.6 已知行为变化与残留风险

1. **折叠的历史明细不再存在于 DOM**：浏览器页内查找（Cmd+F）不再命中折叠内容；`data-processed-content` 语义从"折叠容器"变为"展开后的明细行"。
2. **展开/折叠不再有高度动画**（箭头旋转保留）。
3. **行间距略有变化**：row 改为绝对定位后每个 row 自成一个 BFC，相邻 row 的 margin 不再合并，相邻组件间距增加约 4–8 px。
4. **隐藏面板（`clientHeight === 0`）会退化为非虚拟化全量渲染**：与改造前行为一致、不会白屏。
   v3 修复轮补上了对滚动容器的 `ResizeObserver` 尺寸感知：重新可见时会重新测量并回到虚拟化（§14.4）。
5. **单条超长消息自身的 markdown 成本仍在**（6000–9000 字符的消息可渲染出数千像素高）：虚拟化解决"行数"，不解决"单行内容"。
6. **门槛仍需 P0-2**：旧 fixture 下 3000 档不达标；**真实尺寸下 1000 档就不达标**（§0.3、§14.2）。
7. **移动端未单独验收**：`MobileTaskDetail` 复用同一组件并已接入 `scrollElementRef`，本轮未做移动端设备仿真。

---

## 14. v3 回填：真实数据实测 + P0-3 修复轮（2026-09-11）

> **本节数字除 §14.3 明确标注外，全部来自真实会话快照**（本机 `~/.agent-tower/data.db` 的 `Session.logSnapshot`
> 只读导出：最大的两个会话拼接，与独立复测使用的同一份数据）。浏览器口径与 §9.1 一致
> （真实 Chrome 152、生产构建 + 生产 CSS、1400×900、`visibilityState === 'visible'`、遮挡修正）。

### 14.1 真实数据基线（本次回填的参照）

| 项 | 数值 |
|---|---|
| 参照会话 | `4527a14c…`（ACP, 1461 entries, 14.64 MiB）+ `78eaeba4…`（CLI, 1777 entries, 13.46 MiB） |
| 合计 | **3238 entries / 28.10 MiB → 8.89 KB/entry**；前 3000 条 = **24.9 MiB**（复测按此前缀切片） |
| 每-entry 分位 | p10 0.19 / p25 0.30 / p50 4.02 / p75 11.07 / p90 19.82 / p99 65.93 KB |
| 类型占比 | tool_use 78.0% / thinking 15.7% / assistant_message 5.6% / token_usage 0.3% / user 0.2% / error 0.1% |
| tool_use 内部 | content ≈ 67% 字节、metadata ≈ 33% 字节（metadata 以 `toolOutputSummary` 为主） |
| 交叉核对 | 按字节最大的 12 个会话：11512 entries / 77.68 MiB → 6.91 KB/entry；单会话区间 **4.09–11.96 KB/entry** |

### 14.2 真实数据的 store 地板（P0-2 的直接依据）

**单 patch 隔离测量**（每个尺寸重新加载页面，避免 GC 污染）：

| entries | 文档字节 | store 单 patch 中位 | mean | min–max |
|---|---|---|---|---|
| 500 | 3.4 MB | 17.3 ms | 19.2 | 14.4–28.0 |
| **1000** | **6.9 MB** | **60.3 ms** | 56.4 | 33.9–71.2 |
| 2000 | 15.5 MB | 104.8 ms | 107.0 | 78.9–142.9 |
| 3000 | 24.9 MB | 122.3 ms | 129.6 | 108.2–173.1 |

成本随**文档字节**单调增长（正是 `applyPatch(..., mutateDocument=false)` 全文档深拷贝的特征），
而 adapter 派生只有 0.3–0.9 ms/patch。→ **真实尺寸下 1000 档单次 patch 就已经 60 ms。**

**10 s 窗口 / 真实 dsh 节奏回放**（一次通知 1–3 帧、间隔 0.8–2.3 s；每配置 2 轮）：

| 3000 entries（24.9 MB） | avg frame | Long Task 占比 | store 累计阻塞 | 单 patch store 均值 |
|---|---|---|---|---|
| full（挂 LogStream） | 18.74 / 18.47 | 13.06% / 11.50% | 1294.8 / 1144.9 ms | 117.7 / 104.1 ms |
| **store-only（不挂 LogStream）** | **18.37 / 18.88** | **10.98% / 13.74%** | 1099.9 / 1376.5 ms | 110.0 / 105.9 ms |
| store + adapter 派生（不挂 LogStream） | 18.27 / 18.50 | 10.30% / 11.57% | 1027.3 / 1156.2 ms | 102.7 / 96.4 ms |
| 门槛（§12） | ≤16.7 ❌ | <1% ❌ | | |

- **地板全面超门槛，且 full ≈ 地板**（Long Task 差 0–2pp，第二轮 store-only 反而高于 full）
  → 3000 档未达标**归因于 store 深拷贝，不是虚拟化**，与 §13.4 的归因一致（真实数据下独立复现）；
- 1000 档：单 patch store 中位 **60.3 ms**、10 s 窗口 store-only 地板 avg **18.95**、Long Task **13.69%**
  → **真实长会话下 1000 档就已需要 P0-2**（v2 的"1000 档基本达标"作废，见 §0.3）。

**挂载（P0-3 改造后，真实数据）**：

| entries | 挂载 commitMs（3 轮） | 视口内行数 | LogStream 子树 DOM 节点 |
|---|---|---|---|
| 500 | 24.0 / 33.9 / 38.3 | 24 | 175 |
| 1000 | 27.5 / 27.8 / 53.3 | 22 | 164 |
| 2000 | 29.1 / 38.8 / 43.3 | 21 | 167 |
| 3000 | 66.4 / 75.1 / 114.9 | 24 | 180 |

挂载耗时与 DOM 节点数**不随 N 增长 → O(视口) 独立复现成功**。与 §13.2 的 90 节点差异来自数据/行结构
（真实数据的 tool/thinking 占比更高，视口内挂载 21–24 行而不是 14 行），不是矛盾。

### 14.3 校准后的合成 fixture（Node 实测，非真实数据）

标定过程与依据见 §1.1；下表是 `calibrate-fixture.ts` 的输出：

| 规模 | 文档大小 | KB/entry | p50 | p90 | p99 | 单 patch store 中位（Node） |
|---|---|---|---|---|---|---|
| 1000 | 9.00 MiB | 9.22 | 3.83 KB | 22.20 KB | 67.04 KB | 19.8 ms |
| 3000 | 26.41 MiB | 9.01 | 3.44 KB | 20.86 KB | 66.54 KB | 69.7 ms |
| 真实参照 | 3000 条切片 24.9 MiB | 8.89 | 4.02 KB | 19.82 KB | 65.93 KB | 122.3 ms（Chrome） |

- 体积与分位数已对齐（均值差 <1%，p50/p90/p99 差 <15%）；**3000 档 26.4 MiB 略高于真实 24.9 MiB**，即不低估。
- Node 与 Chrome 的 store 绝对值不可直接比较（不同引擎/进程），上表最后一行仅作量级参照；跨版本比较必须同引擎。
- 真实会话的**前缀切片**比整体略轻（前 1000 条 = 7.1 MiB vs 整体 8.89 KB/entry），
  而 fixture 在任意 N 上都按整体分布生成（1000 档 9.0 MiB），属于**偏保守**的标定。

### 14.4 P0-3 修复轮（v3）改了什么

| 项 | 改动 | 验证 |
|---|---|---|
| ① row key 跨 `active → complete` 不稳定 | `LogStream.tsx` 的 item row 改为状态无关的 `item:<key>`（原先运行态 `inline:`、结束态 `final:`/`processed:`）。同一日志在运行态→终态保持同一 row key，React 复用同一 DOM 节点、virtualizer 保留已测高度与行内展开状态。 | 新增 vitest：同一 turn 从 active 切到 complete 后，行的 DOM 节点**同一实例**、已测高度保留（总高 560px 而不是回落到估算的 112px）、`scrollTop` 不变；在修复前该用例失败。 |
| ② `clientHeight === 0` 退化路径 | 组件用 `ResizeObserver` 观察滚动容器，把 `clientHeight` 记入 state；隐藏→重新可见时会重新测量并回到虚拟化（不再依赖库内部 rect 观察的副作用）。 | 新增 vitest（可控 ResizeObserver）：视口 0 → 全量退化渲染，恢复 800 → 重新回到视口窗口化；在修复前该用例失败。 |
| ③ fixture 体积标定 + 真实数据回填 | fixture 从 3.27 → **9.0 KB/entry**（§1.1、§14.3）；本文回填真实数据并标注来源（§0.3）。 | `calibrate-fixture.ts` 输出与 §14.1 的真实分位数对齐。 |

**锚定判定策略**在 §14.6（v4）中按契约修正并补齐可回归测试；§14.4 的"未改动"状态已被该轮取代。

### 14.5 独立复测补充证据与未覆盖项

**锚定策略受控 A/B（真实 Chrome，钉住 `dd57d39e`；变体只删掉那一行策略赋值）**：

| 对抗场景 | 自定义策略 | 库默认 |
|---|---|---|
| F1 跨视口长行增长（行高 3428px > 视口 751px，每 patch +24px） | scrollTop 漂移 **0** | 漂移 **96px**（+24px/patch，读者被拖进新增文本） |
| F2 同一跨视口行收缩 ~2500px（人为边界） | **0** | **−2328px** |
| F3 一次 commit 多行同时改高（视口上方合计 +352px） | +352，可见行位移 0 | 完全相同 |
| F4 快速连续追加（10 个 patch，阻塞 392/261 ms） | 锚点位移 0 | 锚点位移 0 |

> 本表是**修正前**（旧谓词、`dd57d39e`）的对照，只记录 `scrollTop` 漂移这一**库视角**的量。
> **读者所在行的视口位移**（用户直接可感知的量）在 §14.6 修正后的 A/B 表中补出；两表视口高度不同（§14.5 = 751、§14.6 = 484），位移量与视口高度无关，见 §14.6 注。

**Cmd+F 的准确说法**（真实 Chrome 复现）：折叠的历史明细**完全不可搜**；已展开的明细**只在靠近视口时可搜**，
滚远后又不命中，滚回来恢复。

**未覆盖 / 限制**：

1. 真实数据取自本机**最大**的会话（偏悲观上限）；中等会话按字节线性外推应更低。
2. 复测用**合成 dsh 节奏**回放（1–3 帧/通知、0.8–2.3 s 间隔），未跑真实 dsh 长会话；窗口样本量小，Long Task 轮间波动约 ±2pp。
3. `isAtBottom` 在脚本化滚动下曾出现短暂失真（只影响"回到底部"按钮显隐，不影响 scrollTop/焦点），需真机手势复核。
4. 移动端与 `clientHeight === 0` 路径未做真机复测：② 的验证是 happy-dom + 可控 ResizeObserver（证明组件自身的尺寸感知），
   未在真实浏览器里模拟 `display: none` 的隐藏/恢复。
5. ② 的修复不改变"隐藏期间没有收益"这一事实（隐藏时仍是全量渲染），只保证重新可见后能回到虚拟化。
6. §14.5 的 A/B 表在**修正前**的代码上测得；§14.6 在修正后重测（视口高度 484 而非 751，漂移量与视口高度无关）。

### 14.6 锚定判定契约修正（v4，2026-09-11）

审查在 `dd57d39e` 上判定：自定义锚定判定读的是 **resize 之前缓存的 `item.end`**，把"上次测量在上方、本次增长后跨入视口"的行也当成"上方行"补偿——与其自身文档声明的规则不一致。
复议结论：**保留自定义策略**（A/B 已证明库默认确有真实回归，见下表），把判定改成可实现的契约并补边界回归。

**契约（实现与文档一致）：判定策略在 `packages/web/src/components/agent/scrollAnchoring.ts`（纯函数，`LogStream.tsx` 在虚拟化实例上装配它）：**

```ts
export function shouldAdjustScrollPositionOnItemSizeChange(
  item: VirtualItem, delta: number, instance: Virtualizer<HTMLElement, Element>,
): boolean {
  const coordinates = instance as unknown as ScrollCoordinates
  const viewportTop = coordinates.getScrollOffset() + coordinates.scrollAdjustments
  return item.end + delta <= viewportTop
}
```

- 回调拿到的 `item.end` 是 **resize 前的缓存值**，行在本次 resize 后的结束位置是 **`postResizeEnd = item.end + delta`**；
- 视口上边界取 **TanStack 同一坐标系**：`viewportTop = getScrollOffset() + scrollAdjustments`（`virtual-core@3.13.18` 把这两个成员标为 `private`，实现用窄接口 `ScrollCoordinates` 读取；库自身默认判定读的正是这两个值）；
- **仅当 `postResizeEnd <= viewportTop`** 才补偿 `delta`；
- **`viewportTop` 是库坐标系里的视口顶边，不含容器的 `padding-top`（本应用 24px）**：视觉坐标满足 `y_visual = paddingTop + item.end − scrollTop`，所以 `postResizeEnd === viewportTop` 时该行在视觉上**仍有 ≤24px 的一条可见带**（`y_visual = 24`）。
  因此准确说法是"行在 resize 后结束于**库坐标系的视口顶边之前**"，而**不是**"完整结束于可视顶边之上"——**"resize 后 end 落在可视顶边下 0–24px 带内"的行仍会被判为上方并补偿**。
  影响上界 = `paddingTop`，与库自身默认判定（`item.start < scrollOffset`，同样不含 `padding-top`）是**同一坐标约定**；**本轮按"措辞与实现对齐"处理，不改实现**：要消掉这 24px 带就得读取容器 `padding-top`、偏离库的坐标系约定，并改动已定契约的边界语义（等号用例与 B1 行为回归）。它影响的是"顶部 ≤24px 的可见带在被补偿后保持不动"，属记录级口径差异（复测标注为非阻塞）。
- **跨越视口、且 resize 后仍有可见像素的行不补偿**，包括"上次测量在上方、增长后跨入视口"这一情形；
- **`postResizeEnd === viewportTop` 归入"上方"**（库坐标系里刚好在顶边结束；视觉上仅剩上述 ≤24px 的可见带）→ 补偿；
- 完全在视口下方的行不补偿。

**可回归测试（`packages/web/src/components/agent/__tests__/LogStream.test.tsx`，本节锚定契约 38 例；另见 §14.7 新增的 1 例转换告警回归）**：

| # | 断言 | 形式 | 结果 |
|---|---|---|---|
| 1 | 谓词真值表：仍在上方→补偿；跨界→不补偿；落在边界（等号）→补偿；视口内/跨视口/下方→不补偿 | 单元（谓词直调） | ✅ |
| 2 | 收缩同规则：上方行收缩→补偿；跨视口行收缩 2500px→不补偿；视口内收缩→不补偿 | 单元 | ✅ |
| 3 | 已有 `scrollAdjustments` 时边界取调整后值（`920+120<=1000+40` 补偿；`adjustments=0` 时不补偿） | 单元 | ✅ |
| 4 | 与库默认判定在"跨视口行"上**必须不一致**（默认 `start < offset` → 补偿；自定义 → 不补偿） | 单元（对照） | ✅ |
| 5 | **F1 幅度**：同一 3428px 跨视口行 4×+24px，自定义漂移 `[0,0,0,0]`、库默认漂移 `[24,48,72,96]` | 单元（策略对拍） | ✅ |
| 6 | 真实 virtualizer（happy-dom）：跨界行（end=视口上边界）增长→`scrollTop` 不动；边界行→补偿；带 `scrollAdjustments` 的行→按调整后边界补偿；下方行→不动 | 行为回归 | ✅ |
| 7 | 真实 virtualizer：3428px 跨视口行 4×+24px→`scrollTop` 恒为 410；完全在上方的行 +40 → 补偿到 450 | 行为回归（**F1 守卫**） | ✅ |
| 8 | 真实 virtualizer：同一跨视口行收缩 2592px→`scrollTop` 恒为 410、行顶（视口内位置）不动 | 行为回归（**F2 守卫**） | ✅ |
| 9 | 真实 virtualizer：一次 commit 内视口上方 4 行各 +88px（合计 +352）→`scrollTop` +352、可见行视口内位移 0 | 行为回归（**F3 守卫**） | ✅ |
| 10 | 真实 virtualizer：视口内行 +200 / −16→`scrollTop` 与行的视口内位置均不动 | 行为回归 | ✅ |
| 11 | 真实 virtualizer：10 次连续追加（中间无 scroll 事件）→`scrollTop` 不动、锚点仍是同一 DOM 节点、仍保持窗口化渲染 | 行为回归（**F4 守卫**） | ✅ |

第 5 行是把受控 A/B 的漂移幅度钉进单测：两侧都由真实谓词计算（自定义策略直接调用 `shouldAdjustScrollPositionOnItemSizeChange`，对照组用 `libraryDefaultPredicate`），
但它是**谓词级模型**（同一 virtualizer 不能同时装两种策略）；"策略被删掉/改坏"的**活体守卫**是第 6–11 行的行为回归。

**红/绿验证（防"策略被删掉测试也不红"；两处改动都只改一行，跑完即还原）**：

| 变体 | 结果 |
|---|---|
| 现行实现 | 38/38 通过（连续 3 次重复运行一致） |
| 改回旧判定（`item.end <= scrollOffset`） | **4 例红**：谓词真值表、`scrollAdjustments` 边界、与库默认对拍、跨界行为回归 |
| 删掉策略赋值（退回库默认） | **3 例红**：F1 守卫（首个 patch `scrollTop` 434≠410，即每 patch +24）、跨界行为回归（1080≠1000）、F2 守卫（−2182≠410，即被收缩量整段拽走） |

**对照审查提出的 6 类边界**：① F1（自定义 0 / 默认 96px）→ 第 5、7 行；② 增长后恰好跨界不补偿、`postResizeEnd === viewportTop` 补偿 → 第 1、6 行；
③ F2 收缩变化 0 → 第 2、8 行；④ F3 一次 commit 多行改高 +352、可见行位移 0，已有 `scrollAdjustments` → 第 3、6、9 行；
⑤ 视口内增减不补偿、完全在上方补偿、完全在下方不补偿 → 第 1、2、6、10 行；⑥ F4 快速连续追加无累计漂移 → 第 11 行。
第 11 行覆盖的是"追加不移动阅读锚点"；F4 里"贴底跟随时不脱底"那一半由父组件 `AgentSessionPanel` 的 `useStickToBottom` 负责，
不在 `LogStream` 单测范围内，只由 §14.6 的真实 Chrome A/B 覆盖。

**修正后受控 A/B（真实 Chrome 152、`packages/web/dist` 生产 CSS、1400×900 窗口、`clientHeight=484`、真实 1000 条会话池；
变体只删掉 `virtualizer.shouldAdjustScrollPositionOnItemSizeChange = ...` 这一行）：**

| 场景 | 自定义策略（现行） | 库默认（对照） | 读者所在行的视口位移（自定义 → 库默认） |
|---|---|---|---|
| **F1** 跨视口长行（top 在视口上方 250px、行高 3428px）4 次 +24px 增长 | `scrollTop` 漂移 **[0,0,0,0]**；行长变化 [24,24,24,24]；行顶漂移 **0** | `scrollTop` 漂移 **[24,48,72,96]**；行顶漂移 **[−24,−48,−72,−96]**（读者被拖进新增文本） | **0（4/4 次）→ 每 patch −24px、累计 −96px**（读者行顶 y 10 → −86，几乎被推出视口） |
| **B1** 行 end 在视口上边界下方 8px，增长 +24px 跨入视口 | `scrollTop` 漂移 **0**（end 8→32，新文本出现在上边缘，阅读位置不动） | `scrollTop` 漂移 **+24** | **0**（读者行顶不动，新文本落进顶边）**→ 0**（end 停在 8，由 `scrollTop` 补偿） |
| **B2** 行 end 在视口上方 200px，增长 +24px（仍在视口上方） | `scrollTop` **+24**，下方可见行位移 **0** | 相同（+24，位移 0） | **0 → 0**（下方可见行都不动） |
| **F2** 同一跨视口行收缩 2592px | `scrollTop` 漂移 **0**，行顶漂移 **0** | `scrollTop` 漂移 **−2592**（读者被拽走） | **0 → +2448**（读者行被下推 2448px；收缩量为人为边界，两轮实测 2448 / 2592px，方向一致） |
| **F3** 一次 commit 内视口上方 4 行改高（实测合计 +112px，且 resize 后仍在上方） | `scrollTop` **+112** = 总增量，可见行位移 **0** | 完全相同 | **0 → 0**（可见行位移 0，两侧相同） |
| **F4** 尾随 10 次连续追加（阻塞 259–292ms） | `fromBottom` 0→1、`isAtBottom=true`、跟随不脱底 | 完全相同 | **0 → 0**（贴底场景，跟随不脱底） |

**「读者所在行的视口位移」口径（本列新增）**：该场景被 resize 的那一行（跨视口长行就是读者正在阅读的那一行）**顶边在视口坐标里的 y 变化**；正 = 被下推、负 = 被上推。
这是**用户直接可感知**的量，比 `scrollTop` 漂移更接近"读者有没有被甩走"——`scrollTop` 只说明库改了滚动位置，不说明读者看到的内容是否移动。
列内数字取自**独立复测**（2026-09-11，真实 Chrome，视口 `clientHeight=751`、retry-safe 驱动，`scratch/p0-3-probe/out/anchor2-*.json`）；本表前三列为实施者自测（视口 484）。
**位移量与视口高度无关**（行长 3428px、每 patch +24px 两轮一致），故两轮方向与量级一致：F1 自定义 4/4 次为 0、库默认每 patch −24px、累计 **−96px**；F2 自定义 0、库默认 **+2448px**。

- F1/B1/F2 三处差异**只在跨视口行出现**：B1 正是本轮修掉的"语义不一致"——修正前该行也会被补偿（旧判定 `item.end(8) <= scrollOffset` 为真）。
- `bootErrors` / `consoleErrors` 均为空；harness 脚本 `scratch/p0-3-probe/exp-anchor.js`（gitignored），原始结果 `scratch/p0-3-probe/out/anchor-{full,full-default}.json`。
- ⚠️ **该 harness 的绝对数字在补防护前不作定论**：它用 `agent-browser eval` 下发**单次约 30s 的长阻塞脚本**，实测该驱动会**重复下发、页面并发执行同一脚本**
  （页面侧 `starts` 出现 5 次、间隔 ~30s；CLI 最终报 `Failed to read … after 5 retries`）。并发实例会同时改同一个 store、滚同一个容器，
  典型症状是 `seq` 相撞导致 patch 静默失效、漂移出现 6273 / −4000 一类跳变。
  **上表与「读者所在行的视口位移」列的数字以独立复测的 retry-safe 驱动为准**（body 只安装一次 → `start` 立即返回 → 短 `eval` 轮询，报告用 `starts:1` 自证单实例；
  `scratch/p0-3-probe/exp-anchor2-body.js` + `run-anchor2.sh`，结果 `out/anchor2-{full,full-default}.json`）。
  本仓库所有"长阻塞脚本 + `eval`"的 A/B 都应按同一标准复核；两侧一致的数字（自定义 `[0,0,0,0]` vs 库默认 `[24,48,72,96]`）已在 retry-safe 重跑下复现。

**残留限制（未扩大改动，仅记录）**：同一测量批次里多行同时改高时，`item.end` 不含**本批次内更早行**的增量，而边界含 `scrollAdjustments`，
因此"postResizeEnd 落在本批次累计调整带内"的行仍会被补偿（幅度 ≤ 该批次累计增量）。这是库自身的坐标系约定；上表 F3 的实测场景未触发该带。

### 14.7 P0-3 收尾修复轮（v5，2026-09-11）：显示/隐藏转换的虚拟化告警与测量丢弃

**现象（独立复测发现，真实 Chrome）**：每次 `display: none ↔ visible` 转换都会刷 TanStack Virtual 告警
`Missing attribute name 'data-index={index}' on measured element.`——4 次转换共 **88 条 = 每次 22 条 = 隐藏前挂载的行数**；对照普通重渲染（无可见性变化）**0 条**。
告警元素是 fallback 分支的 `div[data-at-row]`（`style=""`、**无 `data-index`**），不是虚拟化分支的行。

**机制**：两个分支渲染**同一批 `row.key`**，React 因此把虚拟行节点**复用**为 fallback 行：`data-index` 与 `measureElement` ref 被摘掉，
但 react-virtual 的**逐行 ResizeObserver 仍观察着这些仍在文档里的节点**；回调走 `indexFromElement` → 属性缺失 → `console.warn` → `return -1`，**该次测量被丢弃**。
已观察影响只有控制台噪音 + 该次测量跳过（转换后相邻行连续性 `maxAbsGap=0`、`scrollTop` 保持，未观察到布局异常）；
潜在风险是被复用且属性缺失的行，其内容若在此期间变化，要等重新挂载才会被重新测量。

**修法：给两个分支容器各自一个 `key`（`virtualized` / `static`），强制拆建，而不是复用节点。**

- **为什么不选"清理失效的逐行观察者"**：`virtualizer.measureElement(null)` 的清理只 `unobserve` **已断开连接**的缓存节点，而问题恰恰是节点**仍连接**、只是属性被摘；
  库也没有公开的"按节点 `unobserve`"接口，去改库内私有观察者比拆建更脆。
- **为什么行 key 不动**：虚拟化实例的 `itemSizeCache` 以**行 key**（`getItemKey`）为键。行 key 保持不变，转换前后的**已测高度得以保留**；
  若给行 key 加分支前缀，反而会清空所有测量值、回落到估算高度——那正是"丢测量"的另一半。
- **残留（记录级）**：若 React 在移除 DOM 之前先 detach ref，旧节点会短暂留在库的 `elementsCache` 中；但它们**已脱离文档**，真实浏览器不会再为其回调，
  且下次同 key 挂载时 `_measureElement` 会 `unobserve` 旧节点、改观察新节点。
- **行为差异（记录级）**：拆建意味着行**内部的局部 UI 状态**（`ThinkingBlock` / `ToolBlock` / `ExecutionDetailsGroup` 的展开态）在转换后回到默认值。
  这与虚拟化分支自身的语义一致——行滚出窗口被卸载时，同样的局部状态本来就会重置；**跨转换持久的展开状态（`LogStream` 的 `expandedTurns`、「已处理」分组）不受影响**。

**回归测试**（`packages/web/src/components/agent/__tests__/LogStream.test.tsx`，「tears the measured rows down instead of reusing them as fallback rows」）：

1. 虚拟化下取已挂载的 `[data-index]` 行，以及 react-virtual 的逐行观察者；
2. 视口高度置 0 并触发组件自身的 RO → 进入 fallback（全量渲染，`[data-index]` 归零）；
3. 断言这些已测行**全部脱离文档**（`isConnected === false`，即没有被复用为 fallback 行）；
4. 只对**仍渲染中**的已观察元素补发一次 resize 批次（浏览器语义）→ 断言 **0 条** `data-index` 告警。

**红/绿**（只回退分支 `key` 这一处）：第 3 步失败（`expected false to be true`），第 4 步同时报出 **28 条**同款告警（= 当次挂载行数，与真实浏览器症状同机制）；加回后 **39/39 通过**。

**本轮未做（明确范围外）**：P1（隐藏→显示把读者甩到底部）归属未定，未动 `useStickToBottom` 及其调用点；隐藏期间仍是全量渲染（§14.5 限制 5 仍成立）。

## 15. 暂缓清单（只登记，未实现；2026-09-14）

> 来源：P0-2 实施轮的暂缓项登记要求。**登记不等于排期**，每项给出依据位置，便于后续单独派活。

1. **长历史分批加载（REST `/logs` 仍一次性全量返回）**
   - 现状依据：§5 非实时链路、§14.1（最大会话 3238 entries / 28.10 MiB，`~/.agent-tower/data.db` 只读统计）。
   - 本轮未动分页/流式加载（属 §6 修复方案里的 P2-2）。打开长会话的卡顿主因已由 P0-3 虚拟化（已发布）与 P0-2 结构化共享（本轮）解决；分批加载是进一步的传输/内存优化。
2. **会话往上翻时被新内容拽到底部**
   - 现状依据：§14.7 收尾时已明确"隐藏→显示把读者甩到底部"（P1）归属未定、**未动 `useStickToBottom` 及其调用点**；本节登记的是同一族的另一场景——**用户主动上翻时新内容到达被拽到底部**，同样未排查、未修。
   - 需要先定产品口径（上翻时是否自动滚动、如何提示未读），非纯实现项。
3. **DSH/ACP 大帧上限隐患（非性能项，暂挂本文，待定归属）**
   - `packages/server/src/runtime/acp/process-manager.ts:775` 对 stdout 帧**重新序列化后**调用 `assertFrameSize(serialized, MAX_STDOUT_LINE_BYTES)`，用的是模块常量 1 MiB（`:16`）：既没有走 `launch.maxStdoutFrameBytes`，也没有在"无 transform"时跳过（无 transform 时 `serialized` 与已通过 `:761` 检查的原文等价，这次检查是重复且更严的卡口）。入站方向用的是 `this.launch.maxStdoutFrameBytes ?? MAX_STDOUT_LINE_BYTES`（`:160`），两侧口径不一致；超过 1 MiB 直接抛 `protocol_violation`。
   - 影响面与真实触发频率未测（断开排查中 DSH 未出现过帧超限）。仓库内无专门的 ACP 传输文档，故登记在此。

## 附录 A：核心证据代码位置

| 现象 | 位置 |
|---|---|
| 全文档深拷贝 | `packages/web/src/stores/session-log-store.ts:135`；`node_modules/fast-json-patch/dist/fast-json-patch.js` `applyPatch` → `_deepClone = JSON.parse(JSON.stringify(obj))` |
| 累计全文下发 | `packages/server/src/runtime/acp/projector.ts:108-109`；op 定义 `packages/server/src/output/utils/patch.ts:61-69` |
| 整数组 replace | `packages/server/src/runtime/acp/acp-driver.ts:665-711`（v2 打点后行号）；触发条件 `:586-608` + `services/session-manager.ts:759-762`、`:112-121`、`:2533` |
| 每 patch 全量派生 | `packages/web/src/lib/socket/hooks/useNormalizedLogs.ts:300`、`:311`、`:318`、`:502`、`:668` |
| 无虚拟化 / 每帧重建元素树 | `packages/web/src/components/agent/LogStream.tsx:750`、`:819`、`:849` |
| 服务端 checkpoint 阻塞 | `packages/server/src/services/session-manager.ts:188`、`:2136-2200`；`packages/server/src/output/msg-store.ts:166-217`、`:294-351` |
| REST 全量快照 | `packages/server/src/routes/sessions.ts:426-459` |
| dsh 启动方式 | `packages/server/src/runtime/acp/agents/deepseek-hermes.ts:127-131`（`dsh --profile acp`） |
| 滚动锚定判定契约 | `packages/web/src/components/agent/scrollAnchoring.ts` `shouldAdjustScrollPositionOnItemSizeChange`（§14.6；实例装配在 `LogStream.tsx`）；库侧 `node_modules/.pnpm/@tanstack+virtual-core@3.13.18/.../index.js:578-599` `resizeItem`、`:326-334` `scrollAdjustments` 复位 |

## 附录 B：原始测量输出

| 内容 | 路径 |
|---|---|
| v1 bench a–e 完整表格 | `/tmp/at-perf-bench.txt` |
| v2 真实 Chrome 全量结果 | `/tmp/at-chrome-results.json` |
| v2 Chrome traces | `/tmp/at-chrome-traces/{trace-1000,trace-3000,trace-3000-storeonly}.json` |
| v2 harness 脚本 | `node_modules/.at-perf/chrome/{harness.tsx,drive.mjs}`（gitignored） |
| v2 真实 dsh ACP 原始通知 | `/tmp/at-acp-probe-raw.json`；脚本 `node_modules/.at-perf/acp-measure.mjs` |
| P0-2 契约规范 | `docs/perf-p0-2-conversation-patch-contract.md` |
| 真实库只读统计 | `sqlite3 -readonly "file:$HOME/.agent-tower/data.db?mode=ro"`（§10.2 全部数字） |
| **v3 fixture（已校准）与自检脚本** | `node_modules/.at-perf/fixtures.ts`、`node_modules/.at-perf/calibrate-fixture.ts`（gitignored，副本见 `/tmp/at-perf-scripts/`） |
| **v3 真实数据回填的来源** | 独立复测报告（Team Room，SHA `dd57d39e`）+ §14.1 的两个真实会话 `logSnapshot`；原始 JSON 在 `/tmp/p03-exp-*.jsonl` |
| **v4 锚定 A/B harness 与原始结果** | `scratch/p0-3-probe/exp-anchor.js`、`scratch/p0-3-probe/run-anchor.sh`、`scratch/p0-3-probe/out/anchor-{full,full-default}.json`（gitignored；探针静态服务 `vite preview --port 5199`，由 `agent-browser` 驱动真实 Chrome）。⚠️ **长阻塞脚本经 `agent-browser eval` 会并发重放，绝对数字不作定论（§14.6）**；可信重跑见 `exp-anchor2-body.js` / `run-anchor2.sh` / `out/anchor2-{full,full-default}.json` |

## 16. P0-2 独立验证记录（2026-09-14，测试工程师）

> **验证对象**：`db09d20c..6233c8ba`（终点 `6233c8ba`；11 文件 / +1927 −41；终点工作树 clean、树内无临时或 bench 文件——已复核）。
> **预登记**：房间消息 `844f7de9-3ef5-4512-8f11-f790b1aa24c4`（**2026-09-14T05:04:40Z**，在看到任何结果之前写定）；负责人裁定 `a7f39bab-b40f-4859-a7ca-e409b58ab2bd`（05:05:22Z：adapter 缓存纳入本轮范围、F12 收窄为覆盖缺口＋量化、F11 只适用常规 patch 路径、其余门槛不放松）。
> **一句话结论：能（有条件）** —— 可作为"会话进行中卡顿的 **store 归因部分** 已修复"的放行依据；条件与边界见 16.6。

### 16.1 预登记阈值（原文摘录，登记时间 2026-09-14T05:04:40Z）

**判失败条件 F1–F12（原文）**

- **F1** 任一引用不变量失败（§2 清单，含旧 metadata 被改写、未触碰 entry 引用变化、根级 replace 未 slice）。
- **F2** 单 patch 成本仍随无关条目数增长：10k/1k 中位比 >2.0，或 10k 中位 >2 ms。
- **F3** 支持集合上任一条与 `fast-json-patch` 结果不等（成功侧 JSON 不全等）。
- **F4** 新实现比基准更宽松：基准失败/抛错的输入，新实现返回 `ok===true`。
- **F5** `remove` / `move|copy|test` / `add /entries/-` 返回 `ok===true`，**或**返回 false 却部分落地（文档变化、无 warn、重拉次数 ≠1）。
- **F6** 混合批次（有效 op + 不支持 op）出现部分应用；或降级未真正触发（无重拉、缓冲 patch 丢失、seq 缺口被静默跳过）。
- **F7** 生产构建里返回文档被冻结（`Object.isFrozen===true`）或冻结进入热路径 → D5/§3.4 违例。
- **F8** UI 回归：落盘文本与旧路径不一致、滚动跟随/锚点（≥1 行）破坏、DOM 节点数随 N 增长、白屏或错误边界被触发。
- **F9** 我按 §1 测得的实现者样本真实性闸门不达标，且其结论未用真实样本复核（数字不采信，等同未提供放行依据）。
- **F10** main-cause 复现 <20×。
- **F11** 冻结/降级路径在真实会话中导致可观测的用户级卡顿（降级窗口内单次阻塞 >100 ms）。【裁定收窄：只适用常规 patch 路径；重拉窗口内按 F12 量化】
- **F12** 缓冲重放**仍走 baseline 深拷贝**：则"客户端 patch 应用路径不再发生整份深拷贝"的表述不成立。【裁定：接受为已知覆盖缺口＋量化，结论表述必须收窄；实现者若低风险平替则一并做掉——本轮实现者已切到新模块，按"待验证主张"实测】
- 附加：现有 `session-log-store*.test.ts`、`useNormalizedLogs.reconnect.test.tsx` 任一失败 → 不通过。

**§4 规模与容差（原文）**：单 patch 中位 `10k ≤ max(2 ms, 2.0× 1k 中位)`，且 p90(10k) ≤ 5 ms；主因复现要求同进程 A/B 中 10k 档中位改善 **≥20×**；浏览器单 patch 阻塞目标 3k 档 ≤ 33 ms。计时协议：ABAB 交错、3 轮独立进程、每档 200 次取中位/p90/IQR，记录 loadavg；`loadavg(1m) > 2×核数` 或实现者正在跑构建/测试 → 该轮作废。

**§5 用户级代理（原文）**：流式窗口内**无单次到达 >33 ms 的 store 归因阻塞**、Long Task 占比 <1%、avg 帧间隔 ≤16.7 ms / p95 ≤33 ms；日志容器 DOM 节点数在 1k vs 3k 的差异 ≤30%（应 O(视口)）；滚动锚点误差 <1 行；每次到达的容器 `childList` 变更数追加场景应 ≈1–3 个节点而不是整树重挂。

**§1 fixture 真实性闸门（原文）**：fixture 均值不得低于真实样本均值 ×0.9、p50 偏差 ≤±20%、p90 偏差 ≤±25%、类型占比偏差 ≤5pp。

### 16.2 实际结果：F1–F12 逐项判定

| 项 | 判定 | 实际证据（摘要） |
|---|---|---|
| **F1** | **通过** | 1k / 10k 文档各 21 条引用不变量全部成立（未触碰 entry 与 metadata 引用相等、命中父链全新、旧 metadata 字节全等且未被改写、根级 `replace /entries` 返回 `slice()` 新数组、`add /sessionId` 保持 entries 数组同一引用）；输入文档 JSON 前后全等。60 patch 内 0 次引用破坏。 |
| **F2** | **通过** | 3 轮独立进程（每档 200 次 ABAB，loadavg ≤5.1 / 10 核，3 轮 valid）：新实现中位 1k=0.010–0.012 ms、10k=0.011–0.012 ms，**10k/1k 中位比 = 1.0**；p90(10k) 最大 0.028 ms ≤ 5 ms。旧实现同轮 1k=27–35 ms、10k=232–273 ms（比值 7.4–9.7×，正是全文档深拷贝特征）。 |
| **F3** | **通过** | 结构化矩阵 49 例 + 自研 property-based **50,000 例** + store 级 fast-check 3,000 例：成功侧与 `fast-json-patch@3.1.1` `JSON.stringify` 全等，mismatch **0**。 |
| **F4** | **通过** | 三者合计 53,000+ 例中"基准失败 / 抛错而新实现 `ok===true`"= **0**。反向（基准成功、新实现拒绝）共 11 例，逐条落在契约 §5.1 有意分歧清单（`remove`/`move`/`copy`/`test`/`add /entries/-`）或 §4"其他 path 一律降级"（`/foo`、`add /entries`、`add /entries/{i}/content`、`/sessionId` 的 replace、空 path、`/`），无一条属于"未解释的更严格"。 |
| **F5** | **通过** | 不支持集合全部 `ok=false` 且恰好 1 次结构化 `console.warn`；混合批次（`[replace /entries/2/content, remove /entries/0]`）整批不落地——store 文档对象引用不变、JSON 全等、warn=1、重拉=1。 |
| **F6** | **通过** | 真实 `useNormalizedLogs`（happy-dom + mock socket/fetch）6 例全过：未知 op 触发 1 次 `GET /sessions/:id/logs`；加载期到达的 patch 进入缓冲并在快照后按 seq 顺序重放；seq 缺口触发重拉而非静默套用；缓冲中的不支持 op → 重拉后该 patch 被丢弃、最终文档=权威快照。 |
| **F7** | **通过** | 运行时：prod 构建的 `applyConversationPatch`/store 返回值 `Object.isFrozen===false`（dev/test 为 true 且原地写抛 `TypeError`）。产物：`packages/web/dist` 中含 P0-2 模块的 chunk 内，该模块代码区间无任何 `Object.freeze`（`withEntries` 编译为 `{...e,entries:t}`）；全 chunk 的 4 处 `Object.freeze` 分别属于 agent 类型列表、property-information、micromark、mermaid 命名空间包装，均不在 patch 路径上。 |
| **F8** | **通过** | 真实 Chrome：新/旧路径在同一真实文档、同一真实 patch 序列下落盘 `textContent` 哈希、文本长度、可见行数、entry id 序列**全部一致**（1k/3k × 真实抓帧/流式两类序列，4/4 组）；§12 交互套件（底部跟随、上滚不被抢焦点、展开折叠、`scrollToBottom`、卸载重挂、跨视口长行增长）在真实 3k 文档上 **0 失败**，锚点误差 0 行，页面 0 异常、错误边界未触发。 |
| **F9** | **通过** | 我独立测得实现者 fixture（`node_modules/.at-perf/fixtures.ts`）500/1k/3k/10k = 9.08/9.22/9.01/9.12 KiB per entry，对真实参照 8.888 的比值 1.02–1.04（闸门 ≥0.9）；p50 3.44–4.17（参照 4.024，偏差 ≤14.5%）、p90 20.35–22.20（偏差 +2.9%～+12.2%）、类型占比偏差 ≤5pp。**闸门通过**，其结论可用真实样本复核。 |
| **F10** | **通过** | 10k 档最差一轮中位改善 **×2249.8**（≥20×，实际余量约两个数量级）。 |
| **F11** | **通过（无触发）** | 真实 dsh 会话未出现降级/重拉窗口；常规路径单次到达的 store 归因阻塞：浏览器 3k 档 max 0.2 ms、Node 10k 档 p90 0.031 ms，远低于 100 ms。 |
| **F12** | **通过（缺口已关闭）** | `useNormalizedLogs` 缓冲重放已改用 `applyConversationPatch`：实测"缓冲=有效 op + 不支持 op"→ 结构化 warn → 重拉 → 重放整批丢弃、最终文档=权威快照（remove 未落地、content 未被改写）；"缓冲=全部有效 op"→ 仅 1 次 GET、按 seq 顺序落地且 `seq` 正确推进。**"客户端 patch 应用路径不再发生整份深拷贝"的表述在常规路径与缓冲重放路径上均成立**；仍成立的收窄口径：快照本身仍是一次性的全量对象构建（`setConversation`），重拉窗口的阻塞按 16.6 量化。 |
| **附加** | **通过** | 全量 `pnpm exec vitest run packages/web packages/shared` = **62 文件 / 418 用例全部通过**（含 `session-log-store*.test.ts`、`useNormalizedLogs.reconnect.test.tsx`）。 |

### 16.3 §4 容差 与 §5 用户级代理

**§4 容差**（3 轮 × 200 次，ABAB 交错，loadavg 4.6–5.1 / 10 核，全部 valid）：

| 档位 | 旧路径中位（3 轮） | 新路径中位（3 轮） | p90(新) | 10k/1k 比 |
|---|---|---|---|---|
| 1k | 29.36 / 27.00 / 35.18 ms | 0.010 / 0.010 / 0.012 ms | ≤0.028 ms | — |
| 3k | 71.58 / 71.60 / 74.63 ms | 0.010 / 0.010 / 0.011 ms | ≤0.026 ms | — |
| 10k | 253.97 / 256.36 / 273.18 ms | 0.012 / 0.012 / 0.011 ms | ≤0.023 ms | **1.0** |

**§5 用户级代理**（真实 Chrome 152 无头 + §9.1 遮挡修正、`visibilityState=visible`、1400×900、生产 React/esbuild `import.meta.env.DEV=false`；真实 3238 条 entry 池）：

| 配置（3k，60 次到达） | 新路径 | 旧路径（harness 内 baseline 直驱） |
|---|---|---|
| 单次到达 store 阻塞 max | **0.2 ms** | 97–134 ms |
| avg / p95 帧间隔 | **16.67 / 16.7 ms** | 33.8–44.2 / 83.3–116.6 ms |
| >50 ms 帧数 | **0 / 184** | 59–60 / 187 |
| Long Task 占比 | **0%（0 次）** | 71.9–79.6%（60 次） |

- 真实 dsh（隔离实例 + 生产 `dist`，3 个会话 / 12 帧）：抓到的 `(op,path)` 全部落在契约 §1 六种组合内（`add /sessionId`×3、`add /entries/{i}`×9），**契约违例 0**；页面 `window.onerror`/`unhandledrejection` 捕获 0 异常、错误边界未触发（该次观测未挂 console 采集，故不作"0 警告"表述）；221.8 秒 / 13,298 帧窗口内 rAF avg 16.68 / p50 16.7 / p95 16.7 ms，Long Task 2 次（140 ms 出现在内容到达前 77 s，属面板/加载；56 ms 与 145 KB 内容 entry 到达同刻，+41 ms）。
- **DOM 口径（需注意字面口径）**：`1k vs 3k` 的**容器总节点数**在"刚挂载时"为 201 vs 517（差 157%），但差因是 3k 视口恰好落在一行 4262 px、320 节点的长 markdown 行；把两者都滚到底部（受控、视口内容等价）后为 **201 vs 184（差 8.5%）**，**虚拟化行数 28 vs 29 恒定**，`rows`/`O(视口)` 判定成立。因此本条按受控口径**通过**，但"字面按随机视口比总节点数"不可作为判据。
- **每次到达的容器变更数**：捕获序列（`add`）childList 0–0.05/次（只挂载新行）；流式内容序列 0.05/次；`append` 序列 3.05/次（新增行 + 视口位移），无整树重挂。
- **真实会话到达→DOM 稳定**：3 个 entry 在 9 ms 内成批到达（seq 2/3/4），DOM 从 +14 ms 开始变更、+239 ms 静止（28 条 mutation、15 增 11 删）——这是 **35.6k 字符 markdown 一次渲染**的成本，与 store 无关（同刻 store 阻塞 ≤0.2 ms）。这是本轮**最大的残余用户感知卡顿来源**，属 P0-2 范围外。

### 16.4 实现者 §⑤ 量化数字的独立复核

| 实现者主张 | 我的复核 | 结论 |
|---|---|---|
| fixture 均值 8.72 KB/entry（真实参照 8.89，比值 0.98 ✓） | 我按真实分布实测其 fixture：1k=**9.22 KiB/entry**（比值 1.037）；其"8.72"是 KiB/byte 单位口径差（8.72 KiB = 8.93 KB），不影响闸门 | **通过**（数值口径需注明） |
| 10k 新实现 1.4 µs、旧 374.1 ms、改善 2.7×10⁵ | 我测得新 **11–12 µs**、旧 **232–273 ms**、改善 **×2249.8（最差一轮）**；方向与量级一致，绝对值为旁证不可跨机比较 | **一致（绝对值不同）** |
| "10k/1k 中位比 1.3×" | 我测得 **1.0×**（0.012/0.012 ms） | **一致/更好** |
| "残余线性项是 `entries.slice()`，约 0.1–0.25 ns/条" | `hrtime` 高精度：`slice()` 1k=**250 ns（0.25 ns/条）**、10k=**1000 ns（0.1 ns/条）**；`applyConversationPatch` 1k→10k 增量 583 ns，slice 增量 750 ns（同量级、可解释该增量） | **成立** |
| 生产产物 P0-2 区间 0 个 `Object.freeze` | 复核一致（该 chunk 4 处 freeze 均属无关模块） | **通过** |
| 全量测试 62 文件 / 411 用例 | 我复跑 **62 文件 / 418 用例**全过（用例数差异来自复跑时的文件集合） | **通过** |
| "不能用'整个产物零冻结'表述" | 属实：整包 `dist` 共 126 处 `Object.freeze` | **表述正确** |

**额外发现（实现者未提及、不影响判定）**：`fast-json-patch` 在 `mutateDocument=false` 下会把 `operation.value` 直接别名进结果文档，并可能**原地改写 patch 载荷**（根级 `replace /entries` 后再 `add /entries/{i}` 会 splice 进同一个数组）。新实现不共享该行为（新实现**不修改** patch 载荷，50k 例 property 中 0 次）；这也是契约 §3.3 要求 `replace /entries` 必须 `value.slice()` 的实证依据。

### 16.5 §8"无法独立验证"条目在执行后的状态

| §8 条目 | 执行后状态 |
|---|---|
| 1. 用户主观"不卡" | **仍成立**：只有同机代理指标与 A/B，无用户硬件/GPU 主观复现。 |
| 2. 超出真实样本的规模 | **仍成立**：本机真实最长会话 1777 entries（参照集 3238）；浏览器只测 1k/3k，10k 用真实 entry 循环拼接外推。 |
| 3. 未来所有 patch 都在 6 种组合内 | **部分收窄**：本轮 3 个真实 dsh 会话 12 帧 0 违例，但仍是有限窗口，不是永久保证。 |
| 4. 绝对耗时跨机可比 | **仍成立**：全部绝对值为同机旁证；只承认同机背靠背与新/旧对比。 |
| 5. "用户完全不再卡" | **仍成立，且已量化**：store 归因阻塞已消除，残余为 markdown 一次渲染（真实会话 35.6k 字符 → 239 ms settle / 56 ms Long Task）与长历史一次性加载。 |
| 6. 真实网络乱序/重复 | **仍成立**：只做合成注入。 |
| 7. "冻结永不进生产" | **基本关闭**：运行时探针 + 产物检查一致；形式化证明仍不可能。 |

### 16.6 未通过 / 未覆盖与残余风险（放行条件）

1. **未发现 F1–F12 任一失败项**，也未发现契约违例；但"会话进行中卡顿已修复"只能在 **store 归因** 意义上放行：真实 dsh 大 entry 到达时仍有 **239 ms 的 markdown 渲染 settle**（单次 56 ms Long Task），属 P0-2 范围外（§4.1 的 D 项 / 长历史加载），建议后续按 §15 的暂缓清单单独派活。
2. **DOM 判据须按受控口径**（同为底部视口）解读，字面"随机视口总节点数"会因单行内容大小失真。
3. 10k 档为外推（真实 entry 循环拼接）；浏览器侧未测 10k。
4. 未做 CDP HeapProfiler 分配采样（E5 仅以 Node GC 观测替代：旧路径 10k 档 3600 次 GC / 3.8–6.0 s 停顿，新路径同轮 0 次集中停顿），属**旁证缺口**，不影响 E1/E2/E3/E4 判据。

### 16.7 产物路径

| 内容 | 路径 |
|---|---|
| 真实样本测量（三组 + §14.1 复算） | `/tmp/at-p0-2/real-samples.json`、`/tmp/at-p0-2/sessions.tsv`、`/tmp/at-p0-2/ref-pool.json`、`/tmp/at-p0-2/sample.log` |
| Node 差分/引用/冻结/adapter/fixture 闸门 | `/tmp/at-p0-2/verify-node-base.json` |
| Node 规模 A/B 3 轮 + 合并判定 | `/tmp/at-p0-2/verify-node-timing-{1,2,3}.json`、`/tmp/at-p0-2/verify-node.json`、`/tmp/at-p0-2/timing.log` |
| 残余线性项高精度复核 | `/tmp/at-p0-2/residual.json` |
| 降级/缓冲重放 scratch 测试 + 日志 | `node_modules/.at-perf/p0-2/__tests__/p02-{degradation.test.tsx,store-property.test.ts}`、`/tmp/at-p0-2/vitest-scratch.log` |
| 全量测试 / 生产构建 | `/tmp/at-p0-2/vitest-full.log`、`/tmp/at-p0-2/web-build.log` |
| 真实 dsh 抓帧（含契约清单） | `/tmp/at-p0-2/patch-seq.json`、`/tmp/at-p0-2/patch-seq-report.json` |
| 真实会话页面指标与截图 | `/tmp/at-p0-2/page-metrics.json`、`/tmp/at-p0-2/real-dsh-session.png` |
| 浏览器 A/B / DOM / 交互套件 | `/tmp/at-p0-2/chrome-results-{ab,domprobe,interactions}.json`、`/tmp/at-p0-2/browser-summary.json`、日志 `browser-ab.log`/`browser-interactions.log` |
| 复跑入口（scratch，gitignored） | `node_modules/.at-perf/p0-2/{build.sh,verify-node.mjs,residual.mjs,drive-browser.mjs,capture-patches.mjs,vitest.config.ts,pool.mjs}`；harness `node_modules/.at-perf/chrome/{build.sh,harness.tsx,drive.mjs}` |

### 16.8 增量验证：终点 `647e108b`（2026-09-14，第二轮）

> **行为终点**：`647e108b`（父 `6ae8fda8`，2 文件 / +52 −15；累计区间 `db09d20c..647e108b`）。**验证时的 HEAD**：`28d8f166`（= `647e108b` 行为 + 纯文档提交，代码零差异）。预登记阈值与 §16.1 完全一致，未做任何调整。

**端点漂移说明（如实记录）**：§16 第一轮以 `6233c8ba` 为终点，但执行期间实现者又落了 `6ae8fda8`（14:09，含 D9 索引解析改动）与 `647e108b`（14:25，补 int32 上界）。第一轮中：Node 侧证据（`base`/`timing`/`residual`，bundle 构建于 13:54）**绑定 `6233c8ba`**；而全量测试/生产构建/真实 dsh/浏览器 A/B（14:13–14:24）实际跑在已含 D9 改动的工作树上，**不严格等于 `6233c8ba`**。因此本节把**全部受影响项在新终点上重跑**，两轮结论分列。

**① 索引边界（D9）**：14 个用例（`add` 8 个、`replace` 6 个）**全部整批不落地 + 恰好 1 条告警 + 文档字节不变**，0 违例。基准同输入的对照：

| 输入（`add`） | 基准行为 | 新实现 |
|---|---|---|
| `/entries/00` | **成功，插到 index 0** | 拒绝（`unsupported` + 告警） |
| `/entries/007` | **成功，插到 index 7** | 拒绝 |
| `/entries/2147483648` | **成功，插到 index 0**（ToInt32 回绕） | 拒绝 |
| `/entries/2147483649` | **成功，插到 index 0** | 拒绝 |
| `/entries/4294967296` | **成功，插到 index 0** | 拒绝 |
| `/entries/9007199254740991` | **成功，插到 index 7** | 拒绝 |
| `/entries/9007199254740992` | **成功，插到 index 0** | 拒绝 |
| `/entries/99999999999999999999` | 失败（非安全整数） | 拒绝 |

`replace /entries/00`、`/entries/2147483648`、`/entries/4294967296`（整条与 `/content`）两侧都失败。**结论：D9 的三类（前导零、非安全整数、int32 回绕）都从"基准静默写错位置"改成"整批降级 + 重拉"，属有意更严格分歧，与契约 §5.1/§7-D9 一致。**

**② 拒绝不再依赖 `entries.length`（本轮新修点）**：构造 `new Array(2147483649)` 的稀疏数组（index 2147483648 **在长度之内**），`add /entries/2147483648` 仍被拒绝：**0.002–0.011 ms、1 条告警、`length` 不变**；同一索引在长度 100 的文档上结果完全相同 → 拒绝是**无条件 int32 上界判定、O(1)**，与文档长度无关。（按要求未在该稀疏数组上跑基准/`JSON.stringify`；V8 对 2^31 长度稀疏数组的 `slice` 是 O(length)。）

**③ root `replace /entries` 复杂度**：dev 下 `Object.freeze` 调用数 **1k = 2 次、10k = 2 次（恒定）**；数组外壳在 dev 冻结、prod 不冻结；`entries` 是新 `slice()`、元素全部按引用复用、输入 `value` 数组未被改写。元素本身**不再被递归冻结**——这是 §3.4 新写入的 root-replace 例外，实测 `Object.isFrozen(element)===false`，与契约文字一致（F7 的判据是"生产不冻结"，仍然通过；dev 侧"文档内全部对象冻结"的不变量**按契约收窄为"除 root replace 载荷元素外"**）。

**④ 规范大索引等价性**：12000 条文档上 `/entries/11999`（中间插入）与 `/entries/12000`（追加）与基准**全等**（均 12001 条、id 序列一致）；`/entries/12001` 两侧都失败；`replace /entries/11999` 全等、`replace /entries/12000` 两侧都失败。混合批次 `[replace /entries/1/content, add /entries/00]` 整批不落地、告警 1 次。

**⑤ 上一轮机制结论在新终点复跑**

| 项 | 6233c8ba（第一轮） | 647e108b（第二轮） |
|---|---|---|
| F2 `10k/1k` 中位比 / p90(10k) | 1.0 / ≤0.028 ms | **1.3 / ≤0.023 ms**（3/3 轮 valid） |
| F10 最差一轮改善 | ×2249.8 | **×2542.6** |
| 差分/ property（50,000 例） | 0 不一致 / 0 更宽松 | **0 不一致 / 0 更宽松**（D9 用例改判为"有意更严格"） |
| 引用不变量（1k/10k 各 21 条） | 全过 | **全过** |
| scratch 降级/缓冲测试 | 8/8 | **8/8** |
| 全量 web+shared | 62 文件 / 418 用例 | **62 文件 / 419 用例**（全过） |
| 生产构建 | 0 TS 错误 | **0 TS 错误** |
| 浏览器 A/B 等价（哈希/长度/行数/id） | 4/4 组全等 | **4/4 组全等** |
| 浏览器新路径 3k 单次阻塞 max / 帧 p95 / >50ms / LT | 0.2 ms / 16.7 ms / 0 / 0 | **0.1 ms / 16.8 ms / 0 / 0** |
| 同配置旧路径 | 97–134 ms / 83–117 ms / 59–60 / 60（4.6–6.5 s） | **114–231 ms / 100–167 ms / 59 / 60（5.5–6.2 s）** |
| DOM 受控（1k vs 3k，滚到底部） | 201 vs 184（8.5%） | **201 vs 184（8.5%）**，行数 28 vs 26 |
| §12 交互套件 | 0 失败 | **0 失败** |
| 真实 dsh 抓帧（隔离实例 + 生产 dist） | 3 会话 / 12 帧 / 0 违例 | **1 会话 / 4 帧 / 0 违例**（`add /sessionId`×1、`add /entries/{i}`×3）；页面 **0 告警 0 异常**、5,153 帧 avg 16.68 / p95 16.7 ms、2 次 Long Task（74 ms 面板挂载、56 ms 内容到达） |

**⑥ 一句话放行结论（覆盖两个终点）**：**能（有条件）** —— `db09d20c..647e108b` 可作为"会话进行中卡顿的 **store 归因部分** 已修复"的放行依据；条件同 §16.6（markdown 大 entry 一次渲染的 ~239 ms settle / 56 ms Long Task 属范围外，10k 为外推，E5 分配采样缺失），另加一条：**root replace 的元素不再递归冻结**（契约 §3.4 例外，dev 安全网在该路径上收窄，prod 行为不受影响）。

**产物（第二轮）**：`/tmp/at-p0-2/verify-node-incremental.json`、`verify-node-647e108b.json`（含 timing 合并）、`verify-node-6233c8ba.json`（第一轮留存）、`core-{prod,dev}-6233c8ba.mjs`（第一轮 bundle 归档）、`vitest-scratch-647e108b.log`、`vitest-full-647e108b.log`、`web-build-647e108b.log`、`chrome-results-{ab,domprobe,interactions}-647e108b.json`、`browser-summary-647e108b.json`、`patch-seq2{,-report}.json`、`final-page-metrics.json`、`real-dsh-session-final.png`。
