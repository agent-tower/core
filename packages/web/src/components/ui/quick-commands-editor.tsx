import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import type { QuickCommand } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'

export interface QuickCommandsEditorProps {
  value: QuickCommand[]
  onChange: (commands: QuickCommand[]) => void
}

export function QuickCommandsEditor({ value, onChange }: QuickCommandsEditorProps) {
  const { t } = useI18n()
  const [newName, setNewName] = useState('')
  const [newCommand, setNewCommand] = useState('')

  const handleAdd = () => {
    const name = newName.trim()
    const command = newCommand.trim()
    if (!name || !command) return
    onChange([...value, { name, command }])
    setNewName('')
    setNewCommand('')
  }

  const handleRemove = (index: number) => {
    onChange(value.filter((_, i) => i !== index))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault()
      handleAdd()
    }
  }

  return (
    <div>
      {/* 已配置的命令列表 */}
      {value.length > 0 && (
        <div className="border border-neutral-200 rounded-lg mb-2 divide-y divide-neutral-100">
          {value.map((cmd, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2 group">
              <span className="text-sm font-medium text-neutral-700 w-28 shrink-0 truncate">{cmd.name}</span>
              <span className="text-sm font-mono text-neutral-500 flex-1 truncate">{cmd.command}</span>
              <button
                onClick={() => handleRemove(i)}
                className="p-0.5 text-neutral-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 添加新命令 */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('名称')}
          className="w-28 shrink-0 px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-neutral-300"
        />
        <input
          type="text"
          value={newCommand}
          onChange={(e) => setNewCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('命令')}
          className="flex-1 px-3 py-2 border border-neutral-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-neutral-300"
        />
        <button
          onClick={handleAdd}
          disabled={!newName.trim() || !newCommand.trim()}
          className="flex items-center gap-1 px-3 py-2 text-sm bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          <Plus size={14} />
          <span>{t('添加')}</span>
        </button>
      </div>
    </div>
  )
}
