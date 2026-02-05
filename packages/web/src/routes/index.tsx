import { lazy, Suspense } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { RootLayout } from '@/layouts/RootLayout'

// Lazy load pages for bundle optimization (bundle-dynamic-imports)
const HomePage = lazy(() => import('@/pages/HomePage').then(m => ({ default: m.HomePage })))

const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: (
          <Suspense fallback={<div className="p-8">Loading...</div>}>
            <HomePage />
          </Suspense>
        ),
      },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
