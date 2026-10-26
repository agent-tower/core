# 任务交接笔记：Codex 与 OpenClaw 实现调研

> 后续讨论已收敛为单个 Task.handoff 字段和两个精确编辑工具；当前实施方案见 [任务交接笔记](task-handoff-design.md)。本文保留调研时的方案取舍。

调研日期：2026-10-26。状态：需求讨论与设计建议，尚未实现功能。

用户已明确：以交接笔记为主，让另一个人或 AI 快速知道任务做过什么；右侧面板可查看、编辑，MCP 可供 AI 更新。

本次依据官方仓库的固定提交阅读源码和仓库内文档，没有运行上游产品做行为验收。以下区分源码事实与 Agent Tower 建议；功能开关、运行配置和发布版本仍会影响实际行为。

| 仓库 | 本次查看的提交 | 提交时间（UTC） |
| --- | --- | --- |
| openai/codex | `970111f6cb62cc02fe36a82ea7d71b37a2889c97` | 2026-10-23 18:50:54 |
| openclaw/openclaw | `a8771d6f51f53a30a25ca58d26c29b6854dcea10` | 2026-10-26 03:16:00 |

## 1. 对 Agent Tower 最有价值的结论

建议将产品入口命名为“交接笔记”，每个 Task 保存一份当前有效的 Markdown。任务描述保留目标和验收标准，会话日志保留详细过程，交接笔记负责提炼当前进展、已完成工作、关键决策、验证情况、问题和下一步。

值得借鉴的机制有四个：

1. Codex 本地压缩提示词中的交接摘要结构：明确为下一位 LLM 服务。
2. Codex 与 OpenClaw 的分层读取：短摘要先进入上下文，详细来源按需读取。
3. 源码中的证据约束：区分事实、提议、未完成和未验证，保留具体来源及适用范围。
4. OpenClaw 的写入保护：更新前核对原版本，保留可恢复内容，避免后台整理覆盖人工修改。

全文检索、向量索引、用户画像和跨项目长期记忆可以在存在相应需求后再演进。当前任务 ID 已经提供了精确的检索范围，首要问题是交接内容的质量、时效和可靠更新。

## 2. Codex：会话恢复、交接压缩和长期记忆是不同机制

### 2.1 原生会话恢复

`codex-rs/rollout/src/recorder.rs` 将会话 rollout 持久化为 JSONL，提供恢复既有文件和加载历史条目的路径。文件可以包含会话元数据、消息、工具相关内容和压缩记录。[C1]

这是继续同一个运行上下文的基础。它不能直接承担让人快速阅读、自由编辑、跨不同 Agent 接手的交接文档。

### 2.2 本地上下文压缩中的交接摘要

`codex-rs/prompts/templates/compact/prompt.md` 明确要求：

> Create a handoff summary for another LLM that will resume the task.

它要求摘要包含：

- 当前进展和关键决策。
- 重要上下文、约束及用户偏好。
- 剩余工作和清楚的下一步。
- 继续工作所需的数据、例子和引用。

`core/src/compact.rs` 的本地压缩路径会选择配置的压缩提示词或这个默认模板，并构建、保存压缩后的上下文。[C2][C3]

**可借鉴：** 这是与本需求最接近的内容结构。Agent Tower 可以把这种摘要变成显式、可编辑、任务级的交接笔记。

**适用边界：** 这是本地压缩路径的模板，不能据此推断所有远端压缩都执行相同提示词，也不能把运行时压缩结果当作已存在的独立任务文档。

### 2.3 后台长期记忆：提取与整理分开

源码还有独立的后台记忆流水线。[C4][C5][C6]

```text
符合条件的历史会话
  → Phase 1：逐会话提取
  → 保存逐会话摘要和来源
  → Phase 2：集中整理
  → 新会话使用的精简记忆摘要
```

启动入口会检查 ephemeral、MemoryTool 功能开关、是否为根 Agent，以及状态数据库是否可用。生成在后台异步执行。Phase 1 根据历史会话来源、时间范围、空闲时间及数量上限领取工作，使用租约协调并发；Phase 2 领取全局任务并串行整理共享记忆。

因此它不是“每次回答结束就立即覆盖一份记忆”。生成条件和后台处理时机影响新鲜度。

本次源码同时包含 V1 和 V2：`MemoryVersion` 的枚举默认值为 V1，但实际使用仍由配置与开关决定。[C7]

| 版本 | 主要产物和读取方式 |
| --- | --- |
| V1 | 包含 `raw_memories.md`、`rollout_summaries/`、`MEMORY.md`、`memory_summary.md` 等层次；短摘要用于启动上下文，详细记忆用于检索。 |
| V2 | 使用独立的 `memories_v2` 命名空间；逐会话摘要汇总为 `memory_summary.md`，保留准确的会话和来源指针。Phase 2 不再生成 V1 的 `raw_memories.md`。 |

读路径读取 `memory_summary.md`，应用 token 预算，再贡献给新线程上下文；启用与读取行为也受配置控制。[C8]

V2 提取提示词对交接质量特别有参考价值：[C9]

- 给用户真实要求、纠正、决策和约束较高权重。
- 区分用户的话、Agent 建议、假设和缺失的证据。
- 保留工作目录、分支、任务范围、结果和未解决问题。
- 不把“提出方案”写成“已经实现”，不凭空声称测试通过或用户已批准。
- 保留安全且具体的文件、命令、错误、PR 和文档引用。
- 单次任务要求保持其适用范围，避免变成适用于所有未来任务的偏好。

V2 整理模板还要求尊重用户修改，移除只有已删除来源支持的结论，避免从旧摘要中恢复用户已经纠正或删除的内容。其交互读路径对显式记忆修改采用追加 ad-hoc note、随后整理的方式。[C10][C11]

**对 Agent Tower 的启发：** 如果后续加入自动总结，应读取“当前交接笔记 + 新发生的会话事实”，保留人工纠正和来源；仅有自动生成能力，不能保证交接笔记准确。

核对时发现 `memories/README.md` 仍有旧的 `core/src/memories/` 路径描述，因此本报告的实现位置以实际 `memories/write` 和 `ext/memories` 源码为准。

## 3. OpenClaw：可编辑文件、分层记忆和受控整理

### 3.1 精简核心与过程记录分开

官方仓库文档将默认 memory-core 的记忆分为多个层次。[O1][O2]

| 内容 | 用途 |
| --- | --- |
| `MEMORY.md` | 精简、经过整理的长期事实和决策。 |
| `memory/YYYY-MM-DD.md` 等日期文件 | 工作中的观察、日常记录和会话材料。 |
| `USER.md` | 用户的稳定偏好和个人资料相关指令。 |
| `DREAMS.md` | 后台整理的记录，供人查看。 |

默认核心采用可检查、可编辑的 Markdown 文件；索引支持搜索。核心记忆受预算约束进入会话上下文，详细记录通常按需检索。概览还说明，裸 `/new` 或 `/reset` 的特定启动流程会加载近期日期笔记，因此不应笼统宣称日常记录从不进入启动上下文。

**可借鉴：** 人和 AI 共享同一份可读内容；当前结论保持精简，过程材料保留在详细来源中。

**需要按产品调整：** OpenClaw 的用户级、Agent workspace 级记忆范围比一个 Task 广。Agent Tower 应明确按 `taskId` 隔离，同一任务下的 Session/Workspace 共享交接笔记。

### 3.2 上下文压缩前补记忆

OpenClaw 有 pre-compaction memory flush：在上下文压力达到条件时，用额外的维护回合给 Agent 一次保存重要信息的机会。[O1][O3]

本次源码会检查 token/压缩周期状态，避免同一周期反复执行。默认文件型 flush 的写工具被限制为向日常笔记追加新内容；不同 memory provider 也可以提供自己的持久化工具。[O4]

官方文档说明维护回合使用私有会话副本，维护消息不进入后续用户回合，实际写入仍会保存。跳过或失败不会阻止压缩；只读工作区等条件会影响可执行的 flush 路径。[O1]

**可借鉴：** 趁上下文还完整时做检查点。

**不宜直接照搬的触发点：** Agent Tower 托管不同 CLI/ACP Agent，能否获得可靠的“即将压缩”事件要逐个适配器确认。第一版可以依赖 Tower 已拥有的会话与任务边界，以及 Agent 主动调用 MCP。

### 3.3 Reset hook 的能力需要准确理解

`session-memory` hook 在 `/new`、`/reset` 和自动 reset 边界保存离开会话的材料，默认截取最近 15 条用户/助手消息。[O5][O6]

处理器将捕获内容放进标题为 `Conversation Summary` 的文件段落。可选 LLM 调用用于生成文件名 slug；不能因此把整个 hook 描述为一次智能总结。捕获是保留材料，形成高质量交接笔记还需要整理。[O7]

### 3.4 后台整理与并发保护

本次版本的 memory-core 文档描述了默认开启、定时执行的 dreaming 整理机制；其他 memory provider 可以拥有不同路径。[O1][O2]

实际合并代码让模型选择 `added`、`merged`、`superseded` 等结构化操作，由宿主使用候选条目的内容构造结果，并进行校验。模型无需任意重写整份正文。[O8]

文件写入代码在提交前核对预期内容 hash，使用原子替换，并明确保留与外部编辑器之间仍可能存在的短暂竞争窗口；官方文档说明会保存可恢复的修改前内容。[O2][O9]

**对 Agent Tower 的启发：** 所有写入集中经过 Service 和数据库时，可以用 `expectedRevision` 在同一事务内检查并更新，比要求外部 Markdown 编辑器遵守同一把锁更直接。UI 草稿也需要与服务端版本分离，避免实时刷新冲掉正在编辑的文字。

## 4. 建议的 Agent Tower 第一版

### 产品形态

- 右侧入口：“交接笔记”。默认展示当前版本的 Markdown，支持编辑和保存。
- 一个 Task 一份，同任务不同 Session/Workspace 共享；子任务独立保存。
- 保存时间、修改来源、修订版本；支持查看历史和恢复。
- 增加“复制交接内容”，便于发给同事或粘贴到另一个 AI；导出 `.md` 可以按需要增加。
- Task 完成后继续可读，清理 Workspace 不删除交接笔记。归档、删除和编辑权限沿用任务生命周期规则。

### 内容模板

推荐一两分钟能够读完，以当前有效结论为主：

```markdown
## 当前状态
任务进行到了哪一步，哪些工作尚未完成。

## 已完成
具体改动、产出及重要验证结果。

## 关键决策与约束
选择了什么、原因是什么，以及仍然有效的用户要求。

## 未解决问题
阻塞、失败尝试、未验证的部分和需要确认的问题。

## 下一步
按优先级列出可直接执行的动作。

## 关键引用
相关会话、文件、提交、PR、文档和验证记录。
```

重要里程碑可以保留，但持续追加的大段日志应放回详细会话或后续的记录层。

### 数据与写入契约

建议独立的任务交接实体保存 `taskId`、`content`、`revision`、`updatedAt` 和服务端识别的修改来源；修订历史另存。正文为 Markdown，元数据由服务端维护。

页面和 MCP 共用同一个 Service。MCP 先提供读取和更新，例如：

```text
get_task_handoff(task_id?)
update_task_handoff(content, expected_revision, task_id?)
```

托管 Agent 省略任务 ID 时从经过验证的 Session 身份解析；显式 ID 仍要校验访问范围。并发冲突返回当前版本，要求读取后合并，不静默覆盖。

对于以交接笔记为主的产品，`append` 工具可以后续增加；初版重点是持续维护一份短的有效正文。若以后引入多 Agent 自动产生日志，应把“提交新事实”和“整理当前交接正文”分开。

### 读取与更新时机

新会话获得当前交接笔记及其版本；超出注入预算时明确告知内容不完整，并提供 MCP 读取入口。已有会话在笔记变化后于下一轮获得更新提示。

Agent 指引要求在完成阶段工作、形成关键决策或准备交接时更新笔记。正文明确区分已完成、未完成、已验证和待验证。历史记录是参考资料，最新用户要求和当前代码事实可以修正旧结论。

如果后续提供后台自动总结，应记录“总结覆盖到哪条会话记录”，而不仅是笔记保存时间。人工刚编辑过笔记，并不代表其已经覆盖最新执行进展。后台生成期间发生新编辑，应保留结果为待合并内容或重新生成，不能覆盖新版本。

### 自动化分阶段

| 阶段 | 建议范围 | 取舍 |
| --- | --- | --- |
| 第一版 | 人工编辑、MCP 更新、读取接入、修订历史与并发保护 | 先保证存下来的内容能可靠交给下一个人或 AI。 |
| 后续 | 用户触发“更新交接笔记”，再扩展到阶段结束后的后台补写 | 需要决定模型来源、费用、失败重试、来源覆盖范围，以及如何保留人工纠正。 |
| 有需求后 | 多任务搜索、项目级记忆、检索增强 | 解决跨任务知识复用；不影响先完成任务内交接。 |

当前仍需产品对齐的选择：AI 修改默认直接保存还是先出草稿；是否第一版包含单独的自动总结入口。用户已确认交接笔记定位，但尚未确认这两个自动化选择。

## 5. 与现有仓库的结合点

当前 Task 已有描述字段，Session 已有 `externalSessionId` 和 `logSnapshot`。新增交接正文应独立于原始需求和会话日志。

桌面 `TaskDetail` 已将任务级子任务面板传入 `WorkspacePanel`，可以复用这种任务级入口模式。移动端另有 `MobileTaskDetail`，应提供同一交接组件的入口。

后端沿用 shared 契约、Prisma、Service、REST、MCP HTTP client 的现有分层。正文按需加载，不进入看板列表；变更通知用于刷新可见内容，断线重连通过 REST 恢复。UI 编辑草稿不能被通知覆盖。

这份报告只提出方向，数据库字段、API 名称、自动化策略和交互细节均未作为已实施契约。

## 6. 固定版本来源

- [C1：Codex rollout 持久化与恢复][C1]
- [C2：Codex 本地压缩的交接提示词][C2]
- [C3：Codex 本地压缩实现][C3]
- [C4：Codex 记忆生成启动条件][C4]
- [C5：Codex Phase 1 会话提取][C5]
- [C6：Codex Phase 2 集中整理][C6]
- [C7：Codex 记忆版本与命名空间][C7]
- [C8：Codex 精简摘要读取与预算][C8]
- [C9：Codex V2 提取的事实与范围约束][C9]
- [C10：Codex V2 整理提示词][C10]
- [C11：Codex V2 读取和显式修改指引][C11]
- [O1：OpenClaw 记忆概览][O1]
- [O2：OpenClaw 记忆架构][O2]
- [O3：OpenClaw memory flush 触发判断][O3]
- [O4：OpenClaw flush 工具投影][O4]
- [O5：OpenClaw session-memory hook 文档][O5]
- [O6：OpenClaw reset 时捕获最近消息][O6]
- [O7：OpenClaw session-memory 文件写入与 slug 生成][O7]
- [O8：OpenClaw 结构化合并操作][O8]
- [O9：OpenClaw 内容版本检查与原子替换][O9]

[C1]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/rollout/src/recorder.rs
[C2]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/prompts/templates/compact/prompt.md
[C3]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/compact.rs
[C4]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/memories/write/src/start.rs
[C5]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/memories/write/src/phase1.rs
[C6]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/memories/write/src/phase2.rs
[C7]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/protocol/src/memory_version.rs
[C8]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/ext/memories/src/prompts.rs
[C9]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/memories/write/templates/memories/stage_one_system_v2.md
[C10]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/memories/write/templates/memories/consolidation_v2.md
[C11]: https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/ext/memories/templates/memories/read_path_v2.md
[O1]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/docs/concepts/memory.md
[O2]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/docs/concepts/memory-architecture.md
[O3]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/src/auto-reply/reply/memory-flush.ts
[O4]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/src/agents/agent-tools.memory-flush.ts
[O5]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/src/hooks/bundled/session-memory/HOOK.md
[O6]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/src/hooks/bundled/session-memory/capture.ts
[O7]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/src/hooks/bundled/session-memory/handler.ts
[O8]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/extensions/memory-core/src/dreaming-consolidation.ts
[O9]: https://github.com/openclaw/openclaw/blob/a8771d6f51f53a30a25ca58d26c29b6854dcea10/extensions/memory-core/src/short-term-promotion-memory-write.ts
