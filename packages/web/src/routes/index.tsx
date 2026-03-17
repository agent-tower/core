import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { RootLayout } from '@/layouts/RootLayout'
import { SettingsLayout } from '@/layouts/SettingsLayout'

// Lazy load pages
const ProjectKanbanPage = lazy(() => import('@/pages/ProjectKanbanPage').then(m => ({ default: m.ProjectKanbanPage })))
const DemoPage = lazy(() => import('@/pages/DemoPage').then(m => ({ default: m.DemoPage })))
const AgentDemoPage = lazy(() => import('@/pages/AgentDemoPage').then(m => ({ default: m.AgentDemoPage })))
const ProfileSettingsPage = lazy(() => import('@/pages/ProfileSettingsPage').then(m => ({ default: m.ProfileSettingsPage })))
const ProviderSettingsPage = lazy(() => import('@/pages/ProviderSettingsPage').then(m => ({ default: m.ProviderSettingsPage })))
const NotificationSettingsPage = lazy(() => import('@/pages/NotificationSettingsPage').then(m => ({ default: m.NotificationSettingsPage })))
const ProjectSettingsPage = lazy(() => import('@/pages/ProjectSettingsPage').then(m => ({ default: m.ProjectSettingsPage })))

const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: (
          <Suspense fallback={<div className="p-8">Loading...</div>}>
            <ProjectKanbanPage />
          </Suspense>
        ),
      },
      {
        path: 'demo',
        element: (
          <Suspense fallback={<div className="p-8">Loading...</div>}>
            <DemoPage />
          </Suspense>
        ),
      },
      {
        path: 'agent-demo',
        element: (
          <Suspense fallback={<div className="p-8">Loading...</div>}>
            <AgentDemoPage />
          </Suspense>
        ),
      },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="agents" replace /> },
          {
            path: 'agents',
            element: (
              <Suspense fallback={<div className="p-8">Loading...</div>}>
                <ProviderSettingsPage />
              </Suspense>
            ),
          },
          {
            path: 'agents-legacy',
            element: (
              <Suspense fallback={<div className="p-8">Loading...</div>}>
                <ProfileSettingsPage />
              </Suspense>
            ),
          },
          {
            path: 'notifications',
            element: (
              <Suspense fallback={<div className="p-8">Loading...</div>}>
                <NotificationSettingsPage />
              </Suspense>
            ),
          },
          {
            path: 'projects',
            element: (
              <Suspense fallback={<div className="p-8">Loading...</div>}>
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
