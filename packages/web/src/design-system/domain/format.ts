import { truncateEnd } from '@/lib/utils'

/** 项目标签只作提示：超过 9 个字宽（中文计 2）时截短并以「..」收尾，优先在连接符处断开（agent-tower → agent..） */
export function shortenProjectName(name: string): string {
  const shortened = truncateEnd(name, 9, '..')
  if (shortened === name) return name
  const head = shortened.slice(0, -2)
  const boundary = head.search(/[-_.\s][^-_.\s]*$/)
  return `${boundary >= 3 ? head.slice(0, boundary) : head}..`
}

/** 项目色类名（text-indigo-600）→ 背景色类名（bg-indigo-600），用于项目圆点 */
export function projectDotClass(colorClass: string) {
  return colorClass.replace('text-', 'bg-')
}
