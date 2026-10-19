import { X, FileText, Image, Loader2 } from 'lucide-react'
import type { PendingAttachment } from '@/hooks/use-attachments'
import { getApiBaseUrl } from '@/lib/api-base-url'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const API_BASE_URL = getApiBaseUrl()

interface AttachmentPreviewProps {
  files: PendingAttachment[]
  onRemove: (tempId: string) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function AttachmentPreview({ files, onRemove }: AttachmentPreviewProps) {
  if (files.length === 0) return null

  return (
    <div aria-label="Attachments" className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
      {files.map((f) => (
        <AttachmentItem key={f.tempId} item={f} onRemove={onRemove} />
      ))}
    </div>
  )
}

function AttachmentItem({ item, onRemove }: { item: PendingAttachment; onRemove: (id: string) => void }) {
  const { t } = useI18n()
  const isImage = item.file.type.startsWith('image/')
  const isError = item.status === 'error'
  const isUploading = item.status === 'uploading'

  return (
    <div
      className={cn(
        'relative group flex items-center gap-2 px-3 py-2 rounded-lg border text-xs max-w-[200px]',
        isError
          ? 'border-destructive/25 bg-destructive/[0.06] text-destructive-ink'
          : 'border-border bg-muted/50 text-foreground/80',
      )}
    >
      {/* 图标/缩略图 */}
      {isImage && item.status === 'done' && item.attachment ? (
        <img
          src={`${API_BASE_URL}${item.attachment.url}`}
          alt={item.file.name}
          className="w-8 h-8 rounded object-cover flex-shrink-0"
        />
      ) : (
        <span className="flex-shrink-0">
          {isUploading ? (
            <Loader2 size={16} className="animate-spin motion-reduce:[animation-duration:2.4s] text-muted-foreground" />
          ) : isImage ? (
            <Image size={16} className="text-muted-foreground" />
          ) : (
            <FileText size={16} className="text-muted-foreground" />
          )}
        </span>
      )}

      {/* 文件名 + 大小 */}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.file.name}</div>
        {isError ? (
          <div className="truncate">{item.error}</div>
        ) : (
          <div className="text-muted-foreground">{formatSize(item.file.size)}</div>
        )}
      </div>

      {/* 删除按钮：悬停或键盘聚焦时出现；触屏没有悬停，一直显示 */}
      <button
        type="button"
        onClick={() => onRemove(item.tempId)}
        aria-label={`${t('Remove')} ${item.file.name}`}
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-inverse text-inverse-foreground opacity-0 shadow-raised transition-opacity hover:bg-inverse/90 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 group-hover:opacity-100 pointer-coarse:opacity-100"
      >
        <X size={10} />
      </button>
    </div>
  )
}
