import { useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { queryClient } from '@/lib/query-client'
import { AppRouter } from '@/routes'
import { socketManager } from '@/lib/socket/manager'
import { I18nProvider } from '@/lib/i18n'

function App() {
  // Establish socket connection once at app startup.
  // Individual hooks only subscribe/unsubscribe to rooms.
  useEffect(() => {
    socketManager.connect()
    return () => socketManager.disconnect()
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AppRouter />
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
      </I18nProvider>
    </QueryClientProvider>
  )
}

export default App
