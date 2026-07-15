import type { AnchorHTMLAttributes, ImgHTMLAttributes, LiHTMLAttributes, MouseEvent } from 'react'
import type { Components, ExtraProps, StreamdownProps } from 'streamdown'
import { cn } from '@/lib/utils'
import { localImageUrl, resolveMessageResource, workspaceImageUrl } from '@/lib/message-resource'

interface MessageComponentOptions {
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
}

const BaseMarkdownImage = ({
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

const MarkdownLink = ({
  href = '',
  children,
  node: _node,
  onClick,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps & MessageComponentOptions) => {
  const { workingDir, onOpenWorkspaceFile } = props
  const resource = resolveMessageResource(href, workingDir)
  const linkProps = { ...props } as AnchorHTMLAttributes<HTMLAnchorElement> & MessageComponentOptions
  delete linkProps.workingDir
  delete linkProps.onOpenWorkspaceFile
  const linkClassName = cn(
    'text-blue-600 underline decoration-blue-300 underline-offset-2 transition-colors hover:text-blue-700 hover:decoration-blue-500',
    className,
  )

  if (resource.type === 'workspace-file' && onOpenWorkspaceFile) {
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      if (event.defaultPrevented) return
      event.preventDefault()
      onOpenWorkspaceFile(resource.path, resource.line, resource.column)
    }
    return <a href={href} onClick={handleClick} className={linkClassName} {...linkProps}>{children}</a>
  }

  if (resource.type === 'unknown-local' || resource.type === 'workspace-file') {
    const path = resource.path
    return <code title={path}>{children}</code>
  }

  const resolvedHref = resource.url
  return <a href={resolvedHref} onClick={onClick} className={linkClassName} {...linkProps}>{children}</a>
}

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
  img: BaseMarkdownImage,
  li: MarkdownListItem,
}

export function createMessageStreamdownComponents({
  workingDir,
  onOpenWorkspaceFile,
}: MessageComponentOptions): Components {
  return {
    ...streamdownComponents,
    a: (props) => (
      <MarkdownLink
        {...props}
        workingDir={workingDir}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ),
    img: (props) => {
      const resource = resolveMessageResource(props.src ?? '', workingDir)
      const src = resource.type === 'workspace-file' && workingDir
        ? workspaceImageUrl(workingDir, resource.path)
        : resource.type === 'attachment'
          ? resource.url
          : resource.type === 'unknown-local'
            ? localImageUrl(resource.path)
            : props.src
      return <BaseMarkdownImage {...props} src={src} />
    },
  }
}

export const streamdownMermaidControls: StreamdownProps['controls'] = {
  mermaid: {
    download: true,
    copy: true,
    fullscreen: true,
    panZoom: true,
  },
}
