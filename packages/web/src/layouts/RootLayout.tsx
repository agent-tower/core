import { Outlet } from 'react-router-dom'
import { SettingsDialog } from '@/components/settings/SettingsDialog'

export function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
      <SettingsDialog />
    </div>
  )
}
