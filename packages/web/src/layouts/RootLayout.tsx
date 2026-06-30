import { Outlet } from 'react-router-dom'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { DesktopTitlebarProvider } from '@/lib/desktop-titlebar'
import { AgentCliOnboarding } from '@/components/agent-cli/AgentCliOnboarding'

export function RootLayout() {
  return (
    <DesktopTitlebarProvider>
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
        <SettingsDialog />
        <AgentCliOnboarding />
      </div>
    </DesktopTitlebarProvider>
  )
}
