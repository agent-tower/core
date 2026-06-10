# 营销团队 Team Template v1.2

这份文档描述一个可在 Agent Tower TeamRun 中手工创建的“营销团队”团队模板。团队由 5 名成员组成，按顺序完成从市场洞察到活动落地页的营销交付链路：

1. 市场研究员 -> 目标受众分析
2. 活动策略师 -> 活动简报
3. 内容创作者 -> 社交媒体帖子
4. 创意设计师 -> 广告创意图
5. 落地页技能 -> 品牌活动落地页

## 推荐团队配置

TeamTemplate 名称建议：

```text
营销团队
```

系统配置建议：

| 字段 | 市场研究员 | 活动策略师 | 内容创作者 | 创意设计师 | 落地页技能 |
| --- | --- | --- | --- | --- | --- |
| `workspacePolicy` | `none` | `none` | `none` | `none` | `dedicated` |
| `triggerPolicy` | `USER_MESSAGES` | `MENTION_ONLY` | `MENTION_ONLY` | `MENTION_ONLY` | `MENTION_ONLY` |
| `sessionPolicy` | `resume_last` | `resume_last` | `resume_last` | `resume_last` | `resume_last` |
| `readRoom` | true | true | true | true | true |
| `postRoomMessage` | true | true | true | true | true |
| `mentionMembers` | true | true | true | true | true |
| `stopMemberWork` | false | false | false | false | false |
| `markReadyForReview` | false | false | false | false | false |
| `readFiles` | false | false | false | false | true |
| `writeFiles` | false | false | false | false | true |
| `runCommands` | false | false | false | false | true |
| `readDiff` | false | false | false | false | true |
| `mergeWorkspace` | false | false | false | false | false |

头像建议：

| 成员 | avatar |
| --- | --- |
| Market Researcher - 市场研究员 | `/avatars/presets/avatar-preset-20-analyst.png` |
| Campaign Strategist - 活动策略师 | `/avatars/presets/avatar-preset-10-product-manager.png` |
| Content Creator - 内容创作者 | `/avatars/presets/avatar-preset-18-documenter.png` |
| Creative Designer - 创意设计师 | `/avatars/presets/avatar-preset-22-creative-director.png` |
| Landing Page Skill - 落地页技能 | `/avatars/presets/avatar-preset-06-frontend.png` |

说明：

- 市场研究员作为默认入口响应用户需求，先判断资料是否足够；资料不足时向用户追问，不直接让下游成员开始制作。
- 每个成员只负责自己的交付物，不跳过上游结果，也不替下游产出完整成品。
- `resume_last` 适合连续迭代同一品牌、产品或活动，成员可以保留上下文和历史决策。
- 只有落地页技能默认使用 `dedicated` 独立工作区能力；如果团队只需要文案型落地页方案，可以把它的 `workspacePolicy` 调整为 `none`，并关闭文件与命令能力。
- `mentionMembers` 用于把完成的交付物派给下一位成员；不要让多个成员同时改同一份落地页文件。

## Prompt 组成方式

创建市场研究员 MemberPreset：

```text
使用 docs/prompt/v1.2/marketing-team/marketing-market-researcher-prompt.md 的完整内容。
```

创建活动策略师 MemberPreset：

```text
使用 docs/prompt/v1.2/marketing-team/marketing-campaign-strategist-prompt.md 的完整内容。
```

创建内容创作者 MemberPreset：

```text
使用 docs/prompt/v1.2/marketing-team/marketing-content-creator-prompt.md 的完整内容。
```

创建创意设计师 MemberPreset：

```text
使用 docs/prompt/v1.2/marketing-team/marketing-creative-designer-prompt.md 的完整内容。
```

创建落地页技能 MemberPreset：

```text
使用 docs/prompt/v1.2/marketing-team/marketing-landing-page-skill-prompt.md 的完整内容。
```

## 成员与链路

### Market Researcher / 市场研究员

- MemberPreset name：`Market Researcher - 市场研究员`
- aliases：`["market-researcher", "marketing-researcher", "市场研究员", "用户研究", "受众分析"]`
- rolePrompt：使用 `marketing-market-researcher-prompt.md`
- 核心交付物：`目标受众分析`

市场研究员接收用户提供的品牌、产品、行业、目标、预算、地区和已有素材信息，输出目标受众分析，并把结果交给活动策略师。

### Campaign Strategist / 活动策略师

- MemberPreset name：`Campaign Strategist - 活动策略师`
- aliases：`["campaign-strategist", "marketing-strategist", "活动策略师", "营销策略", "活动策划"]`
- rolePrompt：使用 `marketing-campaign-strategist-prompt.md`
- 核心交付物：`活动简报`

活动策略师基于目标受众分析制定活动目标、主张、渠道、节奏、预算重点和衡量指标，并把活动简报交给内容创作者。

### Content Creator / 内容创作者

- MemberPreset name：`Content Creator - 内容创作者`
- aliases：`["content-creator", "social-copywriter", "内容创作者", "社媒文案", "社交媒体"]`
- rolePrompt：使用 `marketing-content-creator-prompt.md`
- 核心交付物：`社交媒体帖子`

内容创作者基于活动简报输出多平台社交媒体帖子，包括主文案、短标题、话题标签、CTA 和变体，并把内容方向交给创意设计师。

### Creative Designer / 创意设计师

- MemberPreset name：`Creative Designer - 创意设计师`
- aliases：`["creative-designer", "ad-creative-designer", "创意设计师", "广告创意", "视觉设计"]`
- rolePrompt：使用 `marketing-creative-designer-prompt.md`
- 核心交付物：`广告创意图`

创意设计师基于社交内容和活动简报输出广告创意图方案，包括画面概念、版式、文案层级、视觉规范、生成提示词或设计执行说明，并把最终活动主视觉交给落地页技能。

### Landing Page Skill / 落地页技能

- MemberPreset name：`Landing Page Skill - 落地页技能`
- aliases：`["landing-page-skill", "landing-page-builder", "落地页技能", "活动落地页", "营销页"]`
- rolePrompt：使用 `marketing-landing-page-skill-prompt.md`
- 核心交付物：`品牌活动落地页`

落地页技能基于活动简报、社交帖子和广告创意图方案，输出或实现品牌活动落地页。若具备工作区权限，应按项目现有技术栈和设计系统实现；若没有工作区权限，则输出可交付给实现成员的页面方案和文案结构。

## 推荐工作流

1. 用户提出营销目标、品牌或产品信息。
2. 市场研究员判断信息是否足够；不足时最多追问 3 个关键问题。
3. 市场研究员输出 `目标受众分析`，并 @ 活动策略师。
4. 活动策略师输出 `活动简报`，并 @ 内容创作者。
5. 内容创作者输出 `社交媒体帖子`，并 @ 创意设计师。
6. 创意设计师输出 `广告创意图`，并 @ 落地页技能。
7. 落地页技能输出 `品牌活动落地页` 或实现结果，并发送 result。

## 交接产物格式

每个成员完成时都应在 Team Room 发送 result，并包含：

- 当前交付物是否完成。
- 使用了哪些上游输入。
- 核心产出是什么。
- 需要下游成员继续处理什么。
- 是否存在需要用户确认的信息缺口。

不要把完整调研日志、完整生成过程或大量备选内容塞进 result。需要保留长内容时，优先用结构清晰的精简版本，让下游成员可以直接执行。
