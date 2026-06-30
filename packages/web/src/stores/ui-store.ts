import { create } from 'zustand'

export type SettingsTab = 'general' | 'agent-environment' | 'agents' | 'team' | 'projects' | 'notifications' | 'mcp' | 'agents-legacy'

interface UIState {
  sidebarOpen: boolean
  theme: 'light' | 'dark' | 'system'

  settingsOpen: boolean
  settingsTab: SettingsTab

  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  setSettingsTab: (tab: SettingsTab) => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  theme: 'system',

  settingsOpen: false,
  settingsTab: 'general',

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setTheme: (theme) => set({ theme }),
  openSettings: (tab) => set({ settingsOpen: true, ...(tab ? { settingsTab: tab } : {}) }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
}))
