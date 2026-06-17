import type { ImgHTMLAttributes, LiHTMLAttributes } from 'react'
import type { Components, ExtraProps, StreamdownProps } from 'streamdown'
import { cn } from '@/lib/utils'

const MarkdownImage = ({
  src,
  alt,
  className,
  node: _node,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & ExtraProps) => (
  <a href={src} target="_blank" rel="noopener noreferrer" className="inline-block">
    <img
      src={src}
      alt={alt}
      {...props}
      className={cn(
        'max-w-[300px] max-h-[200px] object-contain rounded-lg border border-neutral-200 cursor-pointer hover:opacity-90 active:opacity-90 transition-opacity',
        className,
      )}
    />
  </a>
)

const MarkdownListItem = ({
  children,
  className,
  node: _node,
  ...props
}: LiHTMLAttributes<HTMLLIElement> & ExtraProps) => (
  <li className={cn('py-0 pl-0 [&>p]:inline', className)} {...props}>
    {children}
  </li>
)

export const streamdownComponents: Components = {
  img: MarkdownImage,
  li: MarkdownListItem,
}

export const streamdownMermaidControls: StreamdownProps['controls'] = {
  mermaid: {
    download: true,
    copy: true,
    fullscreen: true,
    panZoom: true,
  },
}
