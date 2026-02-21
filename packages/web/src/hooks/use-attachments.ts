import { useState, useCallback, useRef } from 'react'
import type { Attachment } from '@agent-tower/shared'
import { isTunnelAccess, getTunnelToken } from '@/lib/tunnel-token'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

export interface PendingAttachment {
  /** 临时 ID（上传前） */
  tempId: string
  file: File
  /** 上传进度 0-100 */
  progress: number
  /** 上传状态 */
  status: 'uploading' | 'done' | 'error'
  /** 上传完成后的附件信息 */
  attachment?: Attachment
  /** 错误信息 */
  error?: string
}

async function uploadFile(file: File): Promise<Attachment> {
  const formData = new FormData()
  formData.append('file', file)

  const headers: Record<string, string> = {}
  if (isTunnelAccess()) {
    const token = getTunnelToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${API_BASE_URL}/attachments/upload`, {
    method: 'POST',
    body: formData,
    headers,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Upload failed (${res.status})`)
  }

  return res.json()
}

let tempIdCounter = 0

export function useAttachments() {
  const [files, setFiles] = useState<PendingAttachment[]>([])
  const filesRef = useRef(files)
  filesRef.current = files

  const addFiles = useCallback(async (newFiles: File[]) => {
    const entries: PendingAttachment[] = newFiles.map((file) => ({
      tempId: `tmp-${++tempIdCounter}`,
      file,
      progress: 0,
      status: 'uploading' as const,
    }))

    setFiles((prev) => [...prev, ...entries])

    // 并发上传
    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          const attachment = await uploadFile(entry.file)
          setFiles((prev) =>
            prev.map((f) =>
              f.tempId === entry.tempId
                ? { ...f, status: 'done' as const, progress: 100, attachment }
                : f
            )
          )
        } catch (err) {
          setFiles((prev) =>
            prev.map((f) =>
              f.tempId === entry.tempId
                ? { ...f, status: 'error' as const, error: err instanceof Error ? err.message : 'Upload failed' }
                : f
            )
          )
        }
      })
    )
  }, [])

  const removeFile = useCallback((tempId: string) => {
    setFiles((prev) => prev.filter((f) => f.tempId !== tempId))
  }, [])

  const clear = useCallback(() => {
    setFiles([])
  }, [])

  /** 获取所有上传完成的附件，生成 markdown 链接文本 */
  const buildMarkdownLinks = useCallback((): string => {
    const doneFiles = filesRef.current.filter((f) => f.status === 'done' && f.attachment)
    if (doneFiles.length === 0) return ''

    return doneFiles
      .map((f) => {
        const att = f.attachment!
        const isImage = att.mimeType.startsWith('image/')
        const prefix = isImage ? '!' : ''
        return `${prefix}[${att.originalName}](${att.storagePath})`
      })
      .join('\n')
  }, [])

  const hasFiles = files.length > 0
  const isUploading = files.some((f) => f.status === 'uploading')

  return { files, addFiles, removeFile, clear, buildMarkdownLinks, hasFiles, isUploading }
}
