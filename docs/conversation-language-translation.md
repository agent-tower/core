# 对话语言转换维护指南

语言转换默认关闭，覆盖任务会话、独立对话、TeamRun 用户投递及 PUBLIC Agent 正文展示。用户使用说明见 [Session](../packages/docs-site/docs/guide/sessions.md) 与 [团队模式](../packages/docs-site/docs/guide/team-mode.md)，接口见 [API reference](../packages/docs-site/docs/reference/api.md)。这里记录当前实现与维护入口。

## 范围和权威状态

设置使用一个总开关、两个目标语言和一份共用提示词。只处理用户正文及合格的 Agent `assistant_message` 正文；thinking、工具参数/结果、终端、Diff、私聊、附件全文、图片和音频均不翻译。静态历史不自动补翻。系统生成的冲突处理指令绕过翻译。

| 内容 | 权威存储与行为 |
| --- | --- |
| 用户原文 | MessageDelivery / Task 原字段，页面继续显示原文 |
| 实际投递正文 | MessageDelivery 的 acceptedText / actualSentText、投递凭据及固定任务输入快照 |
| Agent 原文 | MsgStore / Session snapshot / RoomMessage，立即显示并供 Agent 上下文使用 |
| 展示译文 | TranslationSource / TranslationAttempt；只通过 overlay 展示，不写回原始日志或群消息，不触发派活和心跳 |

提示词支持 `{{target_language}}`、`{{text}}`（允许变量内空格），替换一次，不递归解释原文。代码、路径、链接目标、Markdown 结构及资源/提及指令在本地替换为占位符，只有待译自然语言、随机占位符与必要格式指令发给翻译服务。返回后只拼接片段并还原已识别的占位符，不检查译文字符、占位符数量/顺序或还原后的结构；未知占位符按返回内容保留。占位符保留要求由系统提示词传达，HTTP 响应格式、空响应、截断及大小限制仍由客户端处理。历史 `PROTECTION_FAILED` 记录保留可读，新尝试不再产生此错误。

## 模块与生命周期

| 职责 | 代码入口 |
| --- | --- |
| 跨端契约 | `packages/shared/src/translation.ts`、`socket/events.ts` |
| 配置、脱敏和草稿测试 | server `services/translation-settings.service.ts`、`routes/translations.ts` |
| 来源身份、版本、租约和恢复 | server `services/translation.service.ts` |
| 有界公平调度、HTTP 与保护 | server `services/translation-queue.ts`、`translation-client.ts`、`translation-protection.ts` |
| 用户投递、顺序、幂等和确认 | server `services/message-delivery.service.ts`、SessionManager / Runtime Driver |
| 团队发布和固定任务输入 | server `services/team-run.service.ts`、`team-task-input.service.ts`、scheduler |
| 旧数据库启动屏障 | server `utils/database-schema.ts`、`packages/server/prisma/schema.prisma` 及 `packages/server/prisma/migrations/` |
| 配置和展示 | web `TranslationSettingsPage`、`LogStream`、`RoomTimeline`、`TranslationComparison` 及 translation/delivery hooks |

表中 server/web 路径从对应包的 `src/` 起算。稳定细节见开发技能的 [后端](../.agents/skills/agent-tower-dev/references/backend-patterns.md)、[运行时](../.agents/skills/agent-tower-dev/references/pipeline-patterns.md)、[TeamRun](../.agents/skills/agent-tower-dev/references/teamrun-patterns.md)、[前端](../.agents/skills/agent-tower-dev/references/frontend-patterns.md) 和 [安全边界](../.agents/skills/agent-tower-dev/references/workspace-security-patterns.md)。

CLI 与开发入口在构造应用/启动 worker 前同步并验证旧 schema、唯一索引、外键及发布事实；migration SQL 本身不代表 CLI 已执行数据迁移。旧 NULL 引用不猜测回填，损坏发布拒绝补造。`onReady` 等待翻译/投递恢复，再启动 ConversationTurn pump；shutdown 停止受理并等待请求、回调和资源清理。

## 投递、恢复和团队输入

用户提交使用稳定 `clientSubmissionId` 与 fingerprint；相同 UUID/意图恢复同一操作，修改内容复用 UUID 则冲突。人工动作使用 `expectedRevision` 和 `actionId`。202 仅表示持久受理；Session 的 SENT 表示输入提交已确认，团队 SENT 表示数据库消息/全部 WorkRequest/快照/receipt 原子发布，均不等于 Agent 已执行完成。

同一通道的前序失败、暂停、未确认投递阻塞后续；仅 SENT/CANCELLED 放行。翻译失败可重试或明确发送原文；投递失败复用有效译文。UNKNOWN 不自动重发，用户核对后才能确认未发或结束未知操作。关闭开关不自动发送原文，也不释放旧未决项；成功历史译文仍可读取。当前未决额度为每通道64、实例512，已有 UUID 优先恢复。

TEAM_USER 在受理时固定正文、附件、结构化 mentions/target 与实际收件人。共享输入按 team + Task 精确字段 hash 复用，只由实际投递/调度消费者登记；Task 编辑本身不发起翻译。Invocation 绑定 ACCEPTED 快照，后续 Task/设置变更不改变本次输入。Agent 的 `get_team_task_input` 读取自身 Invocation 固定快照，旧无引用项明确拒绝，不猜测历史。

TEAM_INITIAL 无等待时返回201真实 TeamRun；等待翻译或前序时返回202、`TEAM_ROOM_PENDING`，没有 destinationId。pending 仅保存意图及预留身份，不提前创建团队、成员、快照或派活。意图固定成员 UUID、展开配置和客户端指纹；等待中 Task 精确 hash 变化会推进 sourceRevision、撤销旧尝试并重算路由。Git 准备在事务外，发布事务复验实体、Task hash、配置、顺序和 epoch，一次创建团队/成员/首消息/共享输入/全部派活/receipt/SENT。初始正文只翻译一次并采纳为首个任务输入。导航使用 SENT 后真实团队 ID。

Session 正文在安全的完整段落边界、真实语义边界或完成信号后翻译。TextBlockTracker 将完整段落的原文 UTF-16 结束位置与 epoch 记录为 textBlock.paragraphs，原始 entry 不拆分；共享 getTranslationTextBlocks 投影独立段落来源（父 blockId 加 :p序号）和未完成尾段。段落检查点沿同一持久化链登记并独立发布译文；OPEN 尾段即时显示原文且不外发。前缀被改写时推进父 sourceRevision 并撤销旧段落，停止只中止尾段，静态恢复不新增资格。前端每个 Session 仅有一个完整译文查询缓存，切回立即使用匹配缓存、后台校验；查询键不含正文，瞬时网络错误不清译文，访问被撤销时清缓存，权威快照缺项撤旧。房间自动登记依赖消息事务内固定的启用 epoch，关闭期间与未标记历史不补翻。旧版本/旧 epoch/已撤销来源的迟到结果不能提交。REST 是刷新/重连的权威读模型；Socket 只发送 ID/revision 失效通知，不承载译文或重发业务事件。

配置/overlay/人工动作仅允许当前 owner 或经校验的 internal 身份，拒绝托管 Agent credential。普通写请求保留同源检查；internal 用户输入需显式 `x-agent-tower-input-origin: user`，普通 Agent 输入不二次翻译。密钥只写不回显，使用 keep/replace/clear，attempt 快照及错误不得包含凭据。

## 页面和语言目录

提交快照、响应未知的原 body/UUID、后续草稿与附件分别维护；恢复旧请求不能覆盖新输入。用户气泡只承载正文/附件，翻译状态、重试和实际发送对照位于对应气泡外。Agent 译文正文旁的图标可悬停、键盘聚焦或触摸打开原文浮层，浮层只展示/复制原文；正文复制当前展示版本。历史恢复不重播完成动画，减少动态效果设置仍生效。

目录由 [IANA Language Subtag Registry](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry) 的未弃用 primary language 子标签与 [CLDR JSON 48.1](https://github.com/unicode-org/cldr-json/tree/48.1.0/cldr-json/cldr-core) 的地区/脚本变体生成，CLDR 使用 [Unicode 数据许可](https://www.unicode.org/license.txt)。生成入口为 `node scripts/update-translation-languages.mjs`，输出 `packages/web/src/lib/translation-languages.json`；生成时联网，UI 运行时不联网拉目录。更新后核对 registryDate、语言/locale 数量、常见地区变体与搜索控件，保留旧自定义值。目录不保证所选翻译服务支持全部语言。

## 有效验证入口

从仓库根按改动运行现有测试，不调用付费 Provider：

```sh
# 配置、协议、保护、公平调度、来源/版本与路由权限
pnpm exec vitest run packages/server/src/services/__tests__/translation*.test.ts packages/server/src/routes/__tests__/{translations,team-run-translations}.test.ts
# 投递、团队发布、固定输入、恢复和旧库升级
pnpm exec vitest run packages/server/src/services/__tests__/{message-delivery,team-user-delivery,team-initial-delivery}.integration.test.ts packages/server/src/utils/{database-schema,database-team-foundation}.test.ts
# 设置、正文展示与提交身份/草稿
pnpm exec vitest run packages/web/src/pages/__tests__/TranslationSettingsPage.test.tsx packages/web/src/components/agent/__tests__/LogStream.translation.test.tsx packages/web/src/components/team/__tests__/RoomTimeline.optimistic.test.tsx packages/web/src/hooks/__tests__/{user-delivery,team-initial-submission,team-room-submission}.test.tsx
```

生产冲突受理/跨进程现场恢复共用 [conflict-platform 入口](../scripts/acceptance/conflict-platform/README.md)；真实认证到期与订阅交错见 [room-socket-expiry](../scripts/acceptance/room-socket-expiry/README.md)。安装升级保留 `scripts/verify-p3-startup.mjs <server-root> [cli|index|index-ts] [node] [web-dir]`；npm 安装 smoke 复用 `verify-cli-startup.mjs`。两份 `scripts/fixtures/*legacy.prisma` 及 `p3-startup-fixture.mjs` 是当前数据保留测试依赖。

真实浏览器聚焦回归保留 `scripts/translation-comparison-browser-test.mjs` 与 component fixture，因为 happy-dom 无法覆盖 Tab 冒泡时 Radix 挂载的事件顺序。通过 workspace services 启动 Vite（`pnpm --filter web exec vite --host 127.0.0.1 --port 53461 --strictPort`）和独立 Chrome（`--headless=new --disable-gpu --no-first-run --no-default-browser-check --disable-background-networking --remote-debugging-port=53462 --user-data-dir=<本轮独立临时目录> about:blank`），再执行：

```sh
node scripts/translation-comparison-browser-test.mjs http://127.0.0.1:53461 http://127.0.0.1:53462 output/translation-comparison-focus/current
```

脚本只连接本地端口，使用可信键盘/鼠标/390px触摸，检查打开、移出、Escape、焦点归还与滚动，不启动后端或 Provider。结束停止两个 workspace services、核验退出后删除 profile。它不替代任务/房间真实布局、滚动锚点、附件和完整收发流程的独立浏览器验收。

生产源码变化按 shared → server → web 顺序运行对应构建。当前不承诺多进程 MessageDelivery worker 共享同库安全；Windows 冲突原生观察器未落地，完整35秒受理/清理预算未认证。冲突资料恢复仍受 owner、原接收范围、现场代际与固定期限约束，不能承诺所有历史冲突均可恢复。
