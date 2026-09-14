import { useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { queryClient } from '@/lib/query-client'
import { AppRouter } from '@/routes'
import { socketManager } from '@/lib/socket/manager'
import { I18nProvider } from '@/lib/i18n'
import { GlobalRealtimeSync } from '@/components/GlobalRealtimeSync'
import { AccessGate } from '@/components/access/AccessGate'
import { AppRootBoundary, AppShellBoundary, ErrorBoundary } from '@/components/errors'

function AppContent() {
  // Establish socket connection once at app startup.
  // Individual hooks only subscribe/unsubscribe to rooms.
  useEffect(() => {
    socketManager.connect()
    return () => socketManager.disconnect()
  }, [])

  return (
    <I18nProvider>
      {/* Layer 2 of the render fallbacks (layer 1 is the route `errorElement`,
          layer 3 is `AppShellBoundary`). This one uses `useI18n`, so it must
          stay inside `I18nProvider`; it covers render errors raised outside
          the router, e.g. in `GlobalRealtimeSync`. */}
      <AppRootBoundary>
        <GlobalRealtimeSync />
        <AppRouter />
      </AppRootBoundary>
      {/* `Toaster` is a sibling of the app tree, so without its own boundary a
          render error inside it would unmount the whole document. Toasts are a
          non-essential overlay: degrade to "no toasts" (the error still goes to
          the error log) instead of losing the app. */}
      <ErrorBoundary source="toaster" fallback={() => null}>
        <Toaster
          position="top-center"
          toastOptions={{
            className: 'text-sm',
            style: {
              fontFamily: 'inherit',
            },
            classNames: {
              error: '!bg-neutral-900 !text-neutral-100 !border-neutral-800 !shadow-lg',
              success: '!bg-neutral-900 !text-neutral-100 !border-neutral-800 !shadow-lg',
              default: '!bg-neutral-900 !text-neutral-100 !border-neutral-800 !shadow-lg',
            },
          }}
        />
      </ErrorBoundary>
    </I18nProvider>
  )
}

function App() {
  return (
    // Layer 3: above every provider, so a render error in the shell itself
    // (`QueryClientProvider`, `AccessGate`, `I18nProvider`) still has a
    // fallback. Its fallback deliberately uses no React context.
    <AppShellBoundary>
      <QueryClientProvider client={queryClient}>
        <AccessGate>
          <AppContent />
        </AccessGate>
      </QueryClientProvider>
    </AppShellBoundary>
  )
}

export default App
