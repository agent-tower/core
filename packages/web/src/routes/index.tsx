import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { RootLayout } from '@/layouts/RootLayout'
import { SettingsLayout } from '@/layouts/SettingsLayout'
import { useI18n } from '@/lib/i18n'

// Lazy load pages
const ProjectKanbanPage = lazy(() => import('@/pages/ProjectKanbanPage').then(m => ({ default: m.ProjectKanbanPage })))
const DemoPage = lazy(() => import('@/pages/DemoPage').then(m => ({ default: m.DemoPage })))
const AgentDemoPage = lazy(() => import('@/pages/AgentDemoPage').then(m => ({ default: m.AgentDemoPage })))
const GeneralSettingsPage = lazy(() => import('@/pages/GeneralSettingsPage').then(m => ({ default: m.GeneralSettingsPage })))
const ProfileSettingsPage = lazy(() => import('@/pages/ProfileSettingsPage').then(m => ({ default: m.ProfileSettingsPage })))
const ProviderSettingsPage = lazy(() => import('@/pages/ProviderSettingsPage').then(m => ({ default: m.ProviderSettingsPage })))
const NotificationSettingsPage = lazy(() => import('@/pages/NotificationSettingsPage').then(m => ({ default: m.NotificationSettingsPage })))
const ProjectSettingsPage = lazy(() => import('@/pages/ProjectSettingsPage').then(m => ({ default: m.ProjectSettingsPage })))

function RouteLoadingFallback() {
  const { t } = useI18n()
  return <div className="p-8">{t('Loading...')}</div>
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
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="general" replace /> },
          {
            path: 'general',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <GeneralSettingsPage />
              </Suspense>
            ),
          },
          {
            path: 'agents',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <ProviderSettingsPage />
              </Suspense>
            ),
          },
          {
            path: 'agents-legacy',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <ProfileSettingsPage />
              </Suspense>
            ),
          },
          {
            path: 'notifications',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <NotificationSettingsPage />
              </Suspense>
            ),
          },
          {
            path: 'projects',
            element: (
              <Suspense fallback={<RouteLoadingFallback />}>
                <ProjectSettingsPage />
              </Suspense>
            ),
          },
        ],
      },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
