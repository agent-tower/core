import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { X, Languages, Cpu, Users, FolderGit2, Bell } from 'lucide-react'
import { useUIStore, type SettingsTab } from '@/stores/ui-store'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { acquireScrollLock, releaseScrollLock, getLayerCount } from '@/lib/scroll-lock'

const GeneralSettingsPage = lazy(() =>
  import('@/pages/GeneralSettingsPage').then(m => ({ default: m.GeneralSettingsPage })),
)
const ProviderSettingsPage = lazy(() =>
  import('@/pages/ProviderSettingsPage').then(m => ({ default: m.ProviderSettingsPage })),
)
const TeamSettingsPage = lazy(() =>
  import('@/pages/TeamSettingsPage').then(m => ({ default: m.TeamSettingsPage })),
)
const ProjectSettingsPage = lazy(() =>
  import('@/pages/ProjectSettingsPage').then(m => ({ default: m.ProjectSettingsPage })),
)
const NotificationSettingsPage = lazy(() =>
  import('@/pages/NotificationSettingsPage').then(m => ({ default: m.NotificationSettingsPage })),
)
const ProfileSettingsPage = lazy(() =>
  import('@/pages/ProfileSettingsPage').then(m => ({ default: m.ProfileSettingsPage })),
)

const NAV_ITEMS: Array<{ id: SettingsTab; label: string; icon: typeof Languages }> = [
  { id: 'general', label: '通用', icon: Languages },
  { id: 'agents', label: 'Agent 配置', icon: Cpu },
  { id: 'team', label: '团队协作', icon: Users },
  { id: 'projects', label: '项目配置', icon: FolderGit2 },
  { id: 'notifications', label: '通知', icon: Bell },
]

function TabContent({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case 'general':
      return <GeneralSettingsPage />
    case 'agents':
      return <ProviderSettingsPage />
    case 'team':
      return <TeamSettingsPage />
    case 'projects':
      return <ProjectSettingsPage />
    case 'notifications':
      return <NotificationSettingsPage />
    case 'agents-legacy':
      return <ProfileSettingsPage />
  }
}

function LoadingFallback() {
  const { t } = useI18n()
  return <div className="p-8 text-sm text-neutral-400">{t('加载中...')}</div>
}

export function SettingsDialog() {
  const { t } = useI18n()
  const isOpen = useUIStore(s => s.settingsOpen)
  const activeTab = useUIStore(s => s.settingsTab)
  const closeSettings = useUIStore(s => s.closeSettings)
  const setSettingsTab = useUIStore(s => s.setSettingsTab)

  const [isVisible, setIsVisible] = useState(false)
  const lockedRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true)
      if (!lockedRef.current) {
        acquireScrollLock()
        lockedRef.current = true
      }
      requestAnimationFrame(() => dialogRef.current?.focus())
    } else {
      const timer = setTimeout(() => setIsVisible(false), 200)
      if (lockedRef.current) {
        releaseScrollLock()
        lockedRef.current = false
      }
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  useEffect(() => {
    return () => {
      if (lockedRef.current) {
        releaseScrollLock()
        lockedRef.current = false
      }
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && getLayerCount() === 1) {
        closeSettings()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, closeSettings])

  if (!isVisible && !isOpen) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 transition-opacity duration-200',
        isOpen ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-white/80 backdrop-blur-sm"
        onClick={closeSettings}
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          'relative flex w-full max-w-5xl flex-col overflow-hidden bg-white rounded-xl shadow-2xl shadow-neutral-200/50 border border-neutral-100 transform transition-all duration-200 outline-none',
          'h-[min(calc(100vh-2rem),720px)] sm:h-[min(calc(100vh-3rem),720px)]',
          isOpen ? 'scale-100 translate-y-0' : 'scale-95 translate-y-2',
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-6 py-3 border-b border-neutral-100">
          <h2 className="text-sm font-semibold text-neutral-900">{t('设置')}</h2>
          <button
            onClick={closeSettings}
            className="p-1 text-neutral-400 hover:text-neutral-900 transition-colors rounded-md"
          >
            <X size={16} />
          </button>
        </div>

        {/* Mobile tab bar */}
        <div className="sm:hidden flex shrink-0 border-b border-neutral-100 overflow-x-auto">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              onClick={() => setSettingsTab(item.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs whitespace-nowrap transition-colors border-b-2',
                activeTab === item.id
                  ? 'border-neutral-900 text-neutral-900 font-medium'
                  : 'border-transparent text-neutral-500',
              )}
            >
              <item.icon size={12} />
              <span>{t(item.label)}</span>
            </button>
          ))}
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar nav (desktop) */}
          <nav className="hidden sm:block w-44 shrink-0 border-r border-neutral-100 pt-2 px-2 overflow-y-auto">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                onClick={() => setSettingsTab(item.id)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 rounded-md text-[13px] transition-colors',
                  activeTab === item.id
                    ? 'bg-neutral-100 text-neutral-900 font-medium'
                    : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50',
                )}
              >
                <item.icon size={14} />
                <span>{t(item.label)}</span>
              </button>
            ))}
          </nav>

          {/* Content area */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            <Suspense fallback={<LoadingFallback />}>
              <TabContent tab={activeTab} />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  )
}
