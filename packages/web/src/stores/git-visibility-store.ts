import { create } from 'zustand'

export type VisibleGitTab = 'changes' | 'history'

export type VisibleGitContext = {
  workspaceId: string
  workingDir: string
  tab: VisibleGitTab
}

type GitVisibilityState = {
  visibleContext: VisibleGitContext | null
  setVisibleContext: (context: VisibleGitContext | null) => void
}

export const useGitVisibilityStore = create<GitVisibilityState>((set) => ({
  visibleContext: null,
  setVisibleContext: (context) => set({ visibleContext: context }),
}))
