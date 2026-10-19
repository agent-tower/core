import type { ComponentProps } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Slot } from 'radix-ui'
import { textLinkClassName } from './text-link-styles'

export interface TextLinkProps extends ComponentProps<'a'> {
  /** 站外链接：新标签页打开，文字后跟一个 ↗ */
  external?: boolean
  /** 把样式交给唯一子元素（如路由 Link） */
  asChild?: boolean
}

/**
 * 文字链接：正文、说明、Agent 回复里的链接。
 * 独立的「查看文档」这类操作用 `<Button variant="link">`，它不折行、字重 500。
 */
export function TextLink({ external = false, asChild = false, className, children, ...props }: TextLinkProps) {
  if (asChild) {
    return (
      <Slot.Root className={textLinkClassName(className)} {...props}>
        {children}
      </Slot.Root>
    )
  }

  return (
    <a
      className={textLinkClassName(className)}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : null)}
      {...props}
    >
      {children}
      {external && <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-[0.9em] align-[-0.1em]" />}
    </a>
  )
}
