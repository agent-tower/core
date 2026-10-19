import type { AnchorHTMLAttributes, ImgHTMLAttributes, LiHTMLAttributes, MouseEvent } from 'react'
import type { Components, ExtraProps, StreamdownProps } from 'streamdown'
import { ChartNoAxesCombined, Download } from 'lucide-react'
import { textLinkClassName } from '@/design-system'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { localImageUrl, resolveMessageResource, workspaceImageUrl } from '@/lib/message-resource'
import { agentArtifactDownloadUrl, resolveMessageIntent } from '@/lib/message-intent'
import { isLoopbackPreviewUrl } from '@/lib/preview-navigation'

export type OpenPreviewUrlHandler = (url: string) => void
export type OpenVisualizationHandler = (file: string) => void

interface MessageComponentOptions {
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: OpenPreviewUrlHandler
  onOpenVisualization?: OpenVisualizationHandler
  downloadSessionId?: string
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
        'max-w-[300px] max-h-[200px] object-contain rounded-lg border border-border cursor-pointer hover:opacity-90 active:opacity-90 transition-opacity',
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
  const { t } = useI18n()
  const { workingDir, onOpenWorkspaceFile, onOpenPreviewUrl, onOpenVisualization, downloadSessionId } = props
  const intent = resolveMessageIntent(href)
  const resource = resolveMessageResource(href, workingDir)
  const linkProps = { ...props } as AnchorHTMLAttributes<HTMLAnchorElement> & MessageComponentOptions
  delete linkProps.workingDir
  delete linkProps.onOpenWorkspaceFile
  delete linkProps.onOpenPreviewUrl
  delete linkProps.onOpenVisualization
  delete linkProps.downloadSessionId
  // 句子里的链接：墨色 + 灰下划线（设计系统的 TextLink），蓝色只留给「运行中 / 信息」
  const linkClassName = textLinkClassName(className)
  const inlineActionClassName = textLinkClassName('inline-flex max-w-full items-center gap-1.5 align-middle font-medium')

  if (intent?.type === 'codex-inline-visualization') {
    if (!onOpenVisualization) return <code title={intent.file}>{intent.file}</code>
    return (
      <button
        type="button"
        onClick={() => onOpenVisualization(intent.file)}
        title={t('Open visualization')}
        className={inlineActionClassName}
      >
        <ChartNoAxesCombined className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{intent.file}</span>
      </button>
    )
  }

  if (intent?.type === 'agent-download') {
    if (!downloadSessionId) return <code title={intent.file}>{intent.file}</code>
    return (
      <a
        href={agentArtifactDownloadUrl(downloadSessionId, intent.file)}
        download={intent.file.split('/').at(-1)}
        title={t('Download file')}
        className={inlineActionClassName}
      >
        <Download className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{intent.file.split('/').at(-1)}</span>
      </a>
    )
  }

  if (onOpenPreviewUrl && isLoopbackPreviewUrl(href)) {
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      if (event.defaultPrevented) return
      event.preventDefault()
      onOpenPreviewUrl(href)
    }
    return <a href={href} onClick={handleClick} className={linkClassName} {...linkProps}>{children}</a>
  }

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
  onOpenPreviewUrl,
  onOpenVisualization,
  downloadSessionId,
}: MessageComponentOptions): Components {
  return {
    ...streamdownComponents,
    a: (props) => (
      <MarkdownLink
        {...props}
        workingDir={workingDir}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        onOpenPreviewUrl={onOpenPreviewUrl}
        onOpenVisualization={onOpenVisualization}
        downloadSessionId={downloadSessionId}
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
