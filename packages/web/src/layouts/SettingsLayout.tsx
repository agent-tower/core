import { NavLink, Outlet } from 'react-router-dom'
import { ArrowLeft, Cpu, Bell, FolderGit2, Languages, Users, Cable } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { BrandLogo } from '@/components/BrandLogo'
import { useDesktopNavigate, useDesktopTitlebar } from '@/lib/desktop-titlebar'

const NAV_ITEMS = [
  { to: '/settings/general', label: '通用', icon: Languages },
  { to: '/settings/agents', label: 'Agent 配置', icon: Cpu },
  { to: '/settings/team', label: '团队协作', icon: Users },
  { to: '/settings/projects', label: '项目配置', icon: FolderGit2 },
  { to: '/settings/notifications', label: '通知', icon: Bell },
  { to: '/settings/mcp', label: 'MCP 配置', icon: Cable },
]

export function SettingsLayout() {
  const navigate = useDesktopNavigate()
  const { preserveDesktopSearch } = useDesktopTitlebar()
  const { t } = useI18n()

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar — matches homepage h-12 style */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-border/60 bg-background shrink-0 z-30">
        <div className="flex items-center gap-2.5">
          <BrandLogo />
          <span className="text-sm font-bold tracking-tight text-foreground">Agent Tower</span>
          <span className="text-border text-sm" aria-hidden="true">/</span>
          <span className="text-sm text-muted-foreground">{t('设置')}</span>
        </div>
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ArrowLeft size={14} />
          <span>{t('返回')}</span>
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <nav aria-label={t('设置')} className="w-48 border-r border-border/60 pt-3 px-2 shrink-0">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={preserveDesktopSearch(item.to)}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                  isActive
                    ? 'bg-muted text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`
              }
            >
              <item.icon size={14} aria-hidden="true" />
              <span>{t(item.label)}</span>
            </NavLink>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
