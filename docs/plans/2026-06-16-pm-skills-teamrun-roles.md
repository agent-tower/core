# pm-skills 项目分析与 TeamRun 角色提取草案

## 背景与范围

本文分析外部项目 `/Users/shitian/Work/shitian/github/pm-skills`，并结合 Agent Tower 当前 TeamRun 模式，讨论可从其中提取的新团队角色、角色边界与落地优先级。

本次只做文档分析，不修改 `pm-skills` 外部项目，不改 Agent Tower 业务代码，不实现角色系统。

主要读取来源：

- `pm-skills/README.md`
- `pm-skills/CLAUDE.md`
- `pm-skills/.claude-plugin/marketplace.json`
- 9 个插件目录下的 `README.md` 与 `.claude-plugin/plugin.json`
- 抽样读取各插件 `commands/*.md` 与关键 `skills/*/SKILL.md`
- Agent Tower 的 TeamRun 类型、计划文档与现有角色 prompt：
  - `packages/shared/src/types.ts`
  - `docs/plans/2026-05-15-agent-team-collaboration.md`
  - `docs/plans/2026-05-18-agent-team-collaboration-implementation.md`
  - `docs/prompt/v1.2/team-room-*.md`

## pm-skills 项目结构概览

`pm-skills` 是一个 PM 技能 marketplace，不是传统应用代码库。它用插件、技能和命令组织产品管理方法论。

```text
pm-skills/
├── .claude-plugin/marketplace.json
├── README.md
├── CLAUDE.md
├── AGENTS.md
├── CONTRIBUTING.md
├── LICENSE
├── validate_plugins.py
├── .docs/images/
└── pm-{domain}/
    ├── .claude-plugin/plugin.json
    ├── README.md
    ├── skills/{skill}/SKILL.md
    └── commands/{command}.md
```

核心机制：

- **Marketplace**：根目录 `marketplace.json` 列出 9 个插件，统一版本为 `2.0.0`。
- **Plugin**：每个 `pm-*` 目录是一个独立安装包，覆盖一个 PM 领域。
- **Skill**：稳定的领域知识、框架、模板或分析方法。项目规则中将它们定义为“名词/概念”。
- **Command**：用户触发的端到端工作流。项目规则中将它们定义为“动词/流程”，通常串联多个 skills。
- **Validator**：`validate_plugins.py` 检查 manifest、frontmatter、README 和插件内引用一致性。

### 插件与内容规模

| 插件 | 技能数 | 命令数 | 主要内容 |
|---|---:|---:|---|
| `pm-product-discovery` | 13 | 5 | 创意、假设识别、实验设计、功能请求分析、访谈脚本和访谈总结、指标面板 |
| `pm-product-strategy` | 12 | 5 | 产品战略、愿景、价值主张、商业模式、定价、SWOT、PESTLE、Ansoff、Porter 五力 |
| `pm-execution` | 16 | 11 | PRD、OKR、路线图、Sprint、复盘、发布说明、利益相关方、用户故事、预演和红队 |
| `pm-market-research` | 7 | 3 | 用户画像、细分、竞品分析、市场规模、情绪分析、客户旅程 |
| `pm-data-analytics` | 3 | 3 | SQL 查询、A/B 测试分析、留存和 cohort 分析 |
| `pm-go-to-market` | 6 | 3 | GTM 策略、增长循环、GTM motion、beachhead segment、ICP、battlecard |
| `pm-marketing-growth` | 5 | 2 | 营销创意、价值主张文案、North Star Metric、命名、定位 |
| `pm-toolkit` | 4 | 5 | 简历、NDA、隐私政策、语法和逻辑校对 |
| `pm-ai-shipping` | 2 | 5 | AI 构建应用的文档化、意图与实现差异审计、安全/性能审计、测试覆盖图、shipping packet |

根 README 声称总量为 68 个 skills 和 42 个 commands。用目录计数复核结果也匹配该规模。

## pm-skills 体现出的能力模型

`pm-skills` 的价值不在“让 AI 写更多文字”，而在把 PM 工作拆成可复用、可审计、可交接的结构化工作流。

可以抽象为以下能力模型：

1. **从模糊问题到结构化定义**
   - 典型产物：PRD、产品战略、价值主张、用户故事、路线图。
   - 关键做法：先问背景和约束，再套用框架输出可讨论的文档。

2. **从想法到假设与实验**
   - 典型产物：机会树、风险假设清单、Impact x Risk 矩阵、实验计划。
   - 关键做法：不急着实现，先识别最可能让方案失败的假设。

3. **从用户和市场信号到判断**
   - 典型产物：用户画像、市场细分、竞品比较、市场规模估算、反馈主题和情绪分析。
   - 关键做法：把定性材料结构化，明确证据、假设和不足。

4. **从数据请求到可解释分析**
   - 典型产物：SQL、A/B 测试结论、cohort 报告、指标定义。
   - 关键做法：明确指标定义、口径、时间范围、schema 假设和边界。

5. **从方案到跨职能执行**
   - 典型产物：Sprint 计划、release notes、stakeholder map、action items、pre-mortem。
   - 关键做法：把目标、容量、依赖、风险、沟通对象和验收标准放在同一张图里。

6. **从产品完成到上市和增长**
   - 典型产物：GTM 策略、ICP、beachhead segment、growth loops、battlecard、定位和命名。
   - 关键做法：把目标客户、渠道、信息、竞争和增长机制连接起来。

7. **从 AI 写出的代码到可审查交付**
   - 典型产物：系统文档、权限矩阵、测试覆盖图、安全/性能审计、shipping packet。
   - 关键做法：先记录系统意图，再对照代码实现，区分已验证、建议验证和未验证缺口。

这些能力可以直接补足 TeamRun 当前偏工程执行的角色结构。当前角色更像“做、审、测、调度”，而 `pm-skills` 提供的是“定义为什么做、做什么、是否值得做、怎么发布、怎么证明可交付”。

## Agent Tower TeamRun 当前模型要点

当前 TeamRun 不是固定角色系统，而是运行时团队协作模型：

- `MemberPreset` 是可复用成员预设，包含 `rolePrompt`、provider、能力、触发和工作区策略。
- 创建 TeamRun 时，preset 会复制成 `TeamMember` 快照，后续修改 preset 不影响历史 TeamRun。
- `TeamRun` 通过 RoomMessage、StructuredMention、WorkRequest、AgentInvocation 协作。
- 成员能力由 `TeamMemberCapabilities` 控制，主要包括读房间、发消息、提及成员、停止成员、读写文件、运行命令、读 diff、合并工作区等。
- `workspacePolicy` 定义成员在哪里工作：
  - `none`：产品语义上不需要读写代码工作区，适合负责人、规划、讨论、总结类角色。当前 scheduler 对 `none` 和 `shared` 这类非 `dedicated` 成员仍会使用 TeamRun shared workspace 启动 session，给 Agent CLI 提供 cwd；但 lock service 只会让 `workspacePolicy: shared` 成员参与 shared workspace 的写/命令锁。因此后续写角色配置时，`none` 角色不要授予 `writeFiles` / `runCommands`；如果角色需要读取 repo、docs、schema 或 diff，应改用 `shared + readFiles`。
  - `shared`：使用 TeamRun 共享 workspace，适合实现、审查、测试、文档分析。
  - `dedicated`：成员独立 workspace，适合未来并行开发；当前落地需谨慎。
- `triggerPolicy` 定义触发方式：
  - `USER_MESSAGES`：监听用户未 @ 的普通消息。适合唯一负责人或少数调度角色。
  - `MENTION_ONLY`：只有被结构化 @ 时工作。适合大多数专业角色。
- `sessionPolicy` 支持 `new_per_request` 和 `resume_last`。
- `queueManagementPolicy` 默认应保持 `own_only`，只有负责人/调度类角色才适合考虑 `team_pending`。

因此，从 `pm-skills` 提取角色时，应按稳定职责提取为 `MemberPreset`，而不是把每个 skill 或 command 都变成一个成员。Skill 更适合作为角色 prompt 内部的知识模块，command 更适合作为该角色的典型工作方式或任务模板。

## 角色提取原则

1. **按责任边界聚合，不按文件数拆分**
   - 不建议创建 68 个技能角色。
   - 一个角色应承担一个稳定的跨任务责任，例如“产品发现”“产品战略”“数据分析”。

2. **默认 Mention Only**
   - 除负责人外，多数 PM 专家不应监听所有用户消息。
   - 避免多个角色同时响应同一用户消息造成房间噪音和循环。

3. **纯分析角色默认不写代码**
   - PM、研究、策略、GTM 类角色若只做房间内讨论和文档推理，使用 `workspacePolicy: none`。
   - 角色只要需要读取仓库内容，就使用 `shared + readFiles`，不要用 `none + readFiles` 这种容易误解的配置。
   - 只有明确要求写文档、更新 docs 或生成测试数据时，才开启 `writeFiles`。

4. **高风险领域不授予最终决策权**
   - 法务、隐私、安全、发布等角色只能产出建议、风险和需人工确认项。
   - 不应让它们独立合并、发布或代表用户做法律结论。

5. **优先补齐当前工程团队缺口**
   - 当前已有 Leader、Implementer、Reviewer、E2E Tester。
   - 最有价值的新角色应优先覆盖“需求定义、产品判断、上线准备、证据化验证”。

## 可提取的新角色清单

### 1. 产品战略负责人 / Product Strategy Lead

来源插件：

- `pm-product-strategy`
- 部分 `pm-marketing-growth` 的 North Star Metric 和 positioning 内容

职责边界：

- 明确产品方向、目标用户、价值主张、战略取舍和成功指标。
- 产出产品战略画布、愿景、价值主张、商业模式、定价假设和市场扫描。
- 帮 Leader 判断一个需求是否符合当前产品方向，以及哪些内容应明确不做。

触发方式：

- 默认 `MENTION_ONLY`。
- 在“产品策略团队模板”中可以作为用户消息监听者，但同一 TeamRun 中不应同时有多个 `USER_MESSAGES` PM 角色。

典型输入：

- 用户的产品想法、目标市场、现有 PRD、路线图、竞品描述、商业约束。

典型输出：

- 产品战略摘要。
- 目标用户与不服务用户。
- 价值主张和关键 trade-off。
- 成功指标和战略风险。
- 推荐后续派给 Discovery、Execution PM 或 GTM 角色的工作。

协作对象：

- Leader：接收用户目标并反馈需要用户决策的战略取舍。
- Product Discovery Researcher：把战略假设转成验证实验。
- Product Execution PM：把战略结论转成 PRD、roadmap 和 stories。
- GTM Strategist：把定位和目标细分转成上市路径。

适合处理：

- 新产品方向讨论。
- 产品线调整。
- 定价和商业模式初稿。
- “这个需求是否值得做”的判断。

不适合处理：

- 直接写代码。
- 做最终商业决策。
- 在缺少市场/用户证据时把假设包装成结论。

建议 TeamMember 配置：

- `workspacePolicy: none`；需要读取仓库文档时改用 `shared + readFiles`。
- `capabilities`: `readRoom`, `postRoomMessage`, `mentionMembers`；切到 `shared` 时再增加 `readFiles`。
- `sessionPolicy: resume_last`，适合保持长期产品上下文。
- `queueManagementPolicy: own_only`。

落地优先级：P1。它能显著减少“用户给一句模糊需求，工程师直接开工”的风险。

### 2. 产品发现研究员 / Product Discovery Researcher

来源插件：

- `pm-product-discovery`
- 部分 `pm-market-research`

职责边界：

- 把机会、想法、反馈和功能请求转成可验证的问题。
- 识别关键假设，按风险和影响排序，设计轻量实验。
- 准备客户访谈脚本，或把访谈材料整理成 JTBD、满意/不满信号和行动项。

触发方式：

- `MENTION_ONLY`。
- 通常由 Leader、Product Strategy Lead 或 Product Execution PM 派活。

典型输入：

- 用户想法、功能请求列表、客户反馈、访谈记录、现有产品目标。

典型输出：

- 假设清单。
- Impact x Risk 优先级矩阵。
- 实验计划。
- 访谈脚本或访谈总结。
- Opportunity Solution Tree。

协作对象：

- Product Strategy Lead：承接战略方向和目标用户。
- Market Research Analyst：补充市场和竞品证据。
- Product Execution PM：把已验证或高优先级机会转成 PRD。
- Data Analyst：定义实验指标和数据口径。

适合处理：

- 需求发现。
- 功能请求 triage。
- 早期产品和新功能验证。
- 访谈准备和访谈后整理。

不适合处理：

- 替用户做最终产品优先级承诺。
- 写生产代码。
- 在没有用户材料时虚构研究结论。

建议 TeamMember 配置：

- `workspacePolicy: none`；需要读取 issue、docs、反馈文件时改用 `shared + readFiles`。
- `capabilities`: `readRoom`, `postRoomMessage`, `mentionMembers`；切到 `shared` 时再增加 `readFiles`。
- `sessionPolicy: resume_last` 或 `new_per_request`，视项目连续性决定。

落地优先级：P1。它适合在实现前介入，补齐“发现和验证”环节。

### 3. 产品执行 PM / Product Execution PM

来源插件：

- `pm-execution`

职责边界：

- 把战略、发现和用户需求转成工程团队可以执行的文档和计划。
- 产出 PRD、用户故事、job stories、WWA、验收标准、路线图、OKR、Sprint 计划、stakeholder map。
- 帮 Leader 将用户需求拆成可派给 Implementer、Reviewer、Tester 的工作。

触发方式：

- `MENTION_ONLY`。
- 在“产品交付团队模板”中可以成为 Leader 之后的第一位专业角色。

典型输入：

- 用户需求、产品战略摘要、发现研究结果、业务约束、设计材料、已有 tickets。

典型输出：

- PRD 草案。
- 验收标准和用户故事。
- 开发范围和非目标范围。
- 风险、依赖和开放问题。
- 给实现工程师的派活建议。

协作对象：

- Leader：把用户目标变成可调度任务。
- UI Designer：补充界面和交互方案。
- Implementer：提供清晰的实现范围和验收标准。
- Reviewer/E2E Tester：提供审查和测试依据。

适合处理：

- “帮我把这个需求整理清楚”。
- 实现前需求澄清。
- 从会议、想法或反馈生成可执行任务。
- 发布说明和 stakeholder update 初稿。

不适合处理：

- 代替 Implementer 做技术实现。
- 代替 Reviewer 判定代码质量。
- 代替用户拍板产品范围。

建议 TeamMember 配置：

- `workspacePolicy: shared`，因为经常需要读已有 docs、代码结构或任务上下文；默认不写文件，除非任务明确要求写 docs。
- `capabilities`: `readRoom`, `postRoomMessage`, `mentionMembers`, `readFiles`, 可选 `writeFiles`。
- `sessionPolicy: resume_last`。

落地优先级：P1。它与现有 Implementer/Reviewer/Tester 衔接最直接。

### 4. 产品风险红队 / Product Risk Red-Teamer

来源插件：

- `pm-execution` 的 `pre-mortem`、`strategy-red-team`
- `pm-product-discovery` 的 assumption prioritization

职责边界：

- 攻击 PRD、路线图、战略或上线计划中的承重假设。
- 找出失败模式、最便宜的验证方法、kill criteria 和缓解策略。
- 关注产品、市场、执行、数据和组织风险，不做完整代码审查。

触发方式：

- `MENTION_ONLY`。
- 应在 PRD/策略定稿前，或关键实现开工前被 Leader 派活。

典型输入：

- PRD、路线图、战略文档、上线计划、实验计划。

典型输出：

- 风险清单。
- 承重假设排序。
- 最小验证实验。
- kill criteria。
- 需要用户或负责人决策的问题。

协作对象：

- Product Strategy Lead：挑战战略假设。
- Product Execution PM：补充 PRD 的风险和非目标。
- Reviewer：当风险涉及实现契约时，把问题交给代码审查。
- E2E Tester：把高风险路径转成测试重点。

适合处理：

- 重大需求开工前。
- 发布前 pre-mortem。
- 路线图或策略复核。

不适合处理：

- 做代码 diff 审查。
- 把所有理论风险都升级为阻塞。
- 在没有证据时制造泛泛担忧。

建议 TeamMember 配置：

- `workspacePolicy: none`；需要读取 PRD、路线图或代码相关材料时改用 `shared + readFiles`。
- `capabilities`: `readRoom`, `postRoomMessage`, `mentionMembers`；切到 `shared` 时再按任务需要增加 `readFiles` / `readDiff`。
- `sessionPolicy: new_per_request`，保持每次红队独立判断。

落地优先级：P2。它很有价值，但第一批 P1 应保持为 4 个核心角色；风险红队能力先并入 Product Execution PM 的 prompt，等使用频率高后再拆成独立 preset。

### 5. 市场研究分析师 / Market Research Analyst

来源插件：

- `pm-market-research`
- 部分 `pm-product-strategy` 的 market scan

职责边界：

- 研究用户群体、市场细分、竞品、市场规模和客户旅程。
- 对输入材料做结构化分析，明确证据、假设和不确定性。
- 为 Strategy、Discovery、GTM 提供外部市场视角。

触发方式：

- `MENTION_ONLY`。

典型输入：

- 用户反馈、访谈材料、竞品列表、市场描述、公开资料摘要、用户提供的数据文件。

典型输出：

- 用户画像。
- 市场细分。
- 竞品比较。
- TAM/SAM/SOM 或市场规模估算。
- 客户旅程图。
- 情绪和主题分析。

协作对象：

- Product Strategy Lead：提供市场和竞品证据。
- Product Discovery Researcher：帮助选择访谈对象和机会区域。
- GTM Strategist：输出 ICP 和 beachhead segment 的输入。

适合处理：

- “帮我分析这个市场/竞品/用户群”。
- 用户反馈批量整理。
- 进入新市场前的初步判断。

不适合处理：

- 需要实时外部数据且未授权联网或未给来源的精确市场结论。
- 直接决定产品路线。
- 编造引用、规模或用户证据。

建议 TeamMember 配置：

- `workspacePolicy: none`；读取本地资料时改用 `shared + readFiles`。
- `capabilities`: `readRoom`, `postRoomMessage`, `mentionMembers`；切到 `shared` 时再增加 `readFiles`。
- 若需要联网研究，应在成员 prompt 中要求来源标注和不确定性说明。

落地优先级：P2。适合产品探索和市场侧任务，但对纯工程任务不是必需。

### 6. 产品数据分析师 / Product Data Analyst

来源插件：

- `pm-data-analytics`
- `pm-product-discovery` 的 metrics dashboard
- `pm-marketing-growth` 的 North Star Metric

职责边界：

- 定义指标口径，生成 SQL，分析 A/B 测试和 cohort/retention。
- 解释数据结论的限制、假设、样本量和可能偏差。
- 帮 Discovery、Execution、GTM 把判断转成可测量指标。

触发方式：

- `MENTION_ONLY`。

典型输入：

- 数据问题、schema、样例数据、指标定义、实验结果、事件表说明。

典型输出：

- SQL 查询。
- 指标定义和口径假设。
- A/B 测试结论。
- cohort/retention 报告。
- 仪表板指标建议。

协作对象：

- Product Discovery Researcher：设计实验指标。
- Product Strategy Lead：定义 North Star 和 input metrics。
- Product Execution PM：为 PRD 增加可验证成功指标。
- E2E Tester：需要测试数据或验证数据路径时协作。

适合处理：

- 写分析 SQL。
- 解释 A/B test 或 cohort。
- 设计产品指标面板。

不适合处理：

- 默认连接生产数据库。
- 运行会修改数据的 SQL。
- 在 schema 不明确时假装查询一定正确。

建议 TeamMember 配置：

- `workspacePolicy: shared`，通常需要读取 schema、迁移、数据模型或本地样例。
- `capabilities`: `readRoom`, `postRoomMessage`, `readFiles`, 可选 `runCommands`。
- `writeFiles` 默认关闭；仅在需要提交 `.sql` 或 docs 时开启。
- prompt 中应明确只读 SQL、安全限制和 schema 假设披露。

落地优先级：P2。对数据驱动产品和增长任务非常有用，但需要严格权限边界。

### 7. GTM 策略师 / Go-To-Market Strategist

来源插件：

- `pm-go-to-market`
- 部分 `pm-market-research`
- 部分 `pm-marketing-growth`

职责边界：

- 设计上市路径、ICP、beachhead segment、渠道、信息、GTM motion 和 battlecard。
- 把产品定位转成可执行的 launch plan。

触发方式：

- `MENTION_ONLY`。

典型输入：

- 产品描述、目标客户、战略文档、竞品、价格、上线时间、销售或增长约束。

典型输出：

- GTM 策略。
- ICP。
- beachhead segment。
- 渠道和信息计划。
- 竞品 battlecard。
- Launch checklist。

协作对象：

- Product Strategy Lead：承接定位、目标用户和商业模式。
- Market Research Analyst：补充市场和竞品证据。
- Product Marketing/Growth Strategist：将 GTM 转成具体文案和增长实验。
- Release Communications Writer：发布说明和对外沟通。

适合处理：

- 新功能或新产品上市。
- 销售 enablement 初稿。
- 增长策略方向。

不适合处理：

- 替代真实销售、法务或品牌审批。
- 在没有客户/渠道信息时给出过度确定的计划。

建议 TeamMember 配置：

- `workspacePolicy: none`；需要读取产品文档、竞品资料或仓库内容时改用 `shared + readFiles`。
- `capabilities`: `readRoom`, `postRoomMessage`, `mentionMembers`；切到 `shared` 时再增加 `readFiles`。
- `sessionPolicy: resume_last` 适合长期上市项目。

落地优先级：P2/P3。适合 Agent Tower 后续支持产品、营销、发布团队模板时加入。

### 8. 产品营销与增长策略师 / Product Marketing & Growth Strategist

来源插件：

- `pm-marketing-growth`
- 部分 `pm-go-to-market`
- 部分 `pm-product-strategy` 的 value proposition

职责边界：

- 生成定位、命名、营销创意、价值主张文案、North Star Metric 和增长输入指标。
- 强调“用户为什么关心”和“如何表达”，不是负责实现或投放。

触发方式：

- `MENTION_ONLY`。

典型输入：

- 产品描述、目标客户、价值主张、竞品、品牌语气、增长目标。

典型输出：

- 定位方向。
- 产品命名候选。
- 营销创意。
- 多场景 value prop statements。
- North Star Metric 和 input metrics。

协作对象：

- Product Strategy Lead：确保定位符合战略。
- GTM Strategist：把文案和定位放入上市计划。
- UI Designer：需要落地到页面或营销界面时协作。

适合处理：

- 命名和定位 brainstorming。
- 价值主张文案。
- 增长指标讨论。

不适合处理：

- 直接改产品代码或页面。
- 代替品牌负责人做最终命名。
- 编造品牌资产或用户承诺。

建议 TeamMember 配置：

- `workspacePolicy: none`。
- `capabilities`: `readRoom`, `postRoomMessage`, `mentionMembers`。
- `sessionPolicy: new_per_request` 或 `resume_last`。

落地优先级：P3。对营销型 TeamRun 有价值，但对当前工程主流程不是第一批必需角色。

### 9. AI 交付审计员 / AI Shipping Auditor

来源插件：

- `pm-ai-shipping`

职责边界：

- 让 AI 写出的应用变得可审查：补系统文档、权限矩阵、变量/秘密说明、测试覆盖图。
- 对照“文档化意图”和“代码实现”找差异。
- 汇总 security/performance/test coverage 方向的 shipping packet。
- 它不是普通代码 Reviewer，也不是 E2E Tester，而是“交付可审查性”和“意图一致性”的负责人。

触发方式：

- `MENTION_ONLY`。
- 应在功能接近完成、准备评审或发布前被 Leader 派活。

典型输入：

- 仓库路径、功能范围、PRD、实现结果、已有 docs、测试结果、审查结果。

典型输出：

- `architecture.md`、`flows.md`、`permissions.md`、`variables.md` 等文档建议或草稿。
- 测试覆盖图。
- 安全审计发现。
- 性能审计发现。
- Shipping packet：文档清单、测试覆盖、安全/性能摘要、发布阻塞项和下一步。
- TeamRun 角色上下文或交付建议。`pm-ai-shipping` 的 `/ship-check` 原工作流包含生成/刷新 `CLAUDE.md` 和 `AGENTS.md` 的 agent operating context；迁移到 Agent Tower 时应改写为房间内交付建议、角色 prompt 建议或用户确认后的文档 patch，避免默认覆盖项目级 agent 指令文件。

协作对象：

- Implementer：补齐代码事实或文档事实。
- Reviewer：接收证据化风险，做代码层审查。
- E2E Tester：把测试覆盖缺口转成真实验证路径。
- Product Execution PM：对照 PRD 和验收标准。
- Leader：决定是否继续派修复、测试或用户确认。

适合处理：

- AI 生成代码的发布前检查。
- 缺少系统文档的项目。
- 权限、流程、变量、测试覆盖不清楚的交付。

不适合处理：

- 代替安全专家做最终安全背书。
- 代替 Reviewer 检查所有代码细节。
- 自动修改权限或发布配置。
- 默认覆盖 `CLAUDE.md`、`AGENTS.md` 或其他项目级 agent 指令文件。
- 在文档缺失时编造系统意图。

建议 TeamMember 配置：

- `workspacePolicy: shared`。
- `capabilities`: `readRoom`, `postRoomMessage`, `mentionMembers`, `readFiles`, `readDiff`, 可选 `runCommands`。
- `writeFiles` 可选：如果任务明确要求写入 `documentation/` 或 `docs/`，可开启；否则只产出 room result。
- `sessionPolicy: new_per_request`，避免审计记忆污染本次证据判断。

落地优先级：P1。它与当前 AI Agent 写代码的核心风险高度相关，且能补齐 Reviewer/E2E Tester 之间的文档和证据缺口。

### 10. 发布与利益相关方沟通专员 / Release & Stakeholder Comms

来源插件：

- `pm-execution` 的 `release-notes`、`summarize-meeting`、`stakeholder-map`
- 部分 `pm-go-to-market`

职责边界：

- 把已完成工作转成用户、团队或利益相关方能理解的发布说明和沟通计划。
- 从会议或 Team Room 结果中提炼决策、行动项、开放问题。

触发方式：

- `MENTION_ONLY`。

典型输入：

- changelog、tickets、PRD、实现总结、review/test result、会议记录。

典型输出：

- Release notes。
- Stakeholder update。
- 会议总结。
- 决策清单、行动项和 open questions。

协作对象：

- Leader：最终对用户汇总前可请它整理材料。
- Product Execution PM：同步范围和验收标准。
- GTM Strategist/Product Marketing：对外发布时协作。

适合处理：

- 发布说明。
- 团队同步。
- 多角色 result 汇总。

不适合处理：

- 修改代码。
- 代替用户发布对外公告。
- 在未确认功能状态时宣布已完成。

建议 TeamMember 配置：

- `workspacePolicy: none`；需要读取 changelog、tickets、PRD 或实现总结文件时改用 `shared + readFiles`。
- `capabilities`: `readRoom`, `postRoomMessage`；切到 `shared` 时再增加 `readFiles`。
- `sessionPolicy: new_per_request`。

落地优先级：P3。当前 Leader 已承担部分汇总职责，短期可先不拆；当 TeamRun 消息变长、发布任务增多时再独立。

### 11. 文档与政策草案专员 / Policy & Document Drafting Specialist

来源插件：

- `pm-toolkit`

职责边界：

- 起草或校对非核心产品工程文档，如隐私政策草案、NDA 草案、简历反馈、语法/逻辑校对。
- 明确标注需要专业人士复核的内容。

触发方式：

- `MENTION_ONLY`。

典型输入：

- 产品说明、数据处理说明、合同背景、待校对文本、简历和 JD。

典型输出：

- 文档草案。
- 合规/法律复核清单。
- 校对报告。
- 简历评分和修改建议。

协作对象：

- Product Execution PM：需要把产品数据实践写入隐私文档时协作。
- AI Shipping Auditor：需要变量、数据流、权限事实时协作。
- Leader：向用户说明这只是草案，需要专业确认。

适合处理：

- 内部草案、校对、文案质量检查。
- 隐私政策或 NDA 的起草起点。

不适合处理：

- 给法律意见。
- 直接替用户签署或发布法律文件。
- 对高风险合规问题给确定结论。

建议 TeamMember 配置：

- `workspacePolicy: none`。
- `capabilities`: `readRoom`, `postRoomMessage`。
- `sessionPolicy: new_per_request`。

落地优先级：P4。功能独立但不是 Agent Tower 当前核心团队协作闭环的刚需，且有高风险边界。

## 与当前已有角色的关系

| 当前角色 | 当前职责 | 新角色如何补位 | 注意边界 |
|---|---|---|---|
| 负责人 / Leader | 用户沟通、拆分任务、派活、跟踪 result、最终汇总 | 新 PM 角色给 Leader 提供战略、需求、风险、市场和发布判断 | 不建议让多个新角色也监听用户未 @ 消息；Leader 仍是默认调度入口 |
| 全栈工程师 / Implementer | 技术实现、测试补充、自审、工程交付 | Product Execution PM 可在实现前提供 PRD/验收标准；AI Shipping Auditor 可在实现后补交付审计 | PM 角色不应越权改业务代码，除非任务明确是 docs |
| 审查工程师 / Reviewer | 代码 diff 审查、数据流/权限/并发/测试覆盖风险 | Product Risk Red-Teamer 关注方案风险；AI Shipping Auditor 提供文档化意图和证据化审计输入 | Reviewer 仍负责代码级通过/需修改结论 |
| 测试工程师 / E2E Tester | 真实用户路径、浏览器验证、E2E 用例 | Product Discovery/Data Analyst 提供指标和实验验证重点；AI Shipping Auditor 产出测试覆盖图 | E2E Tester 仍负责实际验证结论 |

现有 v1.2 prompt 里还包含 UI Designer 和 Interaction Frontend Engineer。它们与 `pm-skills` 的关系是：

- Product Strategy/Discovery/Execution PM 负责“为什么、做什么、验收什么”。
- UI Designer 负责“用户路径和界面怎么设计”。
- Interaction Frontend Engineer 负责“界面方案如何在前端落地”。

## 推荐落地优先级

### P1：最应优先落地

1. **Product Execution PM**
   - 直接解决实现前需求不清、验收标准缺失的问题。
   - 与 Implementer/Reviewer/Tester 的协作链路最顺。

2. **Product Strategy Lead**
   - 适合处理模糊产品请求，避免工程团队过早进入实现。
   - 可作为产品类 TeamRun 的第二调度核心，但默认仍建议 `MENTION_ONLY`。

3. **Product Discovery Researcher**
   - 适合在需求前期识别假设和实验，减少无效实现。

4. **AI Shipping Auditor**
   - 与 Agent Tower 的 AI 编码场景高度相关。
   - 可以补齐“代码写完但系统意图、权限、测试覆盖不可审查”的缺口。

### P2：第二批

5. **Product Risk Red-Teamer**
   - 可以先并入 Product Execution PM 的 prompt，等使用频率高后拆成独立角色。

6. **Market Research Analyst**
   - 适合产品探索、竞品和用户研究任务。

7. **Product Data Analyst**
   - 对数据驱动任务价值高，但需要更严格的数据和命令权限约束。

8. **GTM Strategist**
   - 当 TeamRun 从工程协作扩展到发布/营销协作时引入。

### P3/P4：按场景再落地

9. **Product Marketing & Growth Strategist**
   - 对定位、命名、营销页和增长实验有价值。
   - 可在营销团队模板中启用。

10. **Release & Stakeholder Comms**
    - 当前 Leader 可兼任一部分；团队规模扩大后再拆。

11. **Policy & Document Drafting Specialist**
    - 边界敏感，适合明确的一次性草案任务，不适合作为默认团队成员。

## TeamTemplate 建议

### 产品定义团队

适用场景：用户提出模糊产品方向、功能想法、战略问题。

成员：

- Leader：`USER_MESSAGES`
- Product Strategy Lead：`MENTION_ONLY`
- Product Discovery Researcher：`MENTION_ONLY`
- Market Research Analyst：`MENTION_ONLY`
- Product Data Analyst：`MENTION_ONLY`

典型流转：

```text
用户提出方向
  -> Leader 判断是否需要澄清
  -> Product Strategy Lead 输出战略和 trade-off
  -> Product Discovery Researcher 拆假设和实验
  -> Market/Data 按需补证据
  -> Product Execution PM 另起任务转 PRD
```

### 功能交付团队

适用场景：从需求到实现、审查、测试的常规产品工程闭环。

成员：

- Leader：`USER_MESSAGES`
- Product Execution PM：`MENTION_ONLY`
- UI Designer：`MENTION_ONLY`，涉及界面时启用
- Implementer：`MENTION_ONLY`
- Reviewer：`MENTION_ONLY`
- E2E Tester：`MENTION_ONLY`

典型流转：

```text
用户提出需求
  -> Leader 派 Product Execution PM 梳理 PRD/验收
  -> UI Designer 按需补设计
  -> Implementer 实现
  -> Reviewer 审查
  -> E2E Tester 验证
  -> Leader 汇总
```

### Shipping Readiness 团队

适用场景：AI 代码已经完成，需要判断是否可交付、可审查、可测试。

成员：

- Leader：`USER_MESSAGES`
- AI Shipping Auditor：`MENTION_ONLY`
- Reviewer：`MENTION_ONLY`
- E2E Tester：`MENTION_ONLY`
- Release & Stakeholder Comms：`MENTION_ONLY`，发布沟通时启用

典型流转：

```text
实现完成
  -> AI Shipping Auditor 生成文档/测试覆盖/风险摘要
  -> Reviewer 处理代码级风险
  -> E2E Tester 验证用户路径
  -> Release Comms 生成发布说明
  -> Leader 决定是否 ready 或继续派修复
```

### 上市与增长团队

适用场景：产品或功能准备对外发布，需要定位、渠道、信息和增长计划。

成员：

- Leader：`USER_MESSAGES`
- Product Strategy Lead：`MENTION_ONLY`
- GTM Strategist：`MENTION_ONLY`
- Product Marketing & Growth Strategist：`MENTION_ONLY`
- Market Research Analyst：`MENTION_ONLY`

典型流转：

```text
用户要求发布/增长计划
  -> Strategy 确认目标客户和定位
  -> Market Research 补竞品/市场证据
  -> GTM 输出 launch plan
  -> Marketing Growth 输出文案、命名、增长创意
  -> Leader 汇总给用户确认
```

## 实施建议

第一阶段不需要改代码，可以只用现有 MemberPreset UI 手工创建角色：

1. 为 P1 角色各写一份 prompt，复用 `docs/prompt/v1.2/team-room-shared-protocol.md`。
2. 新增到 `docs/prompt/v1.2/product-team/` 或未来 `docs/prompt/v1.3/product-team/`。
3. 在 Team Settings 中手工创建 MemberPreset：
   - Product Execution PM
   - Product Strategy Lead
   - Product Discovery Researcher
   - AI Shipping Auditor
4. 创建两个 TeamTemplate：
   - Product Definition Team
   - Feature Delivery Team
5. 先在 Confirm 模式跑几轮，观察角色是否重叠、是否需要拆分或合并。

第二阶段再考虑系统化：

- 将角色 prompt 打包为内置 preset 示例。
- 为 TeamTemplate 提供一键导入。
- 将 `pm-skills` 的 command 工作流整理成 Agent Tower 可读的角色任务模板。
- 如果未来要直接支持插件/skill marketplace，再考虑从 `.claude-plugin` 或 `.codex-plugin` manifest 读取 metadata。

## 风险与限制

1. **不要直接复制外部项目内容当内置 prompt**
   - `pm-skills` 是 MIT 许可，但若要内置或分发，应保留来源和许可信息。
   - 更稳妥的方式是借鉴角色模型和工作流结构，重写符合 Agent Tower TeamRun 的 prompt。

2. **Slash command 与 TeamRun 不是同一层抽象**
   - `pm-skills` 的 commands 是 Claude/Cowork 工作流入口。
   - Agent Tower 当前 TeamRun 的执行单位是 TeamMember + WorkRequest。
   - 短期应把 command 内容转成角色工作方式，而不是强行在 TeamRun 房间中模拟 slash commands。

3. **`pm-ai-shipping /ship-check` 需要改写 operating context 步骤**
   - 原工作流会生成或刷新 `CLAUDE.md` / `AGENTS.md` 这类项目级 agent operating context。
   - 迁移到 Agent Tower 时，应改成 TeamRun 角色上下文、交付建议或需要用户确认的文档变更。
   - AI Shipping Auditor 不应默认覆盖项目级 agent 指令文件，除非用户明确要求且本轮任务范围允许。

4. **多个 PM 角色不能都监听用户消息**
   - 否则同一条用户消息会触发多个 WorkRequest，增加噪音和循环风险。
   - 推荐只有 Leader 用 `USER_MESSAGES`，其他角色 `MENTION_ONLY`。

5. **数据、法务、安全角色必须低权限**
   - Product Data Analyst 不应默认连接或修改生产数据。
   - Policy & Document Drafting Specialist 不能提供最终法律意见。
   - AI Shipping Auditor 的结论是审计输入，不是发布批准。

6. **PM 角色产出需要与工程角色闭环**
   - PRD、风险、测试覆盖和发布说明如果不进入 Implementer/Reviewer/Tester 的任务链，就只是文档。
   - Leader 需要负责把这些产物转成后续派活。

## 结论

`pm-skills` 最适合被 Agent Tower 吸收为“产品与交付前后链路的专业 TeamMember preset”，而不是直接变成技能文件导入器。

建议优先提取四个 P1 角色：

- Product Strategy Lead：处理方向、价值、取舍和指标。
- Product Discovery Researcher：处理假设、实验、访谈和功能请求。
- Product Execution PM：处理 PRD、用户故事、验收标准和执行计划。
- AI Shipping Auditor：处理 AI 代码交付的文档化、意图一致性和发布前证据整理。

这四个角色能与当前 Leader、Implementer、Reviewer、E2E Tester 形成完整链路：

```text
战略/发现 -> PRD/验收 -> 实现 -> 审查 -> 测试 -> shipping readiness -> 用户决策
```

后续再按场景补充 Market Research、Data Analyst、GTM、Marketing Growth、Release Comms 和 Policy Drafting，避免第一版团队过重。
