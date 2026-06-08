import { lazy, Suspense, useEffect } from 'react'
import { createBrowserRouter, RouterProvider, useNavigate, useParams } from 'react-router-dom'
import { RootLayout } from '@/layouts/RootLayout'
import { useI18n } from '@/lib/i18n'
import { useUIStore, type SettingsTab } from '@/stores/ui-store'

// Lazy load pages
const ProjectKanbanPage = lazy(() => import('@/pages/ProjectKanbanPage').then(m => ({ default: m.ProjectKanbanPage })))
const DemoPage = lazy(() => import('@/pages/DemoPage').then(m => ({ default: m.DemoPage })))
const AgentDemoPage = lazy(() => import('@/pages/AgentDemoPage').then(m => ({ default: m.AgentDemoPage })))

function RouteLoadingFallback() {
  const { t } = useI18n()
  return <div className="p-8">{t('Loading...')}</div>
}

const VALID_SETTINGS_TABS = new Set<string>(['general', 'agents', 'team', 'projects', 'notifications', 'agents-legacy'])

function SettingsRedirect() {
  const navigate = useNavigate()
  const { tab } = useParams<{ tab: string }>()

  useEffect(() => {
    const settingsTab = (tab && VALID_SETTINGS_TABS.has(tab) ? tab : 'general') as SettingsTab
    useUIStore.getState().openSettings(settingsTab)
    navigate('/', { replace: true })
  }, [navigate, tab])

  return null
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <ProjectKanbanPage />
          </Suspense>
        ),
      },
      {
        path: 'demo',
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <DemoPage />
          </Suspense>
        ),
      },
      {
        path: 'agent-demo',
        element: (
          <Suspense fallback={<RouteLoadingFallback />}>
            <AgentDemoPage />
          </Suspense>
        ),
      },
      {
        path: 'settings',
        element: <SettingsRedirect />,
      },
      {
        path: 'settings/:tab',
        element: <SettingsRedirect />,
      },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
