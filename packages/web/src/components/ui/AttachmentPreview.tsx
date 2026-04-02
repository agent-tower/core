import { X, FileText, Image, Loader2 } from 'lucide-react'
import type { PendingAttachment } from '@/hooks/use-attachments'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

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
    <div className="flex flex-wrap gap-2 px-4 pt-3 pb-1">
      {files.map((f) => (
        <AttachmentItem key={f.tempId} item={f} onRemove={onRemove} />
      ))}
    </div>
  )
}

function AttachmentItem({ item, onRemove }: { item: PendingAttachment; onRemove: (id: string) => void }) {
  const isImage = item.file.type.startsWith('image/')
  const isError = item.status === 'error'
  const isUploading = item.status === 'uploading'

  return (
    <div
      className={`relative group flex items-center gap-2 px-3 py-2 rounded-lg border text-xs max-w-[200px] ${
        isError
          ? 'border-red-200 bg-red-50 text-red-600'
          : 'border-neutral-200 bg-neutral-50 text-neutral-700'
      }`}
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
            <Loader2 size={16} className="animate-spin text-neutral-400" />
          ) : isImage ? (
            <Image size={16} className="text-neutral-400" />
          ) : (
            <FileText size={16} className="text-neutral-400" />
          )}
        </span>
      )}

      {/* 文件名 + 大小 */}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.file.name}</div>
        {isError ? (
          <div className="truncate text-red-500">{item.error}</div>
        ) : (
          <div className="text-neutral-400">{formatSize(item.file.size)}</div>
        )}
      </div>

      {/* 删除按钮 */}
      <button
        onClick={() => onRemove(item.tempId)}
        className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-5 h-5 rounded-full bg-neutral-700 text-white hover:bg-neutral-900 transition-colors"
      >
        <X size={10} />
      </button>
    </div>
  )
}
