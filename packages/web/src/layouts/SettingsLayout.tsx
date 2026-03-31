import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { ArrowLeft, Cpu, Bell, FolderGit2, Languages } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

const NAV_ITEMS = [
  { to: '/settings/general', label: '通用', icon: Languages },
  { to: '/settings/agents', label: 'Agent 配置', icon: Cpu },
  { to: '/settings/projects', label: '项目配置', icon: FolderGit2 },
  { to: '/settings/notifications', label: '通知', icon: Bell },
]

const LOGO_ICON = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="text-neutral-900"
  >
    <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor" />
    <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function SettingsLayout() {
  const navigate = useNavigate()
  const { t } = useI18n()

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Top bar — matches homepage h-12 style */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-neutral-100 bg-white shrink-0 z-30">
        <div className="flex items-center gap-2.5">
          {LOGO_ICON}
          <span className="text-sm font-bold tracking-tight text-neutral-900">Agent Tower</span>
          <span className="text-neutral-200 text-sm">/</span>
          <span className="text-sm text-neutral-500">{t('设置')}</span>
        </div>
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-900 transition-colors"
        >
          <ArrowLeft size={14} />
          <span>{t('返回')}</span>
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <nav className="w-48 border-r border-neutral-100 pt-3 px-2 shrink-0">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] transition-colors ${
                  isActive
                    ? 'bg-neutral-100 text-neutral-900 font-medium'
                    : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50'
                }`
              }
            >
              <item.icon size={14} />
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
