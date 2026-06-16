import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Settings, X, Languages, Cpu, Users, FolderGit2, Bell, Cable } from 'lucide-react'
import { useUIStore, type SettingsTab } from '@/stores/ui-store'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { acquireScrollLock, releaseScrollLock, getLayerCount } from '@/lib/scroll-lock'
import { SettingsPageContainer, SettingsFormSkeleton } from '@/components/settings/SettingsSection'

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
const McpSettingsPage = lazy(() =>
  import('@/pages/McpSettingsPage').then(m => ({ default: m.McpSettingsPage })),
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
  { id: 'mcp', label: 'MCP 配置', icon: Cable },
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
    case 'mcp':
      return <McpSettingsPage />
    case 'agents-legacy':
      return <ProfileSettingsPage />
  }
}

function LoadingFallback() {
  return (
    <SettingsPageContainer>
      <SettingsFormSkeleton rows={3} />
    </SettingsPageContainer>
  )
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
        'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 transition-opacity duration-200 motion-reduce:transition-none',
        isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
      )}
    >
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        onClick={closeSettings}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('设置')}
        className={cn(
          'relative flex w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl bg-background shadow-[0_12px_16px_-4px_rgba(36,36,36,0.08)] ring-1 ring-foreground/5 transform transition-all duration-200 outline-none motion-reduce:transition-none',
          'h-[min(calc(100vh-1.5rem),840px)] sm:h-[min(calc(100vh-3rem),840px)]',
          isOpen ? 'scale-100 translate-y-0' : 'scale-[0.97] translate-y-1',
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-muted/40 px-5 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
              <Settings size={14} />
            </div>
            <h2 className="text-[15px] font-semibold text-foreground">{t('设置')}</h2>
          </div>
          <button
            onClick={closeSettings}
            aria-label={t('取消')}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <X size={15} />
          </button>
        </div>

        {/* Mobile tab bar */}
        <div className="sm:hidden flex shrink-0 border-b border-border/60 bg-background overflow-x-auto scrollbar-none" role="tablist">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              role="tab"
              aria-selected={activeTab === item.id}
              onClick={() => setSettingsTab(item.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-xs whitespace-nowrap transition-colors border-b-2 -mb-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset',
                activeTab === item.id
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <item.icon size={13} aria-hidden="true" />
              <span>{t(item.label)}</span>
            </button>
          ))}
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar nav (desktop) */}
          <nav aria-label={t('设置')} className="hidden sm:flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-border/60 bg-muted/30 p-3 overflow-y-auto scrollbar-app-thin">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                aria-current={activeTab === item.id ? 'page' : undefined}
                onClick={() => setSettingsTab(item.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  activeTab === item.id
                    ? 'bg-background text-foreground font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)] ring-1 ring-foreground/[0.04]'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/60',
                )}
              >
                <item.icon size={15} className="shrink-0" aria-hidden="true" />
                <span>{t(item.label)}</span>
              </button>
            ))}
          </nav>

          {/* Content area */}
          <div className="flex-1 min-w-0 overflow-y-auto scrollbar-app-thin bg-background">
            <Suspense fallback={<LoadingFallback />}>
              <TabContent tab={activeTab} />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  )
}
