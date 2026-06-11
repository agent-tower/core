# Agent Tower 设计规范（Design System）

> 风格基调：Codex 式「白底画布 + 黑色主调 + 轻盈阴影」的浅色优先设计。
> 本期仅做浅色模式（Light-first）；暗色主题切换为后续迭代，不在本期范围。
> Token 命名沿用 shadcn/ui 变量体系，前端零组件改动即可生效（`packages/web/src/index.css`）。

---

## 1. 设计理念与氛围

Agent Tower 是 AI Agent 任务看板 + 终端编排工具。设计目标是「自然得体」：

- **白色是结构**：纯白 `#ffffff` 作为主画布，颜色只来自状态徽章与项目标识，界面像一组排布整齐的工作卡片。
- **黑色是主调**：主按钮、选中强调、CTA 一律使用 Charcoal 黑（`#181e25` 系）；蓝色仅作为 info 语义色少量出现（链接、信息提示），不承担品牌主调。
- **低对比阴影 + 圆角**：阴影不超过 8% 黑色透明度，圆角适中（8–16px），轻盈但不漂浮。
- **状态即信息**：任务状态（Pending / Running / Review / Done / Cancelled）通过稳定的语义色系统表达，颜色含义全站唯一。

---

## 2. 色彩系统

### 2.1 主色（黑色系）

| 名称 | Hex | oklch | 用途 |
|------|-----|-------|------|
| Charcoal（主色） | `#181e25` | `oklch(0.235 0.015 252)` | 主按钮、重点 CTA、选中强调、`--brand` |
| 主文本 | `#222428` | `oklch(0.24 0.006 258)` | `--foreground` |
| 中性焦点环 | `#a9adb5` 级 | `oklch(0.708 0.008 264)` | `--ring`，输入框 focus 边框（中性灰，不用蓝） |

蓝色不再是品牌色；仅保留为 info 语义（见 §2.3），用于链接与信息提示等少量触点。

### 2.2 中性色（冷调灰，hue ≈ 255–264）

| 角色 | Hex（近似） | oklch | Token |
|------|------------|-------|-------|
| 主文本 | `#222428` | `oklch(0.235 0.006 258)` | `--foreground` |
| 主按钮底（Charcoal） | `#181e25` | `oklch(0.235 0.015 252)` | `--primary` |
| 次级文本 | `#6b7280` | `oklch(0.55 0.016 262)` | `--muted-foreground` |
| 浅灰面 | `#f2f3f5` | `oklch(0.967 0.003 264)` | `--muted` / `--secondary` |
| 边框 | `#e5e7eb` | `oklch(0.928 0.006 264.531)` | `--border` / `--input` |
| 画布 | `#ffffff` | `oklch(1 0 0)` | `--background` / `--card` |

原则：中性色统一带极轻微的冷蓝倾向（chroma 0.003–0.016），替代原先零彩度纯灰，使界面更「润」而变化不突兀。

### 2.3 语义色

| 语义 | Hex | oklch | Token | Tailwind 映射 |
|------|-----|-------|-------|---------------|
| Success | `#16a34a` | `oklch(0.627 0.194 149.214)` | `--success` | `bg-success` / `text-success` |
| Warning | `#d97706` | `oklch(0.666 0.179 58.318)` | `--warning` | `bg-warning` / `text-warning` |
| Error | `#dc2626` | `oklch(0.577 0.245 27.325)` | `--destructive` | `bg-destructive` |
| Info | `#2563eb` | `oklch(0.546 0.245 262.881)` | `--info` | `bg-info` / `text-info` |
| Brand（=Charcoal） | `#181e25` | `oklch(0.235 0.015 252)` | `--brand` | `bg-brand` / `text-brand` |

### 2.4 任务状态色映射（与现有看板约定对齐）

| UI 状态 | 图标/文字色 | 徽章底色 | 含义 |
|---------|------------|----------|------|
| Pending | `text-neutral-600` | `bg-neutral-100` | 待开始，无色彩噪音 |
| Running | `text-blue-600` | `bg-blue-50` | 进行中，呼应品牌蓝，可加 `animate-pulse` |
| Review | `text-amber-600` | `bg-amber-100 text-amber-700` | 待审查，黄色提醒 |
| Done | `text-emerald-600` | `bg-emerald-50` | 已完成 |
| Cancelled | `text-neutral-500` | — | 已取消，降权处理 |
| Agent 活跃点 | `bg-emerald-500` + `animate-ping` | — | 实时活动指示 |

规则：同一语义在徽章、图标、下拉菜单、详情页中必须使用同一色相；禁止新增第二种「进行中」颜色。

### 2.5 项目标识色（哈希分配池）

`indigo-600 / emerald-600 / rose-600 / amber-600 / cyan-600 / violet-600 / teal-600 / pink-600`
仅用于项目圆点与项目名，禁止用于按钮或大面积底色。

---

## 3. 排版

- **字体栈**：系统栈优先，不引入 Web 字体（保持加载性能）：
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
- **等宽（终端/代码）**：`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
- **基准字号**：16px（html）；UI 主体 14px（`text-sm`）。

| 层级 | 字号 | 字重 | 行高 | 用途 |
|------|------|------|------|------|
| Page Title | 20px | 600 | 1.4 | 页面/项目标题 |
| Section | 16px | 600 | 1.5 | 区块标题、对话框标题 |
| Body | 14px | 400–500 | 1.5 | 列表、表单、正文 |
| Caption | 12px | 400–500 | 1.5 | 元信息、分支名、时间戳 |
| Micro/Badge | 11–12px | 600 | 1.25 | 徽章、计数、标签 |

原则：标题字重 500–600，700 仅用于正文内强调；正文统一 1.5 行高。

---

## 4. 间距・圆角・阴影

### 4.1 间距（4px 基准）

`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`；卡片内边距 12–16px；看板列间距 16px；区块间距 24–32px。

### 4.2 圆角（`--radius: 0.625rem` = 10px 基准）

| 级别 | 值 | 用途 |
|------|----|------|
| sm | 6px | 小标签、输入框内元素 |
| md | 8px | 按钮、输入框 |
| lg | 10px | 卡片、菜单、弹层 |
| xl–2xl | 14–18px | 对话框、大容器 |
| full | 9999px | 状态徽章、计数 pill、活跃指示点 |

### 4.3 阴影（黑色透明度 ≤ 0.08）

| 层级 | 值 | 用途 |
|------|----|------|
| Level 0 | 无阴影，仅 `border` | 看板列、内嵌面板 |
| Level 1 | `0 1px 2px rgba(0,0,0,0.05)` | 任务卡片默认 |
| Level 2 | `0 4px 6px rgba(0,0,0,0.08)` | 卡片 hover、下拉菜单 |
| Level 3 | `0 12px 16px -4px rgba(36,36,36,0.08)` | 对话框、拖拽中的卡片 |

禁止使用 >0.16 透明度的阴影；深度优先靠边框与背景分层表达。

---

## 5. 组件规范

### 5.1 按钮

| 类型 | 样式 | 用途 |
|------|------|------|
| Primary | `bg-primary`（Charcoal `#181e25`）白字，radius 8px | 主操作（创建任务、启动 Agent） |
| Brand CTA | `bg-brand`（= Charcoal）白字 | 强引导（如空状态主按钮），与 Primary 同色 |
| Secondary | `bg-secondary`（`#f2f3f5`）深灰字 | 次级操作 |
| Ghost | 透明底，hover `bg-accent` | 工具栏、图标按钮 |
| Destructive | `text-red-600`，hover `bg-red-50`；确认弹窗中实底 `bg-destructive` | 删除类 |

### 5.2 任务卡片（看板）

- 白底 + `border-border` + radius 10px + Level 1 阴影；hover 升 Level 2。
- 选中态：白底 + 左侧 2px Charcoal 黑指示条（`border-brand`）。
- 拖拽悬停目标：`bg-info/5 ring-1 ring-info/30`；占位虚线框沿用 info 淡蓝（拖拽是瞬时态，允许少量蓝）。

### 5.3 状态徽章

全圆角 pill（9999px），11–12px / 600 字重，按 §2.4 配色；Review 列计数徽章 `bg-amber-100 text-amber-700`。

### 5.4 终端 / 日志面板

终端区域是全站唯一允许的常驻深色面（`#181e25` 系），与浅色 UI 形成「窗口中的窗口」对比；面板圆角 10px，标题栏浅色。

---

## 6. 交互状态（必须覆盖四态）

| 状态 | 设计 |
|------|------|
| **加载态** | 列表/看板用 Skeleton（`bg-muted` 圆角块 + 微弱 shimmer）；按钮内联 Spinner + 禁用；首屏骨架结构与真实布局一致，避免跳动 |
| **空状态** | 居中：浅灰图标（48px）+ 一句话说明（`text-muted-foreground`）+ Brand CTA 按钮；看板空列显示虚线占位框 |
| **错误态** | 内联错误：`text-destructive` + 图标 + 重试按钮；全局错误用 toast；表单错误紧贴字段下方 12px 红字 |
| **极限态** | 长标题单行截断 + tooltip；分支名 `max-w` + 截断；任务数 >99 显示 `99+`；列表 >50 项启用虚拟滚动或分页 |

---

## 7. 无障碍（a11y）

- **对比度**：正文 ≥ 4.5:1（`--muted-foreground` 取 L0.55 保证灰字达标）；大字号/图标 ≥ 3:1；禁止 `#8e8e93` 级浅灰作正文。
- **焦点环**：全局 `--ring` 为中性灰（oklch 0.708），输入框 focus 表现为「边框加深」而非彩色描边；键盘焦点 `focus-visible:ring-2`，禁止 `outline: none` 不补焦点样式。
- **键盘导航**：看板卡片可 Tab 聚焦，Enter 打开详情，Esc 关闭弹层；对话框焦点圈定（focus trap）并在关闭后归还焦点。
- **动效降级**：所有循环动画（pulse/ping/打点）必须包含 `prefers-reduced-motion: reduce` 降级（现有 `.active-work-dots` 已实现，新动画沿用）。
- **状态不只靠颜色**：状态徽章同时含图标 + 文字，色盲用户可辨。

---

## 8. Token → 代码映射

`packages/web/src/index.css` 的 `:root` 为唯一色彩来源；组件一律使用语义类（`bg-background` / `text-muted-foreground` / `border-border` / `ring-ring` / `bg-success` …），禁止新增硬编码 Hex。

新增语义 Token（已在 `@theme inline` 注册，可直接当 Tailwind 颜色用）：

```
--brand / --brand-foreground
--success / --success-foreground
--warning / --warning-foreground
--info / --info-foreground
```

## 9. Do / Don't

**Do**
- 白底为主，颜色留给状态徽章与项目标识
- 主按钮、选中态、CTA 统一 Charcoal 黑；焦点用中性灰边框加深
- 状态色严格遵循 §2.4 映射
- 阴影轻、圆角适中、间距 4px 体系

**Don't**
- 不给内容区加彩色底
- 不在按钮/大面积使用项目标识色
- 不引入第二种蓝或第二种「进行中」色
- 不使用纯黑 `#000` 文本与重阴影
- 本期不做暗色主题切换（`.dark` 仅保持变量完整，不作为交付面）
