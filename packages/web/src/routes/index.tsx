import { lazy, Suspense, useEffect } from 'react'
import { createBrowserRouter, RouterProvider, useNavigate, useParams } from 'react-router-dom'
import { RootLayout } from '@/layouts/RootLayout'
import { useUIStore, type SettingsTab } from '@/stores/ui-store'
import { FullscreenLoading } from '@/components/loading/FullscreenLoading'

// Lazy load pages
const ProjectKanbanPage = lazy(() => import('@/pages/ProjectKanbanPage').then(m => ({ default: m.ProjectKanbanPage })))
const ConversationPage = lazy(() => import('@/pages/ConversationPage').then(m => ({ default: m.ConversationPage })))
const DemoPage = lazy(() => import('@/pages/DemoPage').then(m => ({ default: m.DemoPage })))
const AgentDemoPage = lazy(() => import('@/pages/AgentDemoPage').then(m => ({ default: m.AgentDemoPage })))
const LoadingPreviewPage = lazy(() => import('@/pages/LoadingPreviewPage').then(m => ({ default: m.LoadingPreviewPage })))

const VALID_SETTINGS_TABS = new Set<string>(['general', 'agents', 'team', 'projects', 'notifications', 'mcp', 'agents-legacy'])

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
          <Suspense fallback={<FullscreenLoading />}>
            <ProjectKanbanPage />
          </Suspense>
        ),
      },
      {
        path: 'conversations',
        element: (
          <Suspense fallback={<FullscreenLoading />}>
            <ConversationPage />
          </Suspense>
        ),
      },
      {
        path: 'conversations/:conversationId',
        element: (
          <Suspense fallback={<FullscreenLoading />}>
            <ConversationPage />
          </Suspense>
        ),
      },
      {
        path: 'demo',
        element: (
          <Suspense fallback={<FullscreenLoading />}>
            <DemoPage />
          </Suspense>
        ),
      },
      {
        path: 'agent-demo',
        element: (
          <Suspense fallback={<FullscreenLoading />}>
            <AgentDemoPage />
          </Suspense>
        ),
      },
      {
        path: 'loading-preview',
        element: (
          <Suspense fallback={<FullscreenLoading />}>
            <LoadingPreviewPage />
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
