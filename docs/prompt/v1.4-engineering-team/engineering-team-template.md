# 工程团队 Team Template v1.4

这份文档描述一个可在 Agent Tower TeamRun 中手工创建的“工程团队”模板草案。本文档只提供 MemberPreset / TeamTemplate 建议，不代表已经在系统中创建了预设或模板。

TeamRun 运行时会自动注入共享房间协议；本模板引用的 rolePrompt 文件只包含角色定义，不重复包含共享协议全文。

## 推荐团队配置

TeamTemplate 名称建议：

```text
工程团队 v1.4
```

团队成员：

1. 负责人 / Leader：用户沟通入口与产品范围决策协调。
2. 产品经理 / Spec Owner：需求澄清、spec 收敛、验收标准和用户确认前置 gate。
3. 原型设计师 / Prototype Designer：低保真线框图和交互说明。
4. 技术团队负责人兼架构师 / Tech Lead & Architect：工程链路调度、技术方案、架构规范维护、质量闭环。
5. 实现工程师 / Implementer：代码实现与单元/集成验证。
6. 代码审查工程师 / Reviewer：代码审查、风险识别、测试缺口判断。
7. E2E 测试工程师 / E2E Tester：真实用户路径和端到端验证。

默认协作链路：

```text
用户 -> 负责人 -> PM/Spec Owner / Prototype Designer -> 负责人 -> 技术团队负责人 -> 实现工程师 / 审查工程师 / E2E 测试工程师 -> 技术团队负责人 -> 负责人 -> 用户
```

PM/Spec Owner 是 `MENTION_ONLY` 专家角色。负责人在需求模糊、范围大、涉及 UX/产品取舍、需要 spec 或验收标准时调用；简单明确任务可以跳过 PM，直接交给技术团队负责人。

Prototype Designer 是 `MENTION_ONLY` 专家角色。负责人或 PM/Spec Owner 在 UI 交互复杂、页面结构不清、关键状态需要对齐时调用；产出低保真线框图和交互说明，统一保存到 `.agent-tower/prototypes/`。原型只用于说明交互和界面功能，不是视觉精修、产品最终 UI 设计稿或像素级实现依据。

PM 负责定义“做什么、为什么做、验收什么、不做什么”，并保存 `.agent-tower/spec/YYYY-MM-DD-<slug>-spec.md`。技术团队负责人负责定义“怎么做、架构怎么变、任务怎么拆、怎么验证”，并保存 `.agent-tower/plan/YYYY-MM-DD-<slug>-plan.md` implementation plan/tasks。

高层 gate：模糊或复杂需求先过 PM spec gate；交互不清时可先补低保真 prototype。没有用户确认的 spec 不进入技术负责人 plan 或并行实现，除非负责人明确判定当前任务简单明确、可跳过 PM。技术负责人接手后先完成 plan path 和 plan self-review，再派发实现、审查、测试。实现、审查、测试成员消费具体 spec path、prototype path、plan path / Task N，不自行补齐产品定义或发明任务边界。

实现、审查、测试成员完成后，应结构化 @ 技术团队负责人。技术团队负责人兼架构师完成技术闭环后，再 @ 负责人汇报。负责人面向用户做最终汇总或决策确认。

每个新工程任务都必须符合项目 `.agent-tower/` 下的架构设计和编码规范。技术团队负责人在拆解任务前负责读取、创建或更新这些文件。本模板只规定配置和高层工作流，不复制各角色 prompt 的完整细则。

## 系统配置建议

这部分只用于创建 MemberPreset / TeamTemplate 时填写，不需要写进每个成员介绍。

| 字段 | 负责人 | PM/Spec Owner | Prototype Designer | 技术团队负责人 | 实现工程师 | 审查工程师 | E2E 测试工程师 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `workspacePolicy` | `none` | `dedicated` | `dedicated` | `dedicated` | `dedicated` | `dedicated` | `dedicated` |
| `triggerPolicy` | `USER_MESSAGES` | `MENTION_ONLY` | `MENTION_ONLY` | `MENTION_ONLY` | `MENTION_ONLY` | `MENTION_ONLY` | `MENTION_ONLY` |
| `sessionPolicy` | `resume_last` | `resume_last` | `resume_last` | `resume_last` | `new_per_request` | `new_per_request` | `new_per_request` |
| `readRoom` | true | true | true | true | true | true | true |
| `postRoomMessage` | true | true | true | true | true | true | true |
| `mentionMembers` | true | true | true | true | true | true | true |
| `stopMemberWork` | true | false | false | true | false | false | false |
| `markReadyForReview` | false | false | false | false | true | false | false |
| `readFiles` | false | true | true | true | true | true | true |
| `writeFiles` | false | true | true | true | true | false | true |
| `runCommands` | false | false | false | false | true | true | true |
| `readDiff` | false | false | false | true | true | true | true |
| `mergeWorkspace` | false | false | false | true | false | false | false |

说明：

- 负责人使用 `USER_MESSAGES` 作为用户入口，默认不具备代码工作区能力。
- PM/Spec Owner 使用 `MENTION_ONLY`，由负责人在需求澄清、spec 收敛、验收标准、用户确认或产品取舍场景触发；具备项目文件读取和 `.agent-tower/spec/` 文档写入能力，用于探索上下文与保存 written spec，不做业务代码实现。复杂/模糊需求澄清后，PM 应保存 `.agent-tower/spec/YYYY-MM-DD-<slug>-spec.md` written spec，并在 result 中给出 spec path、用户确认状态和 verdict。
- Prototype Designer 使用 `MENTION_ONLY`，由负责人、PM/Spec Owner 或技术团队负责人在 UI 交互复杂、页面结构不清或关键状态需要对齐时触发；具备项目文件读取和 `.agent-tower/prototypes/` 文档写入能力，只产出低保真线框图和交互说明，不做视觉精修、不做产品最终 UI 设计、不改业务代码。
- 技术团队负责人兼架构师使用 `MENTION_ONLY`，由负责人派活触发；可读取文件和 diff，负责读取、创建或更新项目 `.agent-tower/` 架构设计与编码规范，并保存 `.agent-tower/plan/` implementation plan/tasks 文档；具备合并权限用于明确授权后的工程闭环，但写权限仅用于 `.agent-tower/` 文档产物，默认不写业务代码、不跑实现命令。
- 实现工程师使用 `dedicated` 工作区和写权限，负责代码变更、测试和 mark ready。
- 审查工程师使用 `dedicated` 工作区但无写权限，允许读取文件、运行检查和读取 diff；这是 targeted REVIEW 启动前同步到固定开发 commit 的前置要求。
- E2E 测试工程师使用 `dedicated` 工作区，允许修改测试相关文件并运行测试；不修改业务代码；这是 targeted TEST 启动前同步到固定开发 commit 并隔离端口的前置要求。
- `new_per_request` 用于实现、审查、测试，减少跨任务上下文污染；如果团队希望成员长期记忆同一大型项目背景，可以按需改为 `resume_last`。
- `mergeWorkspace=true` 只建议给技术团队负责人；是否实际允许合并仍应由任务授权和服务端 merge gate 决定。

## 头像建议

| 成员 | avatar |
| --- | --- |
| Engineering Leader - 负责人 | `/avatars/presets/avatar-preset-10-product-manager.png` |
| Product Manager - Spec Owner | `/avatars/presets/avatar-preset-21-consultant.png` |
| Prototype Designer - 原型设计师 | `/avatars/presets/avatar-preset-16-ui-designer.png` |
| Tech Lead & Architect - 技术团队负责人兼架构师 | `/avatars/presets/avatar-preset-14-mentor.png` |
| Implementer - 实现工程师 | `/avatars/presets/avatar-preset-06-frontend.png` |
| Reviewer - 代码审查工程师 | `/avatars/presets/avatar-preset-15-reviewer.png` |
| E2E Tester - 端到端测试工程师 | `/avatars/presets/avatar-preset-03-tester.png` |

## Prompt 组成方式

创建负责人 MemberPreset：

```text
使用 docs/prompt/v1.4-engineering-team/team-room-leader-prompt.md 的 rolePrompt 正文。
```

创建产品经理 / Spec Owner MemberPreset：

```text
使用 docs/prompt/v1.4-engineering-team/team-room-product-manager-prompt.md 的 rolePrompt 正文。
```

创建原型设计师 MemberPreset：

```text
使用 docs/prompt/v1.4-engineering-team/team-room-prototyper-prompt.md 的 rolePrompt 正文。
```

创建技术团队负责人兼架构师 MemberPreset：

```text
使用 docs/prompt/v1.4-engineering-team/team-room-tech-lead-prompt.md 的 rolePrompt 正文。
```

创建实现工程师 MemberPreset：

```text
使用 docs/prompt/v1.4-engineering-team/team-room-implementer-prompt.md 的 rolePrompt 正文。
```

创建代码审查工程师 MemberPreset：

```text
使用 docs/prompt/v1.4-engineering-team/team-room-reviewer-prompt.md 的 rolePrompt 正文。
```

创建 E2E 测试工程师 MemberPreset：

```text
使用 docs/prompt/v1.4-engineering-team/team-room-e2e-tester-prompt.md 的 rolePrompt 正文。
```

## 成员与职责建议

### Engineering Leader / 负责人

- MemberPreset name：`Engineering Leader - 负责人`
- aliases：`["leader", "engineering-leader", "负责人", "项目负责人"]`
- rolePrompt：使用 `team-room-leader-prompt.md`
- 核心职责：用户沟通、产品范围、优先级、spec gate 判断、技术团队负责人派活、最终汇总。
- 边界：默认不直接派实现、审查、测试成员；除非技术团队负责人不可用或用户明确要求单点调度。

### Product Manager / Spec Owner

- MemberPreset name：`Product Manager - Spec Owner`
- aliases：`["product-manager", "pm", "spec-owner", "需求澄清", "产品经理", "验收标准"]`
- rolePrompt：使用 `team-room-product-manager-prompt.md`
- 核心职责：需求澄清、验收标准、非目标、written spec、用户确认状态和是否进入技术拆解的 verdict。
- 边界：不调度实现、审查、测试成员，不做代码实现，不做技术合并；完整 spec 工作流以 PM rolePrompt 为准。

### Prototype Designer / 原型设计师

- MemberPreset name：`Prototype Designer - 原型设计师`
- aliases：`["prototype-designer", "prototyper", "wireframe", "原型设计师", "原型图", "线框图"]`
- rolePrompt：使用 `team-room-prototyper-prompt.md`
- 核心职责：低保真线框图、交互说明、页面结构、信息层级、关键状态和功能边界说明。
- 产物目录：统一写入 `.agent-tower/prototypes/`，文件名应对应 spec、feature 或 task。
- 边界：不做视觉精修、不做产品最终 UI 设计、不改业务代码；原型不是像素级设计稿。

### Tech Lead & Architect / 技术团队负责人兼架构师

- MemberPreset name：`Tech Lead & Architect - 技术团队负责人兼架构师`
- aliases：`["tech-lead", "technical-lead", "architect", "架构师", "技术负责人", "技术团队负责人"]`
- rolePrompt：使用 `team-room-tech-lead-prompt.md`
- 核心职责：技术方案、`.agent-tower/` 架构规范、`.agent-tower/plan/` plan path / Task N、plan self-review、parallel split boundary、实现/审查/测试调度、返修收敛、merge gate 和技术 result。
- 并行与 target：可安全拆分且范围互不冲突时优先并行；不得并行派发会写同一文件、同一模块或同一工作流的任务。固定开发交付的 REVIEW/TEST 必须绑定 `targetPurpose=REVIEW|TEST`、`targetSourceWorkspaceId`、`targetHeadSha`、`targetBranchName`，目标成员必须是 `workspacePolicy=dedicated`；targetless REVIEW/TEST 只用于讨论、分析、普通协作或查看当前共享状态，不用于并行验证固定 commit。

### Implementer / 实现工程师

- MemberPreset name：`Implementer - 实现工程师`
- aliases：`["implementer", "full-stack-engineer", "实现工程师", "全栈工程师"]`
- rolePrompt：使用 `team-room-implementer-prompt.md`
- 核心职责：代码实现、必要测试、自审、结构化 @ 技术团队负责人 result。
- 边界：不承担最终审查、E2E 结论、合并或发布；审查意见处理规则以 Implementer rolePrompt 为准。

### Reviewer / 代码审查工程师

- MemberPreset name：`Reviewer - 代码审查工程师`
- aliases：`["reviewer", "code-reviewer", "审查工程师", "代码审查"]`
- rolePrompt：使用 `team-room-reviewer-prompt.md`
- 核心职责：审查 diff 与相关上下文、识别真实风险、给出通过/需要修改/阻塞结论、结构化 @ 技术团队负责人 result。
- 边界：默认不改业务代码；finding standards 以 Reviewer rolePrompt 为准。

### E2E Tester / 端到端测试工程师

- MemberPreset name：`E2E Tester - 端到端测试工程师`
- aliases：`["e2e-tester", "qa-tester", "端到端测试", "测试工程师"]`
- rolePrompt：使用 `team-room-e2e-tester-prompt.md`
- 核心职责：真实用户路径验证、测试环境归属确认、可复现问题报告、结构化 @ 技术团队负责人 result。
- 边界：只修改测试相关文件；测试环境安全规则以 E2E Tester rolePrompt 为准。

## 推荐工作流

1. 用户提出工程需求。
2. 负责人执行需求清晰度判断；模糊、复杂、涉及 UX/产品取舍或需要验收标准时，@ PM/Spec Owner 收敛 `.agent-tower/spec/YYYY-MM-DD-<slug>-spec.md`。
3. 如果页面结构、信息层级、关键状态或交互流程不清，负责人或 PM/Spec Owner 可 @ Prototype Designer 产出 `.agent-tower/prototypes/YYYY-MM-DD-<slug>-prototype.md` 低保真线框图。
4. PM/Spec Owner 完成 spec gate result；未确认或 verdict 不是 `READY_FOR_TECH_PLAN` 时，负责人不进入技术拆解，除非明确说明简单任务跳过 PM。
5. 负责人 @ 技术团队负责人；技术团队负责人读取 spec/prototype 和 `.agent-tower/` 架构规范，生成 `.agent-tower/plan/YYYY-MM-DD-<slug>-plan.md`，完成 plan path / plan self-review 后派活。
6. 技术团队负责人按 Task N 调度实现、审查、测试；满足 parallel split boundary 时优先并行，冲突范围串行处理。
7. 固定开发交付的 REVIEW/TEST 走 targeted REVIEW/TEST fields，并使用 `workspacePolicy=dedicated` 的审查/测试成员；targetless 只用于讨论、分析、普通协作或查看当前共享状态。
8. 实现、审查、测试 result 默认结构化 @ 技术团队负责人；返修、补审、补测由技术团队负责人收敛。
9. 技术团队负责人技术闭环后 @ 负责人；负责人向用户发送最终汇总或请求用户决策。

## 结构化 result 要求

各角色 result 的完整字段以对应 rolePrompt 为准；模板层面只规定路由和最低判断信息。

- 实现、审查、E2E 测试成员发送 result 时必须使用 Team Room mention 字段唤醒技术团队负责人；不能只在正文里写 `@技术负责人` 或 `@技术团队负责人`。
- 发送前先调用 `list_team_members` 确认技术团队负责人的 `memberId`；调用 `post_room_message` 时填写：

```ts
mentions: [{ memberId: "<技术负责人成员ID>", label: "技术团队负责人", ifBusy: "queue" }]
```

- PM/Spec Owner result 至少能判断：Verdict、Spec Path、User Confirmed、范围/非目标、验收标准、风险/取舍和下一步建议。
- Prototype Designer result 至少能判断：Prototype Path、覆盖页面/状态/流程、关键交互、未覆盖边界和待确认问题。
- 实现、审查、E2E 测试 result 至少能判断：结论、处理范围、验证方式、发现问题或明确无阻塞、剩余风险和下一步建议。
- 技术团队负责人 result 至少能判断：实现/审查/测试状态、关键交付、Plan Path、Plan 自审、`.agent-tower/` 架构规范读取/创建/更新情况、验证结果、剩余风险和给负责人的下一步建议。

负责人最终面向用户汇总时，应先用大白话说明用户关心的结果，优先控制在 4 个要点以内：

- 已经帮用户完成了什么。
- 怎么确认它能工作。
- 还有什么没处理、剩余风险或需要注意。
- 用户下一步该做什么。

最终汇总应面向非程序员可读，不要一上来堆文件名、测试命令、diff 或团队内部过程；技术细节可以少量放在后面作为补充。

## 使用边界

- 本模板不创建真实 MemberPreset 或 TeamRun template。
- 本模板不包含共享房间协议全文；运行时应由系统自动注入。
- 本模板不改变业务代码、服务端逻辑、前端 UI 或数据库。
- 本模板不要求测试 verdict 强制纳入 merge gate。
- 本模板不默认自动合并、发布或推送；合并需要负责人明确授权并满足服务端权限与 merge gate。
