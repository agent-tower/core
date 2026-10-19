import React from 'react'
import { Zap, Play, ChevronDown } from 'lucide-react'
import type { QuickCommand } from '@agent-tower/shared'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/design-system'
import { useI18n } from '@/lib/i18n'

export interface QuickCommandsPopoverProps {
  commands: QuickCommand[]
  onSelect: (command: string) => void
}

/**
 * 终端标签栏上的快捷命令：触发按钮跟着终端面的配色，弹出的是普通浅色菜单
 * （键盘上下选择、选中即执行并关闭）。
 */
export const QuickCommandsPopover: React.FC<QuickCommandsPopoverProps> = React.memo(
  function QuickCommandsPopover({ commands, onSelect }) {
    const { t } = useI18n()

    if (commands.length === 0) return null

    return (
      <>
        {/* 分隔线 */}
        <div className="w-px h-4 bg-terminal-border mx-1 shrink-0" />

        <Menu>
          <MenuTrigger className="group mx-1 flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium text-terminal-muted-foreground transition-colors hover:bg-terminal-accent hover:text-terminal-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-muted-foreground data-[state=open]:bg-terminal-accent data-[state=open]:text-terminal-foreground">
            <Zap size={12} />
            <span>{t('快捷命令')}</span>
            <ChevronDown size={10} className="transition-transform group-data-[state=open]:rotate-180" />
          </MenuTrigger>
          <MenuContent align="end" className="w-72">
            <div className="max-h-[240px] overflow-y-auto">
              {commands.map((cmd, i) => (
                <MenuItem
                  key={i}
                  icon={<Play className="mt-0.5" />}
                  onSelect={() => onSelect(cmd.command)}
                  className="items-start"
                >
                  <span className="block truncate font-medium text-foreground">{cmd.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{cmd.command}</span>
                </MenuItem>
              ))}
            </div>
          </MenuContent>
        </Menu>
      </>
    )
  }
)
