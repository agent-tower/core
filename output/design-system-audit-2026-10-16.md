# 设计系统符合度审计：主要页面

审计日期：2026-10-16

依据：`packages/web/src/design-system/README.md` 和 `/design-system` 展示页里的规则。初版还参考了旧的 `.design/DESIGN.md`；该文件已于同日废弃删除，下文按新设计系统更正过。

范围：`packages/web/src` 下 200 个文件，不含设计系统本身、展示页和测试。下文路径都相对于 `packages/web/src/`。

方法：先用脚本按规则扫类名和色值，再逐个文件看上下文、剔除误报。应用没有跑起来截图，所以这是代码层面的结论，不是像素比对。

## 结论

- **业务页面还没开始用设计系统。** 没有一个业务文件引用 `@/design-system`。页面用的是 `components/ui` 下的旧组件，再加手写的 Tailwind 类。旧 Button 被 26 个文件引用，旧 Modal 被 12 个文件引用。设计系统目前只在 `/design-system` 展示页里生效。
- **正式页面里约有 2,030 处偏差。** 64% 是直接写 Tailwind 原色板（`neutral-*`、`emerald-*`、`amber-*`、`red-*` 等）。其次是 10–11px 的中文小字、默认阴影、纯白底，以及没有减少动态降级的转圈动画。
- **问题集中在主页的三个区域。** 团队面板、工作区面板和移动端任务详情加起来约 1,320 处，占 65%。
- **修复收益最大的是全局底层组件。** 弹窗、下拉、确认框、提示气泡、Toast 和 Agent 日志共 269 处。每个页面都用到它们，改一处全站生效。
- **侧栏任务列表和对话页基本符合。** 只剩透明度调浅的灰字、默认阴影这类小问题。

## 各页面情况（按建议的修复顺序）

| 顺序 | 页面 / 区域 | 偏差 | 程度 | 主要问题 |
|---|---|---:|---|---|
| 1 | 全局底层组件 | 269 | 高 | 弹窗用白色遮罩；Toast、Tooltip 没用 `bg-inverse`；黑按钮是手写的 |
| 2 | 主页 · 工作区面板 | 540 | 高 | 原色板；终端颜色写死、没用终端 token；文件状态色抄了 4 份 |
| 3 | 主页 · 团队面板 | 568 | 高 | 自成一套状态色（含 indigo、cyan）；黑色消息气泡；有 7–8px 的字 |
| 4 | 主页 · 移动端任务详情 | 212 | 高 | 纯白底、700 字重、深色 diff，跟桌面版不像同一个产品 |
| 5 | 设置弹窗 | 192 | 中 | 团队、MCP 两页偏差最多；中文小字最集中 |
| 6 | 主页 · 顶栏远程访问 | 97 | 中 | `TunnelButton` 一个文件就有 90 处，弹层和按钮全是手写的 |
| 7 | 主页 · 任务详情与输入框 | 89 | 中 | 原色板很少；主要是透明度灰字、手写阴影、9px 徽章 |
| 8 | 新建项目弹窗 | 27 | 中 | 手写按钮和 neutral 色 |
| 9 | 主页 · 侧栏任务列表 | 19 | 低 | 基本符合 |
| 10 | 对话页 | 16 | 低 | 主体符合；标题字号不在阶梯上，时间文字太浅 |
| — | 开发演示页 | 124 | 可忽略 | `/demo`、`/agent-demo`、`/loading-preview` |

“偏差”是去掉误报后的扫描条数。同一行可能算多条，所以只用来比较轻重。

## 逐页说明

### 1. 全局底层组件（所有页面）

| 组件 | 偏差 | 问题 | 改法 |
|---|---:|---|---|
| `components/ui/modal.tsx` | 11 | 遮罩是 `bg-white/80 backdrop-blur-sm`（:89）；面板是 `bg-white shadow-2xl shadow-neutral-200/50`（:98） | 换成设计系统的 `Dialog`：遮罩 `bg-black/20`，面板 `bg-background shadow-overlay` |
| `components/ui/confirm-dialog.tsx` | 13 | 危险按钮是 `bg-red-500`（:54），主按钮是 `bg-neutral-900 hover:bg-black`（:55） | 换成 `ConfirmDialog` |
| `components/ui/select.tsx` | 19 | 触发器是 `bg-white border-neutral-200`（:66），下拉用 `shadow-lg`（:89） | 换成 `Select`，浮层用 `shadow-popover` |
| `components/ui/tooltip.tsx` | 6 | `bg-neutral-900 text-white` 加默认阴影（:39） | 换成 `Tooltip`（`bg-inverse`） |
| `App.tsx`（Toast） | 15 | `!bg-neutral-900 !text-neutral-100 !border-neutral-800 !shadow-lg`（:43–45） | 改用 `bg-inverse text-inverse-foreground shadow-overlay` |
| `components/ui/folder-picker.tsx` | 57 | 选中态用 emerald（:194）；选中按钮是黑色（:230）；有 10px 绿色徽章（:344）。新建项目和设置都在用 | 选中态用 `bg-accent` 加勾选图标；按钮用 `Button` |
| `components/agent/LogStream.tsx` | 52 | 主页任务详情和对话页共用。用户气泡是 `bg-neutral-200 text-neutral-900`（:449），设计系统的气泡是 `bg-foreground/[0.08]`；工具输出用 11px 的 `text-neutral-500`（:604）；失败图标写死了 `rgb(248 113 113)`（:746） | 气泡换成 `MessageBubble`；状态色走 token |
| `components/agent/TodoPanel.tsx`、`TokenUsageBar.tsx`、`components/task/ProviderSelector.tsx` | 37 | 用了 `text-emerald-500`、`text-red-500`；下拉是 `bg-white` 加默认阴影 | 状态色换成 `success`、`destructive`；下拉用 `Menu` |
| `components/errors/` 下三个错误页 | 6 | 中文说明是 `text-[11px] text-muted-foreground/80`（如 `RouteErrorPage.tsx:76`） | 改成 12px，不加透明度 |

### 2. 主页 · 工作区面板（终端、编辑器、审查、Git）

- **终端颜色写死。** 终端底色 `#1e1e1e` 和设计系统一致，问题在于颜色都是写死的：xterm 主题有 20 个色值（`components/workspace/StandaloneTerminalView.tsx:35` 起），标签栏和后台服务面板混用 `#202020`、`#252526`、`#333`、`#343434`、`#3a3a3a`（`TerminalTabs.tsx:192` 起、`WorkspaceBackgroundServices.tsx:73` 起），快捷命令弹层是深色的 `#2d2d2d`（`QuickCommandsPopover.tsx:55`）。设计系统已补上终端 token：xterm 改用 `readTerminalTheme()`；标签栏、分隔线、悬停改用 `bg-terminal-chrome`、`border-terminal-border`、`hover:bg-terminal-accent`；选中的标签和行用 `bg-terminal`；快捷命令弹层改用普通的浅色 `Popover`。
- **文件状态色抄了 4 份。** `M: 'text-amber-600 border-amber-200 bg-amber-50'` 这张表在 `components/workspace/ReviewView.tsx:34`、`HistoryView.tsx:16`、`components/mobile/MobileHistoryView.tsx:13`、`MobileChangesView.tsx:10` 各有一份。应该收成一个共用映射，改用 `warning-ink`、`success-ink`、`destructive-ink`。
- **主按钮用了绿色。** Git 合并按钮是 `bg-emerald-600 text-white`（`GitOperationsDialog.tsx:450`），结果提示是 `bg-emerald-50 text-emerald-700`（:99）。主操作只用 Charcoal；成功提示用 `Notice`。
- **原色板和纯白底。** `EditorView.tsx` 有 55 处。`WorkspaceSwitcher.tsx` 有 47 处，角色徽章用了 indigo、cyan（:21）。`FileTree.tsx` 有 26 处。`WorkspacePanel.tsx` 有 22 处，选中的标签是 `bg-neutral-900 text-white`（:135）。`PreviewPanel.tsx` 有 20 处。
- **灰字用透明度调浅。** `ReviewView.tsx` 有 19 处，`HistoryView.tsx` 有 11 处。`/60`、`/70` 的灰字在白底上不到 4.5:1。
- **转圈没有降级。** 有 29 处转圈没有减少动态降级，换成设计系统的 `Spinner`。

### 3. 主页 · 团队面板

- `components/team/TeamStatusPanel.tsx`（219 处）：成员状态有自己的一套颜色（emerald、amber、blue、red、indigo、cyan，从 :110 起），其中 indigo 和 cyan 不在状态色里。头像缩写用 8px（:356）。状态胶囊里的中文用 10px（:297）。
- `components/team/RoomTimeline.tsx`（207 处）：自己发的消息是 `bg-neutral-900 text-white` 的黑气泡（:735），等于在内容区加了一块常驻深色面。代码块用 `prose-pre:bg-neutral-950`（:262）。纯黑、纯白类名有 39 处。
- `components/team/TeamMemberManageDialog.tsx`（87 处）：选中卡片是 `border-neutral-900 shadow-sm`（:466）。分段按钮是 `bg-neutral-900 text-white`（:754），应改用 `Segmented`。
- `ActiveWorkList.tsx`（33 处）、`TeamRunCreateForm.tsx`（19 处）：头像缩写用 8px 和 7px（`ActiveWorkList.tsx:174`、`TeamRunCreateForm.tsx:204`）；中文标签用 11px（`TeamRunCreateForm.tsx:124`）。
- 全站小于 10px 的字有 10 处，其中 9 处在团队面板。

### 4. 主页 · 移动端任务详情

- `components/mobile/MobileTaskDetail.tsx`（105 处）：页面底色是 `bg-white`（:707）。标题用了 `font-bold`（:719）。状态点自带一套映射，比如 `bg-blue-500`（:95）。菜单用 `shadow-lg`（:756）。主按钮是 `bg-neutral-900 active:bg-black`（:1088）。转圈是手写的 svg（:1263）。
- `MobileHistoryView.tsx`（61 处）、`MobileChangesView.tsx`（46 处）：diff 区是 `bg-neutral-950` 加 11px（:56、:49），而桌面版的 diff 是浅色、12px。文件状态字母用了 `font-bold`（:85、:91）。
- 建议移动端直接复用桌面版的 diff 组件和状态映射，不要各写一份。

### 5. 设置弹窗

| 页面 | 偏差 | 问题 |
|---|---:|---|
| 团队（`pages/TeamSettingsPage.tsx`） | 35 | 白卡是 `bg-white`（:379）；“选择”“上传”按钮用 10px（:409–411）；计数徽章是 `bg-neutral-900 text-white text-[10px]`（:602） |
| MCP（`pages/McpSettingsPage.tsx`） | 34 | 状态徽章是 `bg-emerald-50 text-emerald-700` 和 `bg-amber-50 text-amber-700`（:12–13）；配置编辑框是 `bg-neutral-950`（:116），不是终端却用了深色面 |
| Cursor 模型（`components/provider/CursorAgentModelField.tsx`） | 21 | 输入框是 `border-neutral-200 focus:ring-neutral-900`（:37）；卡片是 `bg-white shadow-sm`（:55） |
| 快捷命令、文件路径列表（`components/ui/quick-commands-editor.tsx`、`file-path-list-input.tsx`） | 42 | 黑按钮是手写的（:77、:175）；下拉是 `bg-white shadow-lg`（`file-path-list-input.tsx:186`） |
| Agent CLI 环境（`components/agent-cli/AgentCliEnvironmentPanel.tsx`） | 15 | 状态徽章里的中文用 11px（:153、:201）；有 6 处转圈没有降级 |
| 模型服务（`pages/ProviderSettingsPage.tsx`） | 14 | 基本都用了 token；剩下 11px 的中文徽章（:385）和 `text-lg` 的数字（:1309） |
| 项目（`pages/ProjectSettingsPage.tsx`） | 10 | 全是 11px 小字，其中 8 处是中文（如 :243 的“已删除”） |
| 外框（`components/settings/SettingsDialog.tsx`） | 3 | 用了 `rounded-2xl`（18px，设计系统的 `Dialog` 是 14px）；阴影是手写的；遮罩加了模糊（:136、:148） |

设置里约有 35 处中文用了 10–11px，全站中文小字最集中的就是这里。

### 6. 主页 · 顶栏远程访问（`components/TunnelButton.tsx`，90 处）

- 图标按钮是 `text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100`（:11），换成 `IconButton`。
- 弹层是 `bg-white rounded-lg shadow-lg border-neutral-200`（:241），换成 `Popover`。
- 主按钮是 `bg-neutral-900 hover:bg-neutral-800`（:269）。状态色用了 18 处 amber、11 处 red、6 处 emerald 原色。
- 同在顶栏的 `pages/ProjectKanbanPage.tsx` 只有 7 处小问题：项目下拉用 `shadow-lg`（:76）；新建任务的标题是 `text-[20px]`（:651），不在字号阶梯上。

### 7. 主页 · 任务详情与输入框（89 处）

这里原色板只有 29 处。主要问题如下：

- `components/task/TaskDetail.tsx`（27 处）：有 14 处灰字用 `/70` 透明度调浅。空状态的图标框是 `rounded-2xl`（:119，18px 不在档位上），标题是 `text-lg`（:145）。更多菜单用 `shadow-lg`（:201）。转圈是手写的 svg（:1143）。
- `CreateTaskInput.tsx`（18 处）：有 6 处手写阴影，数值就是 `shadow-raised`（:324），直接换成 token。中文提示用 11px（:405）。
- `SlashCommandList.tsx`（17 处）：有 9px 的徽章（:62），规范禁止。分组标题是 10px 的 `text-neutral-400`（:37）。
- `StartAgentDialog.tsx`（12 处）：表单标签是 `text-neutral-700`（:202）；错误提示用了 red 原色。

### 8. 新建项目弹窗（`components/project/CreateProjectModal.tsx`，27 处）

取消按钮是 `text-neutral-600 hover:text-neutral-900`（:135），主按钮是 `bg-neutral-900 text-white hover:bg-black`（:144），一共 18 处 neutral。外层用的是旧 `Modal`，换成 `Dialog` 和 `Button` 后，这些问题都会消失。

### 9. 主页 · 侧栏任务列表（19 处，基本符合）

- 右键菜单的分组标题用 11px（`components/task/TaskGroup.tsx:58`），设计系统的 `MENU_LABEL` 是 12px。
- 菜单阴影是 `shadow-lg shadow-black/5`（`TaskGroup.tsx:255`），换成 `shadow-popover`。
- 拖拽阴影写的是 rgba 数值（`TaskList.tsx:168`、`:401`）。数值和规范一致，改成引用 token 就行。
- 任务行元信息的小字按 README 豁免，没有计入。

### 10. 对话页（`pages/ConversationPage.tsx`，16 处，基本符合）

- 空状态标题是 `text-3xl`（:726），也就是 30px；主页同一位置是 20px。两者都不在字号阶梯上，建议统一成 22px 或 26px。
- 列表里的时间是 `text-[11px] text-muted-foreground/50`（:181）。11px 没问题，但 `/50` 太浅。
- 搜索弹窗用 `shadow-lg`（:278）；分组标题是 11px 中文（:295）。
- 会话状态点用的 `animate-ping` 没有降级（:111），可以换成设计系统的 `LiveDot`。
- 对话页里 Agent 日志的问题算在全局组件 `LogStream` 里。

### 开发演示页（可忽略）

`/agent-demo`（`pages/AgentDemoPage.tsx`）有 104 处。`/demo`（`pages/DemoPage.tsx`）有 13 处，用了 `focus:ring-blue-500` 彩色焦点环和 `font-bold`。`/loading-preview` 有 5 处。这些页面不是给用户用的，建议不改或者直接删掉。

## 跨页面的共性问题

1. **黑色主按钮是手写的。** `bg-neutral-900 text-white hover:bg-black` 这类写法在 15 个文件里出现 21 次。设计系统 `Button` 的 primary 就是 Charcoal，统一替换即可。
2. **纯白底。** 24 个文件写了 `bg-white`。现在没有暗色主题入口，所以看不出问题：`stores/ui-store.ts` 有 `theme` 字段，但没有地方应用它。等以后开暗色时，这些写法会挡路。统一改成 `bg-background` 或 `bg-card`。
3. **状态色各写一份。** 文件状态表抄了 4 份；成员状态、工作区角色、后台服务、移动端任务状态又各有一套，用色互不相同。收成共用映射，或者直接用 `Badge` 的 tone。
4. **中文小字。** 10–11px 的字共 253 处。其中约 140 处是单行的数字、时间、编号，符合规范。约 100 处是中文标签或句子，不符合，集中在设置（约 35 处）、团队（约 30 处）和工作区（约 25 处）。另有 10 处是 7–9px，规范禁止。
5. **转圈没有降级。** 有 60 多处 `animate-spin` 和 `animate-ping` 没加 `motion-reduce`。设计系统的 `Spinner` 已经处理好了，减少动态时会放慢。
6. **默认阴影。** `shadow-sm`、`shadow-lg`、`shadow-2xl` 和手写 rgba 共约 67 处，统一换成 `shadow-raised`、`shadow-popover`、`shadow-overlay` 三档。

## 设计系统的缺口（2026-10-16 已补上）

- **链接。** 新增 `TextLink` 和 `textLinkClassName()`：墨色文字加灰下划线，悬停时下划线加深，站外链接带 ↗。颜色章节原来写着“信息色用于链接”，和墨色的 `Button variant="link"` 互相矛盾，已删掉。迁移时 `lib/streamdown-components.tsx:60` 的蓝色链接换成 `textLinkClassName()`。
- **终端。** `index.css` 新增 `--terminal-*` 变量：终端底色、前景、选区、ANSI 色，以及标签栏、分隔线、悬停、说明文字。xterm 读不了 CSS 变量，新增 `readTerminalTheme()` 在创建终端时取实际值。原来 `tokens.ts` 里写死 Hex 的 `TERMINAL_THEME` 已删除。初版说终端应该用 `#181e25`，这是旧 DESIGN.md 的规定；新设计系统定的就是 `#1e1e1e`。
- **头像。** 设计系统的 `Avatar` 本来就支持图片，也不给每个人分配颜色；样张补写了“有图片用图片，不做色块头像”。迁移 `components/team/MemberAvatar.tsx` 时，存的是色值的旧头像只传名字，按缩写显示。
- **DESIGN.md 的原色板写法。** `.design/` 已删除，这一条不再适用。

## 不算问题的（已从统计里剔除）

- 弹窗遮罩 `bg-black/20`：设计系统的 `Dialog` 也是这么写的。
- 终端本身的深色面：规范允许，只是颜色要改用终端 token（见第 2 节）。
- 渐变：都是文字或滚动边缘的渐隐，不是装饰底色。
- emoji：都是日志解析和通知里的字符，不是界面图标。
- 11px 的单行数字、时间、快捷键，以及 10px 的拉丁编号：符合规范。
- 侧栏任务行元信息：README 明确豁免。

## 死代码

`components/workspace/TerminalView.tsx`、`App.css`、`components/task/mock-data.ts` 没有被任何地方引用，合计 45 处偏差。建议直接删除，不用迁移。

## 建议的推进方式

1. **先换底座。** 让 `components/ui` 里的 Modal、ConfirmDialog、Select、Tooltip 保留旧的 API，内部改用设计系统组件；再改 Toast 的配色。这样业务代码不用动，全站外观先统一一大截。
2. **再按区域迁移。** 顺序是工作区面板、团队面板、移动端、设置。每迁完一块，就删掉那块的原色板写法和重复的状态映射。
3. **最后加护栏。** 把这次的扫描规则做成 lint 或 CI 检查，防止新代码再引入原色板、默认阴影和 10–11px 的中文。

## 附：扫描规则

| 规则 | 检查什么 | 依据 |
|---|---|---|
| 原色板 | `text-` / `bg-` / `border-` 等直接接 Tailwind 色板（`neutral-500`、`emerald-50` 等）。`task/status-styles.ts` 和 `task/adapters.ts` 是规范指定的映射来源，不算 | 颜色只来自语义 token |
| 硬编码色值 | Hex、`rgb()`、`hsl()` | `index.css` 是唯一色彩来源 |
| 纯黑 / 纯白 | `bg-white`、`text-black` 等 | 白底用 `bg-background`，以便切换主题 |
| 常驻深色面 | `bg-neutral-900` 到 `950`、`bg-black` | 只有终端可以常驻深色；浮层用 `bg-inverse` |
| 默认阴影 | `shadow-sm`、`shadow-lg`、`shadow-[…]` 等 | 只用 raised、popover、overlay 三档 |
| 圆角 | `rounded-2xl`（18px）及以上，或档位外的任意值。用户消息气泡除外，设计系统的 `MessageBubble` 也用 2xl | 档位是 4、6、8、10、14 |
| 小字 | 10–11px 及以下 | 中文最小 12px；11px 只给单行数字；10px 只给拉丁编号 |
| 字号阶梯 | 不在 26、22、15、14、13、12、11、10 上的字号 | 字号阶梯 |
| 字重 | `font-bold` 及以上 | 只用 400、500、600 |
| 循环动画 | `animate-spin`、`pulse`、`ping`、`bounce` 且同一行没有 `motion-reduce` | 循环动画必须有降级 |
| 透明度灰字 | `text-muted-foreground/50` 到 `/70` | `muted-foreground` 已是最浅的可读灰 |
| 彩色焦点环 | `focus:ring-blue-*` 等 | 焦点只加深中性边框 |
