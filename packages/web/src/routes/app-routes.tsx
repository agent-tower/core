import { lazy, Suspense } from 'react'
import type { RouteObject } from 'react-router-dom'
import { RootLayout } from '@/layouts/RootLayout'
import { RouteErrorPage } from '@/components/errors'
import { FullscreenLoading } from '@/components/loading/FullscreenLoading'
import { SettingsRedirect } from './SettingsRedirect'

// Lazy load pages
const ProjectKanbanPage = lazy(() => import('@/pages/ProjectKanbanPage').then(m => ({ default: m.ProjectKanbanPage })))
const ConversationPage = lazy(() => import('@/pages/ConversationPage').then(m => ({ default: m.ConversationPage })))
const DemoPage = lazy(() => import('@/pages/DemoPage').then(m => ({ default: m.DemoPage })))
const AgentDemoPage = lazy(() => import('@/pages/AgentDemoPage').then(m => ({ default: m.AgentDemoPage })))
const LoadingPreviewPage = lazy(() => import('@/pages/LoadingPreviewPage').then(m => ({ default: m.LoadingPreviewPage })))

/**
 * Production route tree.
 *
 * Kept in its own module (rather than `index.tsx`, which must only export the
 * `AppRouter` component for fast refresh) so tests can mount the real hierarchy
 * with `createMemoryRouter(appRoutes, ...)` instead of a hand-built lookalike.
 *
 * The two `errorElement`s are layers 1a/1b of the render-fallback stack: the
 * pathless group keeps `RootLayout` chrome when a page fails, the root route
 * replaces everything when `RootLayout` itself fails.
 */
export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <RootLayout />,
    // Backstop for a failure in RootLayout itself.
    errorElement: <RouteErrorPage />,
    children: [
      {
        // Pathless grouping route: a page-level render error keeps the app
        // chrome and renders the fallback inside RootLayout's <Outlet />.
        errorElement: <RouteErrorPage />,
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
    ],
  },
]
