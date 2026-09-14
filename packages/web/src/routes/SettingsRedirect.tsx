import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useUIStore, type SettingsTab } from '@/stores/ui-store'
import { useDesktopNavigate } from '@/lib/desktop-titlebar'

const VALID_SETTINGS_TABS = new Set<string>(['general', 'agent-environment', 'agents', 'team', 'projects', 'notifications', 'mcp', 'agents-legacy'])

/** Legacy `/settings/:tab` entry point: opens the settings dialog and returns home. */
export function SettingsRedirect() {
  const navigate = useDesktopNavigate()
  const { tab } = useParams<{ tab: string }>()

  useEffect(() => {
    const settingsTab = (tab && VALID_SETTINGS_TABS.has(tab) ? tab : 'general') as SettingsTab
    useUIStore.getState().openSettings(settingsTab)
    navigate('/', { replace: true })
  }, [navigate, tab])

  return null
}
