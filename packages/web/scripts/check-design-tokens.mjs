#!/usr/bin/env node
// 设计系统护栏：扫描 src 里绕过设计 token 的类名，有违规就以非零退出。
// 规则来源：src/design-system（README 与 /design-system 展示页）。
// 用法：pnpm --filter web lint:design
//
// 确有理由的例外，在同一行或上一行写注释并说明原因：
//   // ds-allow radius: 用户消息气泡沿用 MessageBubble 的圆角
//   {/* ds-allow black-white, shadow: …… */}
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const rel = file => path.relative(SRC, file).split(path.sep).join('/')

const EXCLUDE = [
  // 设计系统本身与它的展示页
  /^design-system\//,
  /^pages\/design-system\//,
  /^pages\/DesignSystemPage\.tsx$/,
  // 测试
  /__tests__\//,
  /\.test\.tsx?$/,
  // 开发演示页，只在开发环境出现；还没决定迁移还是删除，暂不纳入
  /^pages\/(AgentDemoPage|DemoPage|LoadingPreviewPage)\.tsx$/,
  /^components\/loading\//,
  /^components\/ui\/card\.tsx$/,
]

const PALETTE = '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)'
const PROP = '(?:text|bg|border|border-[trblxy]|ring|ring-offset|fill|stroke|from|via|to|outline|decoration|divide|shadow|accent|caret|placeholder)'
const CJK = /[一-鿿]/
const TEXT_SIZE = /(?:^|[\s'"`])(?:text-xs|text-sm|text-base|text-\[\d+px\])(?=[\s'"`]|$)/

const RULES = [
  {
    id: 'palette',
    why: '颜色只来自语义 token：状态用 success / warning / info / destructive 及 *-ink，中性用 foreground / muted',
    re: new RegExp(`(?<![\\w-])(?:[a-z-]+:)*${PROP}-${PALETTE}-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\\/\\d+)?(?![\\w-])`, 'g'),
    // 项目标识色池：只用在项目圆点和名称上
    skipFile: file => file === 'components/task/adapters.ts',
  },
  {
    id: 'hex',
    why: 'index.css 是唯一的色彩来源，组件里不写 Hex / rgb() / hsl()',
    re: /(?<![\w&-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])|\brgba?\(\s*\d|\bhsla?\(\s*\d/g,
    css: true,
  },
  {
    id: 'black-white',
    why: '白底用 bg-background，遮罩用 bg-black/20，纯白字只放在 bg-*-ink 实色按钮上',
    re: /(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke)-(?:black|white)(?:\/\d+)?(?![\w-])/g,
    allow: (match, line) =>
      match === 'bg-black/20' ||
      (/^(?:[a-z-]+:)*text-white$/.test(match) && /(?<![\w-])bg-(?:success|warning|info|destructive)-ink(?![\w-])/.test(line)),
  },
  {
    id: 'weight',
    why: '字重只用 400 / 500 / 600',
    re: /(?<![\w-])(?:[a-z-]+:)*font-(?:bold|extrabold|black)(?![\w-])/g,
  },
  {
    id: 'tiny-text',
    why: '9px 及以下禁止；中文最小 12px，10–11px 只给数字、时间、路径和拉丁编号',
    re: /text-\[(\d+(?:\.\d+)?)px\]/g,
    allow: (match, line) => {
      const px = Number(match.match(/\d+(?:\.\d+)?/)[0])
      if (px >= 12) return true
      return px >= 10 && !CJK.test(line)
    },
  },
  {
    id: 'off-scale',
    why: '字号只用阶梯 26 / 22 / 15 / 14 / 13 / 12 / 11 / 10',
    re: /text-\[(?!(?:10|11|12|13|14|15|22|26)px\])\d+(?:\.\d+)?px\]|(?<![\w-])(?:[a-z-]+:)*text-(?:lg|xl|2xl|3xl|4xl|5xl)(?![\w-])/g,
    allow: match => /^text-\[\d/.test(match) && Number(match.match(/\d+(?:\.\d+)?/)[0]) < 10, // 交给 tiny-text
  },
  {
    id: 'radius',
    why: '圆角只用 4 / 6 / 8 / 10 / 14（rounded / -sm / -md / -lg / -xl）',
    re: /(?<![\w-])(?:[a-z-]+:)*rounded(?:-[trblse]{1,2})?-(?:2xl|3xl|4xl)(?![\w-])|rounded(?:-[trblse]{1,2})?-\[(?!(?:4|6|8|10|14)px\])[^\]]+\]/g,
  },
  {
    id: 'shadow',
    why: '阴影只用 shadow-raised / shadow-popover / shadow-overlay',
    re: /(?<![\w-])(?:[a-z-]+:)*shadow(?:-(?:sm|md|lg|xl|2xl|inner|\[[^\]]+\]))?(?![\w-])/g,
  },
  {
    id: 'motion',
    why: '循环动画要有 motion-reduce 降级',
    re: /(?<![\w-])animate-(?:spin|pulse|ping|bounce)(?![\w-])/g,
    allow: (match, line) => /motion-reduce:|motion-safe:/.test(line),
    css: true,
  },
  {
    id: 'focus-color',
    why: '焦点环用中性的 ring，不引入彩色描边',
    re: /focus(?:-visible|-within)?:(?:ring|border|outline)-(?:blue|indigo|sky|violet|purple|primary|brand|info)(?:-\d+)?(?![\w-])/g,
  },
  {
    id: 'faded-text',
    why: '说明文字不用透明度调浅；图标可用 /70，aria-hidden 的装饰可用 /50，占位符和禁用态除外',
    re: /(?<![\w-])((?:[a-z-]+:)*)text-muted-foreground\/(\d+)(?![\w-])/g,
    allow: (match, line) => {
      if (/(?:^|:)(?:placeholder|disabled|aria-disabled|group-disabled|peer-disabled):/.test(match)) return true
      const alpha = Number(match.split('/').pop())
      if (alpha >= 70) return true
      return alpha >= 50 && /aria-hidden/.test(line)
    },
  },
  {
    id: 'status-text',
    why: '状态色文字用 *-ink；基础状态色只给图标和圆点',
    re: /(?<![\w-])(?:[a-z-]+:)*text-(?:success|warning|info|destructive)(?:\/\d+)?(?![\w/-])/g,
    allow: (match, line) => !TEXT_SIZE.test(line),
  },
  {
    id: 'link-color',
    why: '链接是墨色加灰下划线：用 TextLink 或 textLinkClassName()，不用蓝色或其它颜色',
    re: /(?<![\w-])(?:[a-z-]+:)*prose-a:text-[\w/[\].-]+|(?<![\w-])text-info(?:-ink)?(?=[^'"`]*underline)|underline[^'"`]*(?<![\w-])text-info(?:-ink)?(?![\w-])/g,
  },
  {
    id: 'deep-import',
    why: '设计系统只从 @/design-system 入口导入',
    re: /from\s+['"]@\/design-system\/[^'"]+['"]/g,
  },
]

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:tsx?|css)$/.test(entry.name)) out.push(full)
  }
  return out
}

function allowedRules(line) {
  const match = line.match(/ds-allow\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s*:\s*\S/)
  return match ? match[1].split(',').map(id => id.trim()) : []
}

const violations = []
for (const full of walk(SRC)) {
  const file = rel(full)
  if (EXCLUDE.some(re => re.test(file))) continue
  const isCss = file.endsWith('.css')
  const lines = fs.readFileSync(full, 'utf8').split('\n')
  let inTokens = false
  lines.forEach((line, index) => {
    if (isCss) {
      // :root / .dark / @theme 是 token 的定义本身
      if (/^(?::root|\.dark|@theme)\b/.test(line.trim())) inTokens = true
      if (inTokens) {
        if (/^\}/.test(line)) inTokens = false
        return
      }
    }
    if (/^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line)) return
    const allowed = [...allowedRules(line), ...allowedRules(lines[index - 1] ?? '')]
    for (const rule of RULES) {
      if (isCss && !rule.css) continue
      if (rule.skipFile?.(file) || allowed.includes(rule.id)) continue
      for (const found of line.matchAll(rule.re)) {
        if (rule.allow?.(found[0], line)) continue
        violations.push({ file, line: index + 1, rule, match: found[0] })
      }
    }
  })
}

if (violations.length === 0) {
  console.log('design tokens: OK')
  process.exit(0)
}

const byRule = new Map()
for (const item of violations) {
  if (!byRule.has(item.rule)) byRule.set(item.rule, [])
  byRule.get(item.rule).push(item)
}
for (const [rule, items] of byRule) {
  console.log(`\n${rule.id}（${items.length}）— ${rule.why}`)
  for (const item of items) console.log(`  src/${item.file}:${item.line}  ${item.match}`)
}
console.log(`\n共 ${violations.length} 处不符合设计系统。确有理由的例外，在同一行或上一行写「ds-allow <规则>: 原因」。`)
process.exit(1)
