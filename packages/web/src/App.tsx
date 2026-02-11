import { useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { AppRouter } from '@/routes'
import { socketManager } from '@/lib/socket/manager'

function App() {
  // Establish socket connection once at app startup.
  // Individual hooks only subscribe/unsubscribe to rooms.
  useEffect(() => {
    socketManager.connect()
    return () => socketManager.disconnect()
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <AppRouter />
    </QueryClientProvider>
  )
}

export default App
