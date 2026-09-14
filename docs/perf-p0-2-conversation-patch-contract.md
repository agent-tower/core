# P0-2 规范：Conversation Patch 操作契约与不可变语义

> 目标读者：实现 P0-2（用结构化共享的 `applyConversationPatch` 取代 `fast-json-patch` 的全文档深拷贝）的工程师，以及逐条核对的审查者。
> 状态：**规范（§7 已裁定）**。本文只定义契约、必须支持的语义、兜底与验证口径，**不含实现**；§7 各条的裁定出处见 §7 开头。
> 基线：`fast-json-patch@3.1.1` 同时用于服务端重放（`packages/server/src/output/msg-store.ts:46`）和浏览器端应用（`packages/web/src/stores/session-log-store.ts:135`）。P0-2 只替换**浏览器端**这一处；服务端重放保持不变，因此本文的等价性基准就是 `fast-json-patch` 本身。
> 证据来源：仓库代码逐行核对（含 `grep` 全仓调用点），行号对应当前工作区。

---

## 0. 文档形状与硬约束

文档（conversation）：

```ts
interface NormalizedConversation {
  sessionId?: string
  entries: NormalizedEntry[]     // 有序数组，索引即身份
  seq?: number                   // 最后一个已应用的 patch seq
  isTruncated?: boolean          // 客户端本地标记，服务端从不设置
}
```

三条不可协商的硬约束：

1. **顺序语义**：一个批次内的 op 必须**严格按数组顺序依次执行**，不允许按 `path` 合并、去重或重排（`replace /entries/3/content` 之后再 `remove /entries/1`，与反过来执行结果不同）。
2. **不可变性**：应用后得到的 `next` 文档中，**所有被修改对象的整条父链都必须是新对象**；未涉及的子树必须保持**引用相等**（这是 P0-2 的唯一收益来源）。
3. **未知即降级**：任何未在 §1 明确支持范围内的 op/path，**不得猜测语义**，必须走权威 snapshot 重拉（`useNormalizedLogs` 已有的 reload 路径）+ 可观测告警。

---

## 1. 服务端实际会产生什么（可 emittable 集合）

全仓 grep（`pushPatch` / `conversation_patch` / `session:patch` / `{ op:` 字面量 / `applyPatch` / `ConversationPatch.*`）后，**当前代码只能产生 6 种 `(op, path)` 组合**，且**每个 patch 数组恰好只有一个 op**：

| # | op | path 模式 | value 类型 | 生成位置 |
|---|---|---|---|---|
| 1 | `add` | `/entries/{i}` | `NormalizedEntry` | `packages/server/src/output/utils/patch.ts:35-43`（`addNormalizedEntry`）；调用点：`codex-parser.ts:313,333,377,524,552,575,601`、`cursor-agent-parser.ts:551,557,690,715,756,782,806,851,874`、`claude-code-parser.ts:312,362,378,415,456,519,567,580,624,674,715,724,820`、`runtime/acp/projector.ts:97,117,186,215,228`、`services/session-manager.ts:2351` |
| 2 | `replace` | `/entries/{i}` | `NormalizedEntry` | `patch.ts:48-56`；`codex-parser.ts:370`、`cursor-agent-parser.ts:752`、`claude-code-parser.ts:306,357,373,446,562`、`projector.ts:182,211,224` |
| 3 | `replace` | `/entries/{i}/content` | `string`（**累计全文**，不是 delta） | `patch.ts:61-69`；`codex-parser.ts:507,546,562`、`cursor-agent-parser.ts:774,798,944`、`claude-code-parser.ts:420,664,730,763,767`、`projector.ts:109` |
| 4 | `replace` | `/entries/{i}/metadata/status` | `ToolStatus` | `patch.ts:74-82`；`codex-parser.ts:344`、`cursor-agent-parser.ts:879`、`claude-code-parser.ts:638` |
| 5 | `add` | `/sessionId` | `string`（根级对象成员 upsert） | `patch.ts:87-95`；`codex-parser.ts:235`、`cursor-agent-parser.ts:625`、`claude-code-parser.ts:283`、`runtime/acp/acp-driver.ts:644` |
| 6 | `replace` | `/entries`（**根级整数组**） | `NormalizedEntry[]` | **仅** `runtime/acp/acp-driver.ts:678`（`reconcileLoadedHistory`），值来自 `runtime/acp/history-reconciler.ts` 的 `mergedEntries` |

**不会产生**（已核实）：

- `remove`：`removeEntry`（`patch.ts:100-107`）全仓**零调用点**（仅定义、聚合对象 `patch.ts:125`、re-export `output/index.ts:20`）。`useNormalizedLogs.ts:130` 的 `patchTouchesAgentOutput` 虽显式处理 `op === 'remove'`，但那只是历史兼容分支，**不代表 P0-2 支持 remove**（见 §7-D2）。
- `move` / `copy` / `test`：**全仓零产生点**（server、CLI、测试、fixture 都没有），只存在于共享类型联合 `packages/shared/src/socket/events.ts:124` 和 `packages/server/src/output/types.ts:8`。
- 数组 `"-"` append（`add /entries/-`）：**当前服务端不产生**，§1 六种组合中不含该路径。
- **多 op 批次**：`mergePatches`（`patch.ts:112-114`）零调用点；当前所有 patch 数组长度恒为 1。

> 结论：实现**必须支持** §1 的 6 种组合。`remove`、`move/copy/test`、数组 `"-"` append 都属于"契约允许、当前零产生点"，**最终裁定为不实现**：遇到即整批降级 + 结构化告警（§4；§7-D2 / D3 / D8）。这是**有意的范围裁剪，不是遗漏**，必须在代码注释中写明；其依据是"只覆盖服务端当前真实的产生集合"，避免为假想需求扩大实现面。

---

## 2. 每个 op 的顺序语义（支持集合必须逐条对齐 `fast-json-patch@3.1.1`）

下表中的"基准行为"是 `fast-json-patch` 的实际实现（`dist/fast-json-patch.js`）按仓库实际调用 `applyPatch(doc, patch, true, false)` 的表现，不是 RFC 的理想描述；**等价性测试以基准行为为准**。故意不实现、只走降级的 op/path（§7-D2/D3/D8/D9）登记在 §5.1 的**有意分歧清单**里。

### 2.1 `add /entries/{i}`（数组插入）

- 基准行为：`arr.splice(i, 0, value)` —— **在 i 处插入**，`i` 及之后的元素索引 +1。
- 边界（基准行为已按仓库实际调用 `applyPatch(doc, patch, true, false)` 实测；结论与早期文档的"截断追加"说法相反）：
  - `i === entries.length` → 追加（等于 `push`），基准成功。
  - `i > entries.length` → 基准**抛 `OPERATION_VALUE_OUT_OF_BOUNDS`**（`validateOperation=true`），**不是** JS `splice` 的"截断到末尾追加"。P0-2 一律 `ok=false` → 整批降级 + 结构化告警（§7-D4）。两侧都是失败，不构成等价性分歧。
  - `i < 0` 或非整数（实测 `/entries/-1`、`/entries/1.5`）→ 基准抛 `OPERATION_PATH_ILLEGAL_ARRAY_INDEX`；P0-2 视为**不支持 path**，走 §4 降级 + 告警。
  - **索引字面量规则（§7-D9 裁定）**：`add` 与 `replace` 共用同一解析，只接受**规范十进制**索引 `^(0|[1-9]\d*)$`，且必须是**可精确表示的安全整数**（`Number.isSafeInteger`）**且 ≤ `0x7fffffff`（int32 内）**。
    - 前导零写法（`/entries/00`、`/entries/007`）：基准校验用 `isInteger`、再用 `~~key` 规范化，因此在文档足够长时会成功插入到规范化后的索引（`/entries/00`→0；`/entries/007`→7，超长时才因越界失败）；P0-2 **拒绝** → 整批降级 + 告警。
    - 超出可精确表示范围或会被 `~~`（ToInt32）回绕的字面量（`/entries/4294967296`→0、`/entries/9007199254740991`→-1、`/entries/9007199254740992`→0）：基准会"成功"地把条目**静默插到错误位置**；P0-2 **拒绝** → 整批降级 + 重拉权威快照。
    - 上述两类均为**有意分歧**，登记在 §5.1；理由见 §7-D9。
  - 规范、可精确表示、且 `i <= entries.length` 的大索引（例如 12000 条文档的 `/entries/11999`）与基准**全等**；越界（`i > entries.length`）仍走 D4 降级。
  - `"-"`（数组 append）→ 基准成功（等价 `push`），但当前服务端零产生点，P0-2 **不支持** → 降级 + 告警（§7-D8）。这是**有意分歧**，登记在 §5.1。
- **同批次连续 add 的位移**：`[add /entries/5, add /entries/5]` 最终是两条新 entry，原来的第 5 条被挤到第 7 位。**禁止按 path 合并这两条 op。**

### 2.2 `replace /entries/{i}`（整条替换）

- 基准行为（实测）：`0 <= i < entries.length` 时是普通赋值 `obj[i] = value`；`i >= entries.length`（含 `i == length` 与 `"-"`）时，仓库实际调用 `applyPatch(doc, patch, true, false)` **抛 `OPERATION_PATH_UNRESOLVABLE`** —— 既不产生空洞，也不创建新元素。
- **裁定（§7-D1）**：越界 `replace /entries/{i}` 一律 **`ok=false` → 整批降级到权威 snapshot + 结构化告警**，不采用早期"赋值创建 / 对齐基准"的建议。依据：越界属于异常输入，按"未知即降级"统一处理；现有链路本来就是 catch 后重拉（`session-log-store.ts:135-150`），不需要新增绕过错误的特殊路径。
- 因此差分测试只需锁定两件事：同长度替换与基准**全等**；越界替换**两侧都失败**。

### 2.3 `replace /entries/{i}/content`（标量）

- 基准行为：`parent.content = value`；`parent` 必须存在，且**被替换的最终键 `content` 必须已存在且不为 `undefined`**，否则基准抛 `OPERATION_PATH_UNRESOLVABLE`（`fast-json-patch` 对路径片段做 `obj[key] === undefined` 校验，`null` 视为存在）→ 客户端链路 catch 后按失败处理（`ok=false`）→ `useNormalizedLogs.ts:301-309` 触发 snapshot 重拉。
- **实现必须保留"父链不存在 / 最终键缺失就失败"这一行为**（`packages/web/src/stores/conversation-patch.ts` 的 `entry.content === undefined` 判定）：`packages/web/src/stores/__tests__/session-log-store*.test.ts` 依赖失败→重拉路径。`content: null` 视同存在，与基准一致。

### 2.4 `replace /entries/{i}/metadata/status`（嵌套标量）

- 基准行为：`entries[i].metadata.status = value`；**`metadata` 与 `metadata.status` 都必须已存在且不为 `undefined`**，任一缺失基准抛 `OPERATION_PATH_UNRESOLVABLE`；P0-2 按 `ok=false`（`failed`）→ 重拉处理，不得新建 `metadata` 或 `status`。
- **注意**：这是当前唯一会改 `metadata` 的生产 op，也是"只 clone entry 会漏掉 metadata"这一审查意见的实证来源。见 §3.2。

### 2.5 `add /sessionId`（根级对象 upsert）

- 基准行为：对象成员 upsert —— 存在则覆盖，不存在则新增。
- 根级 `add` **不是数组插入**，实现必须区分"根级对象 add"与"`/entries/{i}` 数组 add"。

### 2.6 `replace /entries`（根级整数组替换）

- 基准行为：`doc.entries = value`（**整体替换引用**，不做逐条 merge）。
- 语义后果：`/entries` 之前的 op 若作用在旧数组上，其结果被整体丢弃；之后（同批次内）的 op 作用在新数组上。当前服务端这个 op 单独成批，但实现不得假设这一点。
- **此项是 §3 不可变语义的重点**：`value` 是服务端构造的新数组，客户端**必须把数组本身及其中所有 entry 视为只读**（见 §3.3）。

### 2.7 批次顺序与副作用

- 强制按 `patch[]` 顺序执行。
- 一个批次内允许多次修改同一数组（索引位移累积）。
- 不要求（也不允许）实现去做"同 path 覆盖前一条"这类优化：`dropStaleReplaces` 的"同 path 覆盖"是**服务端 MsgStore 的**日志压缩语义（`msg-store.ts:166-217`，仅按 path 字符串精确匹配、只对 `replace` 生效、且 `replace /entries` **不会**覆盖 `replace /entries/N/*`），与客户端 apply 语义**无关**，不得混用。

---

## 3. 不可变（structural sharing）语义

### 3.1 父链复制规则

对任一 op，命中的路径段（含数组本身与每个对象层级）都必须新建对象；未命中的兄弟节点保持引用相等。以 `replace /entries/7/metadata/status` 为例：

```
next = {
  ...conversation,                       // 顶层新对象
  entries: entries.slice(),              // 数组浅拷贝
}
entries[7] = {
  ...entries[7],                         // entry 新对象
  metadata: { ...entries[7].metadata, status: value },   // metadata 新对象 ← 关键
}
```

必须成立的引用断言（验收项，见 §5）：

- `next !== conversation`
- `next.entries !== conversation.entries`
- `next.entries[7] !== conversation.entries[7]`
- `next.entries[7].metadata !== conversation.entries[7].metadata`
- 对任意 `k !== 7`：`next.entries[k] === conversation.entries[k]`（**引用相等**，这是 memo 恢复的前提）
- `next.seq`/`next.isTruncated` 按调用方传入更新。

**反例（当前审查明确点名的风险）**：只做 `entries[i] = { ...entries[i] }` 而不复制 `metadata`，则新旧 entry 共享同一个 `metadata` 对象；后续 `replace /entries/{i}/metadata/status` 若在旧对象上原地写入，会**同时改写历史 entry**（即已经被 React 渲染、被 `useMemo` 缓存、被 `use-todos` 读取过的对象）。

### 3.2 为什么 `metadata` 必须单独处理

- `metadata` 是**嵌套且被下游按引用读取**的对象：
  - `packages/web/src/hooks/use-todos.ts:39` 直接返回 `entry.metadata.todos`；
  - `packages/shared/src/log-adapter.ts:231-232` 把 `metadata.toolContent` / `toolLocations` 按引用传给 `LogEntry`。
- 只要这些下游还按引用读，`metadata` 的父链复制就是**正确性要求**，不是优化。

### 3.3 `patch.value` 的所有权

- 服务端 `MsgStore.pushPatch` **不克隆** patch（只有重放路径 `applyStoredPatch` 会 `structuredClone`，`msg-store.ts:39-47`）。`replace /entries` 的 `value` 数组里混合了**服务端 MsgStore 缓存对象的引用**（`history-reconciler.ts:42,142` 复用本地 entry 引用）。
- 因此客户端**不得**把 `value` 对象直接塞进 store 后又被别处原地修改。实现要求：
  - `replace /entries/{i}` / `add /entries/{i}`：若直接使用 `value` 引用，必须在文档中声明"entry 对象此后视为冻结"；按 §7-D5 裁定，在开发/测试环境用 `Object.freeze` 递归冻结（见 §3.4）来强制这一约束，**生产关闭**。
  - `replace /entries`：**必须** `value.slice()`（新数组身份），entry 元素按"节点采纳"复用引用。dev/test 下**只浅冻新的数组外壳**，元素不递归冻结、也不逐元素冻结（见 §3.4 的 root-replace 例外）。
- 客户端目前**没有任何**原地写 `NormalizedEntry`/`metadata` 的代码（已 grep `.metadata.X =` / `.content =` / `Object.assign(entry` / `entries.push|splice|sort|reverse`，仅有的两处是只读别名）。所以冻结在开发环境不会误伤，只会把未来引入的误写变成显式错误。

### 3.4 开发/测试环境冻结策略（§7-D5 裁定）

裁定：**仅 dev/test 开启冻结，生产关闭**；粒度按时机分三档：

| 时机 | 粒度 | 实现 |
|---|---|---|
| 节点创建/采纳（`add /entries/{i}`、`replace /entries/{i}` 的 value；`content`/`status` 的新 entry 包装与 metadata） | **递归冻结该节点** | `freezeAdoptedInDev` / `freezeNode` |
| 快照入库（`session/load` 的权威 snapshot） | **递归冻结整份文档**（每会话一次，O(文档)） | `freezeConversationInDev` |
| 每次 patch / truncate **入库的新版本** | **仅浅冻**新根对象 + 新 `entries` 数组 | `freezeConversationWrapperInDev` / `withEntries` |

- **不得递归冻结 `prev` 文档**：每次 apply 深冻上一版本是 O(文档)/patch，正好抵消 P0-2 的收益。旧文档的节点在它自己入库或被采纳时已经冻结，浅冻新外壳即可维持"从入库文档可达的对象都已冻结"的不变量（三条 store 出口 `Object.isFrozen(getConversation())` 均为 true）。
- **`replace /entries` 的冻结例外（§7-D5 裁定）**：保留 `value.slice()` 生成新数组（§3.3 要求），但**只冻结新数组外壳**；`patch.value` 的元素按"节点采纳"复用引用，**不递归深冻、也不逐元素冻结**。理由：该路径是长历史 reconcile 的整表替换，逐元素递归冻结会退化为 O(文档)，正是 P0-2 要消除的 dev/test 卡顿。代价：只经由此路径进入、此前未被创建/快照冻结的新元素对象在 dev/test 下可能未冻结（来自 store 的旧元素仍保持冻结）；该代价由 `10k root replace` 复杂度用例锁定 —— 冻结调用数恒为 2（新数组 + 新根对象），与文档规模无关。
- 生产构建**不冻结**（`Object.freeze` 会让 V8 走慢路径，且与收益目标冲突）。
- 测试环境默认开启，用 `Object.isFrozen` + 写入断言覆盖 §3.1 的每条父链。
- **实测口径限定**：此前报告的 dev/test 附加代价（10k 档 store 路径约 200 µs）**只适用于"普通条目 patch"**（浅冻外壳 + 数组 + 被采纳节点）。root replace 在本次修订前会递归冻结整棵子树（O(文档)），现已改为上表的浅冻；快照入库仍是 O(文档)，但每会话只在 load 时发生一次，不计入每 patch 成本。

---

## 4. 兜底：未知 op/path 的降级契约

| 情形 | 行为 |
|---|---|
| `op ∈ {add, replace}` 且 `(op, path)` **精确匹配** §1 的 6 种模式之一，索引为规范、可精确表示，**且 ≤ `0x7fffffff`（int32 内）**，且在界内（`add /entries/{i}` 要求 `0 <= i <= entries.length`；`replace /entries/{i}` 要求 `0 <= i < entries.length`） | 正常应用 |
| `add` 索引非规范（前导零，如 `/entries/00`）、超出可精确表示范围（`!Number.isSafeInteger`，如 `/entries/9007199254740992`），**或安全但会被 `~~` 回绕（如 `2147483648`）** | **不支持** → 整批降级 + 告警（§7-D9；**有意分歧**见 §5.1：基准会经 `~~` 规范化/回绕后"成功"） |
| `replace` 索引非规范、超出可精确表示范围，**或安全但会被 `~~` 回绕（如 `2147483648`）** | **不支持** → 整批降级 + 告警（§7-D9；基准**只在原始指针片段查不到属性时**失败 → `OPERATION_PATH_UNRESOLVABLE`，此时与基准无分歧；**病态稀疏输入使原始指针片段可解析（未回绕的索引位置存在）时，基准会继续走到数组操作阶段并按 `~~` 回绕"成功"写入 `[-2147483648]`、原位置不变 → 属有意分歧（§5.1，更严格方向）**；P0-2 一律拒绝） |
| `replace /entries/{i}` 越界（`i >= entries.length`，含 `"-"`） | **不支持** → 整批降级 + 告警（§7-D1） |
| `add /entries/{len+k}`（k>0） | **不支持** → 整批降级 + 告警（§7-D4） |
| `add /entries/-`（数组 append） | **不支持** → 整批降级 + 告警（§7-D8；有意分歧见 §5.1） |
| `op === 'remove'`（任意 path，含 `/entries/{i}`） | **不支持** → 整批降级 + 告警（§7-D2；不再按 RFC `splice` 语义实现） |
| `op ∈ {move, copy, test}` | **不支持** → 降级（§7-D3，有意裁剪） |
| 基准可成功、但不在 §1 六种组合内的近似 `(op,path)`：`replace /sessionId`、`add /entries`、`add /entries/{i}/content`、`add /entries/{i}/metadata/status`、`replace /entries/{i}/metadata`、`replace /entries/{i}/metadata/{非 status}` 等 | **不支持** → 整批降级 + 告警（§5.1 有意分歧；基准对其中多数会直接赋值成功） |
| 任何其他 path（含 `/foo`、`/entries/{i}/unknown`、`/`） | **不支持** → 降级 |
| `replace /entries/{i}/content` 但 `entries[i]` 不存在，或**最终键 `content` 缺失 / 为 `undefined`** | 处理失败 → 降级（与基准的抛错→重拉一致；`null` 视为存在） |
| `replace /entries/{i}/metadata/status` 但 `entries[i]` / `metadata` / `status` 缺失或为 `undefined` | 处理失败 → 降级（同上） |
| 值形状**不做校验**：`replace /entries` 收到非数组、`content` 收到非字符串 | 按基准原样采纳（成功） |
| patch value 任意层级含 `undefined` | 处理失败 → 降级（与基准 `hasUndefined` 一致） |
| 整批中任意一条失败 | **整批丢弃**，不做部分应用（与 `fast-json-patch` 的 `applyPatch` 语义一致：它返回 `newDocument`，失败即返回 `false`，调用方不落地半成品） |

**匹配规则（裁定）**：实现按 `(op, path)` **精确匹配**——只有 §1 表中列出的六种组合、且索引满足 §2.1 的字面量规则时才应用；**清单外一律降级 + 结构化告警**，不得按 path 前缀或"看起来像"推断语义。

**全局失败语义（裁定）**：任一 op 未知或失败 → **整批不落地 + 重放权威 snapshot**（上表末行），避免部分应用造成状态分叉。

降级动作（**必须与现有 reload 路径一致**，不新增机制）：

1. `applyPatch` 返回 `false`；
2. `useNormalizedLogs.handlePatch`（`:301-309`）把 `snapshotLoadedRef` 置 false、清空 `pendingPatches`、调用 `loadSnapshotRef.current()`；
3. 期间到达的 patch 进入 `pendingPatches` 缓冲，快照到达后按 `seq` 连续性重放（`:487-516`）。
4. **缓冲重放适用同一规则**：重放使用同一个 `applyConversationPatch`；缓冲批次里出现不支持的 op/path 时，**同样触发上面的重拉流程并丢弃该批次**（不得静默跳过、不得只应用可识别部分），最终状态只来自权威 snapshot。

可观测告警（必须，且要能区分"预期内未知 op"和"实现 bug"）：

```ts
console.warn('[sessionLogStore] unsupported conversation patch op/path', { op, path })
```

- 生产环境**不抛异常**（抛异常会打断整条 socket handler）；但要通过告警计数暴露给后续打点。
- **明确禁止**的做法：静默忽略、按 path 猜测语义、按长度阈值截断、只应用"能识别的部分 op"。

---

## 5. 等价性验证（验收口径）

### 5.1 与 `fast-json-patch` 的差分测试（必须）

对同一 `(doc, patch)`，断言：

- `applyConversationPatch(doc, patch).ok === true` 时，`JSON.stringify(next) === JSON.stringify(applyPatch(doc, patch, true, false).newDocument)`；
- 反向：基准失败（返回 `false` 或抛错）时实现也必须失败（**不允许"比基准更宽松"**，否则会掩盖服务端 bug）；
- **有意分歧清单（只允许"更严格"方向）**：下列输入在基准下**会成功**（或产生与语义不符的结果），但 P0-2 按 §7 裁定**拒绝** → 必须断言 `ok === false` + 结构化告警，且**不与基准比较结果**：
  1. `remove`（任意 path）；
  2. `move` / `copy` / `test`；
  3. 数组 `add /entries/-`；
  4. **近似 `(op,path)` 组合**（基准可能成功但不在 §1 六种组合内）：`replace /sessionId`、`add /entries`、`add /entries/{i}/content`、`add /entries/{i}/metadata/status`、`replace /entries/{i}/metadata` 等；实现按 `(op,path)` **精确匹配**，清单外一律降级 + 告警；
  5. **非规范 `add` 索引**（前导零，如 `/entries/00`）：基准用 `~~key` 规范化后成功插入；P0-2 只接受规范索引；
  6. **超出可精确表示范围 / 会被 `~~`（ToInt32）回绕的 `add` 索引**（`4294967296`→0、`9007199254740991`→-1、`9007199254740992`→0）：基准会静默插到错误位置，P0-2 宁可整批降级并重拉权威快照（§7-D9）。
  除上述清单（以及 §4 表中基准本身也失败的越界/未知 path）外，成功路径必须与基准全等。
- 值形状**不做校验**：`replace /entries` 收到非数组、`replace /entries/{i}/content` 收到非字符串时按基准原样采纳；patch value 任意层级含 `undefined` 按基准 `hasUndefined` 规则拒绝（失败侧）。
- 引用断言（§3.1）：逐条 `===` 校验。

用例矩阵（**必须逐条覆盖**）：

| 用例 | 目的 |
|---|---|
| `add /entries/len` 追加 | 追加 |
| `add /entries/{中间}` | 索引位移（断言其后元素整体右移 1） |
| `add /entries/{len+3}` | 越界 add：必须 `ok=false` + 告警（D4；基准也失败，见 §2.1） |
| `add /entries/00` / `/entries/007`（前导零） | D9：**有意分歧**，`ok=false` + 告警（基准会成功） |
| `add /entries/4294967296`、`/entries/9007199254740991`、`/entries/9007199254740992` | D9：**有意分歧**，`ok=false` + 告警（基准经 `~~` 回绕后成功） |
| `add /entries/{规范、可精确表示、在界内的大索引}`（如 12000 条文档的 `/entries/11999`） | 与基准**全等** |
| 混合批次含非规范/超大 `add` 索引 | **整批不落地** + 恰好一条告警 |
| `replace /entries/{i}` | 同长度替换 |
| `replace /entries/{越界}` | D1：必须 `ok=false` + 告警（基准也抛错） |
| `replace /entries/{i}/content` | 标量替换 + 父链全复制 |
| `replace /entries/{i}/content` 且 `i` 越界 / `content` 键缺失或为 `undefined` | 失败 → `ok=false`（`null` 视为存在，与基准一致） |
| `replace /entries/{i}/metadata/status` | **metadata 父链复制**（断言旧 metadata 未被改写） |
| `replace /entries/{i}/metadata/status` 且 `metadata`/`status` 缺失 | 失败 → `ok=false`，不得新建 |
| `add /sessionId`（已存在 / 不存在） | 根级 upsert |
| `replace /entries`（根级整数组） | 整数组替换 + `value.slice()` |
| `replace /entries` 收到非数组 / `content` 收到非字符串 | 值形状不校验，按基准原样采纳 |
| `replace /entries` 于 1k 与 10k 文档 | 复杂度：冻结调用数恒为 2（外壳），不随文档规模增长（§3.4） |
| 同批次 `[replace /entries/2/content, add /entries/0]` | **顺序敏感**：先改后插，断言最终 `[0]` 是新 entry、`[3]` 是改过的 entry |
| 同批次 `[add /entries/0, replace /entries/2/content]` | 反向顺序，断言结果与上一条不同 |
| 同批次对同一数组连续 `add`（`remove` 不支持） | 位移累积 |
| `remove /entries/{i}` | D2：**不支持**，必须 `ok=false` + 告警 |
| `add /entries/-`（数组 append） | D8：**不支持**，必须 `ok=false` + 告警 |
| `move` / `copy` / `test` | 必须 `ok=false` + 告警 |
| 未知 path（`/entries/0/metadata/other`、`/nope`） | 必须 `ok=false` + 告警 |
| 多 op 批次中间一条失败 | 整批不落地 |

### 5.2 Property-based 测试（必须）

用随机生成器（建议 `fast-check`，仅在 devDependencies）覆盖：

- 随机 entries 长度（0..20）+ 随机 `NormalizedEntry`（含/不含 `metadata`，`metadata` 含/不含 `status`）；
- 随机 op 序列（1..8 条），op 覆盖 §1 支持的 6 种组合**与有意不支持的集合**（`remove` / `move` / `copy` / `test` / `add /entries/-` / 非规范或超大 `add` 索引），索引在 `[-1, len+2]` 内取（故意踩界内 / 界外边界）；
- 随机 value（同形状对象 / 字符串 / 数组）；
- 断言（支持集合）：与 `fast-json-patch` 结果**全等**（`JSON.stringify` 或深比较）；失败侧则断言降级；两者必须一致；
- 断言（不支持集合与越界索引）：实现必须 `ok === false` + 告警；**不与基准比较结果**（基准可能成功，见 §5.1 有意分歧清单）；
- 断言：任何成功路径下，所有未命中 entry 与其 `metadata` 的引用不变（`===`）。

生成器必须能产出**数组中间插入**、**界外索引（`len+k`）**、**连续批次**、**`-` 追加**、**根级 replace**、**未知 op/path**、**非规范索引（前导零）**与**超大/回绕索引变体**（`4294967296`、`9007199254740992` 等，固定清单，断言降级 + 告警且不与基准比较）。

关于 `-` 追加：RFC 6902 的 `add /entries/-` 是数组末尾追加，基准同样成功；但当前服务端不产生该路径，最终裁定为**不支持**（§7-D8）：整批降级 + 告警，并作为**有意分歧**在差分测试中断言 `ok === false`。未来服务端若要产生，需单独扩契约与测试。

### 5.3 回归测试（必须）

- `packages/web/src/stores/__tests__/session-log-store.test.ts`、`session-log-store-reconnect.test.ts`
- `packages/web/src/lib/socket/__tests__/useNormalizedLogs.reconnect.test.tsx`
- 新增：降级路径测试（未知 op → `ok=false` → 触发 reload；缓冲 patch 在快照后按 seq 重放）

---

## 6. "恢复 memo" 的前提（**不能由共享 patch 单独保证**）

P0-2 的收益分两部分，必须分开验收：

| 收益 | 充分条件 | 由谁保证 |
|---|---|---|
| store 侧去深拷贝（13–16 ms/patch → ~0.02 ms） | 结构化共享 apply | **P0-2 自身** |
| `LogStream` 各 `memo()` 边界重新生效（~15–20%） | ① apply 保持未改 entry 引用稳定；**② `normalizedEntriesToLogEntries` 也按 `NormalizedEntry` 引用缓存（`WeakMap<NormalizedEntry, LogEntry>`），否则每帧仍产出全量新 `LogEntry` 数组/对象，memo 依旧全失效** | ① 由 P0-2；**② 需要 adapter 改造，属于 P0-2 的配套项** |

因此：

- **adapter 引用稳定性必须列入 P0-2 的验收**（`packages/shared/src/log-adapter.ts:297-301` 目前是无条件 `map + filter`，每次都新建全部 `LogEntry`）。
- 只有在 ① ② 同时成立、且所有下游遵守 §3 的不可变约束时，"memo 恢复"才成立；**共享 patch 单独做不到**。
- 反过来说：若只做 P0-2 不做 adapter 缓存，P0-2 的收益就是"store 侧 ~500×"，React 侧几乎不降——这与 `bench e` 的结论一致，必须写进收益表，不能混算。

> **口径限定（dev/test）**：上表是**生产**（不冻结）口径。dev/test 下冻结附加代价的实测只适用于**普通条目 patch**（浅冻外壳 + 数组 + 被采纳节点）；`replace /entries` 与快照入库的粒度与代价见 §3.4（root replace 已收敛为 O(1) 外壳冻结，快照入库为每会话一次的 O(文档)）。

---

## 7. 已裁定（附裁定出处）

本节所有条目**均已裁定**，实现必须照此执行、审查按此核对。裁定出处（房间消息）：`dd70bd7c-ff28-4b33-a448-c51f8e2aaf7a`（审查工程师最终裁定，含 `fast-json-patch@3.1.1` 实测依据），并合并 `99cc7acd-d6a5-434f-b1b3-42b25575fb47`、`928b1b0e-39fc-4c74-a47e-c1e1952d5d58` 的阶段性更正（D2/D3 收窄为"不支持"）；D9 出自 `3956bcb8-ece7-48e8-ac6d-eba878675785`（负责人对 P0-2 增量审查的裁定）。

> **编号错位说明（防止再次误读）**：本表现有编号与早期编号存在错位 —— **现 D5 = 旧 D6**（dev/test 递归冻结），**现 D6 = 旧 D5**（`replace /entries` 的 `value` 元素深拷贝）。引用编号时必须同时写明主题，不得只写 D5/D6。

| 编号 | 问题 | 裁定 | 影响面 |
|---|---|---|---|
| D1 | `replace /entries/{越界}` 的行为 | **整批降级到权威 snapshot + 结构化告警**；不采用"赋值创建 / 对齐基准"（基准实测抛 `OPERATION_PATH_UNRESOLVABLE`，现有链路本就 catch 后重拉） | 与基准一致性（两侧都失败，无分歧） |
| D2 | `remove` 是否支持 | **不支持**：按未知 op 整批降级 + 告警；不实现 `splice` 删除 | 契约完整性（服务端零产生点，不为假想需求扩面） |
| D3 | `move/copy/test` 是否支持 | **不实现**：整批降级 + 告警；代码注释须注明是**有意裁剪** | 实现成本 vs 契约完整性 |
| D4 | `add /entries/{len+k}`（k>0）的行为 | **不按 `splice` 截断追加**：整批降级 + 告警（基准实测抛 `OPERATION_VALUE_OUT_OF_BOUNDS`） | 与基准一致性（两侧都失败） |
| D5 | dev/test 的冻结时机与粒度 | **做，但只在 dev/test，且按 §3.4 分档**：节点创建/采纳递归冻结、快照入库递归冻结、每次 patch/truncate 仅浅冻新根对象 + 新 entries 数组、`replace /entries` 仅浅冻数组外壳；**不得递归冻结 prev 文档**；**生产关闭** | 误写检出能力 vs 每 patch 成本 |
| D6 | `replace /entries` 的 `value` 元素是否也深拷贝 | **不深拷贝**：`value` 数组本身必须 `slice()`，元素按"节点采纳"复用引用（不递归深冻，见 §3.4 root-replace 例外） | 内存/正确性 |
| D7 | 告警是否需要计数打点（用于发现未知 op） | 本轮**保留结构化 `console.warn`**，不接新 telemetry；后续 observability 任务再接计数 | 可观测性 |
| D8 | 数组 `add /entries/-` append 是否支持（**反向缺项补齐**，早期 §7 无此行） | **不支持**：整批降级 + 告警；未来服务端若要产生需单独扩契约与测试 | 契约完整性 |
| D9 | `add` 的索引字面量范围（含与基准的 `~~` 回绕分歧） | **显式分歧**：`add` 与 `replace` 共用规范索引规则（`^(0\|[1-9]\d*)$` 且 `Number.isSafeInteger`，**且 ≤ `0x7fffffff`（int32 内）**）；前导零与超出可精确表示范围的索引一律整批降级 + 告警。**不复现**基准的 `~~`（ToInt32）回绕：`4294967296`→0、`9007199254740991`→-1、`9007199254740992`→0 会把条目静默插到错误位置，而拒绝只会让整批不落地并重拉权威快照（结果正确） | 与基准的有意分歧（更严格）+ 数据错位防护 |

**全局失败语义（裁定）**：任一 op 未知或失败 → **整批不落地 + 重放权威 snapshot**（§4 表末行），避免部分应用造成状态分叉。

---

## 8. 非目标（本次不涉及）

- 不改服务端 `MsgStore` 重放路径（`applyStoredPatch` 继续用 `fast-json-patch`）。
- 不改 patch 的产生端（`projector.ts` 仍下发累计全文；P1-1 才改增量）。
- 不改 `dropStaleReplaces`、不改 `session/load` reconcile（P1-2）。
- 不引入新的跨端类型：共享契约 `packages/shared/src/socket/events.ts:124` 保持原样；本规范是客户端对该契约的**子集实现 + 显式降级**。
