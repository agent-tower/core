import { useState, useRef, useEffect, useCallback } from 'react'
import { Pencil, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUpdateTask } from '@/hooks/use-tasks'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface EditableTaskTitleProps {
  taskId: string
  title: string
  readOnly?: boolean
  onTitleChange?: (newTitle: string) => void
  className?: string
  titleClassName?: string
  compact?: boolean
}

const TITLE_MAX_LENGTH = 200
const WARNING_THRESHOLD = 180

export function EditableTaskTitle({
  taskId,
  title,
  readOnly = false,
  onTitleChange,
  className,
  titleClassName,
  compact = false,
}: EditableTaskTitleProps) {
  const { t } = useI18n()
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(title)
  const [isHovered, setIsHovered] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const updateTask = useUpdateTask()

  // 同步外部 title 变化
  useEffect(() => {
    if (!isEditing) {
      setEditValue(title)
    }
  }, [title, isEditing])

  // 进入编辑模式时自动聚焦
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // 点击外部区域保存
  useEffect(() => {
    if (!isEditing) return

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        handleSave()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isEditing, editValue])

  const handleStartEdit = useCallback(() => {
    if (readOnly) return
    setIsEditing(true)
    setEditValue(title)
  }, [readOnly, title])

  const handleCancel = useCallback(() => {
    setIsEditing(false)
    setEditValue(title)
  }, [title])

  const handleSave = useCallback(async () => {
    const trimmedValue = editValue.trim()

    // 验证：不允许空标题
    if (!trimmedValue) {
      setEditValue(title)
      setIsEditing(false)
      return
    }

    // 如果没有变化，直接退出
    if (trimmedValue === title) {
      setIsEditing(false)
      return
    }

    try {
      await updateTask.mutateAsync({
        id: taskId,
        title: trimmedValue,
      })
      onTitleChange?.(trimmedValue)
      setIsEditing(false)
    } catch (error) {
      console.error('Failed to update task title:', error)
      // 失败时回滚
      setEditValue(title)
    }
  }, [editValue, title, taskId, updateTask, onTitleChange])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      }
    },
    [handleSave, handleCancel]
  )

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    // 限制最大长度
    if (value.length <= TITLE_MAX_LENGTH) {
      setEditValue(value)
    }
  }, [])

  const charCount = editValue.length
  const isNearLimit = charCount >= WARNING_THRESHOLD
  const isAtLimit = charCount >= TITLE_MAX_LENGTH

  if (isEditing) {
    return (
      <div ref={containerRef} className={cn('flex flex-col gap-2', className)}>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={updateTask.isPending}
            className={cn(
              'flex-1 min-w-0 px-2 py-1 text-lg font-semibold bg-background border border-input rounded-md',
              'focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              compact && 'text-base py-0.5',
              titleClassName
            )}
            placeholder={t('输入任务标题')}
          />
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size={compact ? 'sm' : 'default'}
              variant="ghost"
              onClick={handleSave}
              disabled={updateTask.isPending || !editValue.trim()}
              className="h-8 w-8 p-0"
            >
              {updateTask.isPending ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Check size={16} />
              )}
            </Button>
            <Button
              size={compact ? 'sm' : 'default'}
              variant="ghost"
              onClick={handleCancel}
              disabled={updateTask.isPending}
              className="h-8 w-8 p-0"
            >
              <X size={16} />
            </Button>
          </div>
        </div>
        {isNearLimit && (
          <div
            className={cn(
              'text-xs',
              isAtLimit ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {charCount} / {TITLE_MAX_LENGTH} {t('字符')}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn('group flex items-center gap-2 min-w-0', className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <h2
        onClick={handleStartEdit}
        className={cn(
          'flex-1 min-w-0 text-lg font-semibold text-foreground break-words line-clamp-2',
          !readOnly && 'cursor-text hover:text-foreground/80 transition-colors',
          compact && 'text-base',
          titleClassName
        )}
      >
        {title}
      </h2>
      {!readOnly && isHovered && (
        <Button
          size="sm"
          variant="ghost"
          onClick={handleStartEdit}
          className="h-7 w-7 p-0 shrink-0 opacity-60 hover:opacity-100"
          title={t('编辑标题')}
        >
          <Pencil size={14} />
        </Button>
      )}
    </div>
  )
}
