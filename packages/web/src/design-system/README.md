# Agent Tower 设计系统

从主页提炼的界面语言与组件库，也是界面规范的唯一来源。所有令牌、组件和展示组件的样张都在 **`/design-system`** 页面（`src/pages/DesignSystemPage.tsx`），每张样张写了用途和「该做 / 别做」。

## 使用

业务代码只从统一出口引入：

```tsx
import { Badge, Button, LineChart } from '@/design-system'
```

- 不要深引内部路径（`@/design-system/inputs/...`）；出口里没有的东西视为未发布。
- 颜色、阴影、缓动的唯一来源是 `src/index.css`（`:root` + `@theme inline`）。`tokens.ts` 只做「语气 → 类名」和图表角色色的映射，组件里只写 token 类名，不写色值。
- 图标按含义取：`<Icon name="delete" />`，换图标只改 `icons/registry.ts` 一处。新图标从 lucide 里找，和侧栏菜单同一套线性笔触，不自绘实心块面。
- 任务状态的颜色和图标只来自 `components/task/status-styles.ts`，组件库不另立一套。
- 层级从低到高：页面里的浮层与设置弹窗 `z-50` → 对话框 `z-[60]` → 菜单、选择框、气泡面板 `z-[70]`（对话框里打开也压得住）→ 悬停提示 `z-[100]`。
- 链接是墨色加灰下划线：句子里的链接用 `TextLink`（Markdown、路由 Link 用 `textLinkClassName()`），单独的「查看文档」用 `<Button variant="link">`。不用蓝色标链接。
- 终端是唯一的常驻深色面，颜色都是 `--terminal-*` 变量：界面层写类名（`bg-terminal`、`bg-terminal-chrome`、`border-terminal-border`、`hover:bg-terminal-accent`、`text-terminal-muted-foreground`），程序输出和终端里的状态点用 ANSI 色（`text-terminal-green` 等）。xterm 读不了 CSS 变量，创建时用 `readTerminalTheme()` 取实际值。终端里弹出的菜单、浮层仍用普通的 `Menu` / `Popover`。

## 目录与分层

| 目录 | 内容 |
| --- | --- |
| `tokens.ts`、`lib/` | 令牌映射；比例尺与路径、数字和日期格式化、通用 hooks |
| `icons/` | 语义图标注册表 |
| `feedback/` | 徽章、提示条、空状态、骨架、转圈、实时指示 |
| `actions/` | 按钮、图标按钮、复制、按键 |
| `inputs/` | 字段、输入框、选择框、分段、标签页、胶囊、开关、输入卡 |
| `overlays/` | 菜单、右键菜单、悬停提示、气泡面板、对话框 |
| `navigation/` | 侧栏行与分组、面包屑、步骤 |
| `marks/` | 图形原子：环、进度轨、迷你折线、增减、图例、状态方块、树 |
| `charts/`、`display/` | 图表；数字卡、目标、清单、表格、流程、人与内容 |
| `domain/` | 任务、项目、分支、Agent——唯一可以依赖业务类型的一层 |

依赖只能自上而下：`tokens / lib → icons / feedback / actions / inputs / overlays / navigation → marks → charts / display → domain`，不允许反向引用。

## 原则

界面六条：

1. **灰框白岛**：浅灰外框（顶栏、侧栏）承载导航，白色内容岛承载正在处理的对象；层级靠底色和 1px 细边区分，不靠阴影堆叠。
2. **标题优先**：列表行里标题拥有最大宽度；元信息必须紧凑，悬停或键盘聚焦时让位，宁可截短元信息也不截短标题。
3. **墨色为主**：Charcoal 是唯一的主色（主按钮、选中、开关、图表主系列）；蓝色只表示「运行中 / 信息」，链接也用墨色。
4. **颜色只给状态**：颜色只表达需要注意的状态和项目身份，其余一律灰阶，状态永远配图标或文字。文字用 `*-ink` 色保证 4.5:1，图形标记 ≥ 3:1；状态色都落在 sRGB 内，不用 Tailwind v4 的 P3 高饱和值（在 Mac 屏上发「荧光」）。
5. **浮起 = 正在打开**：白卡浮在灰底上表示「这一项正在展示」——侧栏选中行和分段控件的选中段是同一种材质，只表达这一个意思。
6. **动效只解释变化**：新内容上浮淡入，状态切换 150ms 完成，不做装饰性循环；开启「减少动态效果」时只保留必要的进行中提示。

展示组件另有四条：**实与虚**（实际实心、计划斜纹 / 虚线）、**一种颜色**（墨阶由深到浅）、**状态才有颜色**、**今天与基准**（今天竖线、目标虚线做参照）。

任务列表的状态规则：任务行行首不放状态图标，状态由吸顶分组标题表达（图标每组一次）；标题按需要介入的程度分级——待审查加粗、进行中淡扫光、已结束降灰。

## 新增或修改组件

1. 先在 `src/pages/design-system/sections/` 对应章节加样张（`<Specimen>`），写清用途、该做 / 别做；能用现有组件组合出来就不进组件库。
2. 确实需要新组件：放进正确的层，从 `index.ts` 导出，注释写「什么时候用」。
3. 尺寸沿用现有档位：控件高 24 / 28 / 32 / 36 / 44，圆角 4 / 6 / 8 / 10 / 14（行 8、浮层与输入框 10、内容岛 14）。
   字号：中文句子和说明不小于 12px、行高不低于 1.5 倍；11px 只给单行的数字、时间、快捷键和图表里的刻度与标注；10px 只给拉丁编号（P0 · KR1 · W42）和头像缩写。侧栏任务行的元信息沿用主页的紧凑字号，不受这条约束。
4. 计数、数值类插槽用 `hasNode()` 判断——`{count && …}` 会把 0 直接渲染出来。
5. 跑展示页冒烟测试，它会检查渲染报错、React 警告、重复 id 和图表里的 NaN（shell 里设了 `NODE_ENV=production` 时 React 不导出 `act`，要显式指定 `test`）：

   ```bash
   NODE_ENV=test pnpm exec vitest run packages/web/src/pages/__tests__/DesignSystemPage.test.tsx packages/web/src/design-system
   ```
