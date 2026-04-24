import { create } from 'zustand'
import { applyPatch, type Operation } from 'fast-json-patch'
import type { NormalizedEntry } from '@agent-tower/shared/log-adapter'

export interface NormalizedConversation {
  sessionId?: string
  entries: NormalizedEntry[]
  /** Last applied patch seq. Used to dedupe out-of-window patches. */
  seq?: number
}

const EMPTY_CONVERSATION: NormalizedConversation = { entries: [] }

const MAX_CACHED_SESSIONS = 50
const TRUNCATE_ENTRIES = 500

interface SessionLogState {
  conversations: Record<string, NormalizedConversation>
  accessOrder: string[]

  setConversation: (sessionId: string, data: NormalizedConversation) => void
  /**
   * Apply a JSON Patch to a session's conversation.
   * If `seq` is provided, patches with seq <= stored seq are silently skipped (already applied).
   * Returns false if the session is not in the store or the patch fails.
   */
  applyPatch: (sessionId: string, patch: Operation[], seq?: number) => boolean
  touchAccess: (sessionId: string) => void
  /**
   * Truncate a session's entries to the last TRUNCATE_ENTRIES.
   * Call this when a RUNNING session becomes terminal.
   */
  truncateSession: (sessionId: string) => void
  removeSession: (sessionId: string) => void
  getConversation: (sessionId: string) => NormalizedConversation | undefined
  clear: () => void
}

function evictLRU(
  conversations: Record<string, NormalizedConversation>,
  accessOrder: string[],
): { conversations: Record<string, NormalizedConversation>; accessOrder: string[] } {
  while (accessOrder.length > MAX_CACHED_SESSIONS) {
    const evicted = accessOrder[0]
    accessOrder = accessOrder.slice(1)
    const { [evicted]: _evicted, ...rest } = conversations
    void _evicted
    conversations = rest
  }
  return { conversations, accessOrder }
}

export const useSessionLogStore = create<SessionLogState>((set, get) => ({
  conversations: {},
  accessOrder: [],

  setConversation: (sessionId, data) => {
    set((state) => {
      const newOrder = state.accessOrder.filter(id => id !== sessionId)
      newOrder.push(sessionId)
      const newConversations = { ...state.conversations, [sessionId]: data }
      return evictLRU(newConversations, newOrder)
    })
  },

  applyPatch: (sessionId, patch, seq) => {
    const current = get().conversations[sessionId]
    if (!current) return false
    // Dedupe: patches with seq <= currentSeq are already applied (snapshot
    // fetched after the patch was broadcast, so it's baked into the snapshot).
    // Returning true signals "handled" — caller must not treat this as an error.
    if (typeof seq === 'number' && typeof current.seq === 'number' && seq <= current.seq) {
      return true
    }
    try {
      const result = applyPatch(current, patch, true, false)
      const next: NormalizedConversation = {
        ...result.newDocument,
        seq: typeof seq === 'number' ? seq : current.seq,
      }
      set((state) => ({
        conversations: { ...state.conversations, [sessionId]: next },
      }))
      return true
    } catch (error) {
      console.error('[sessionLogStore] applyPatch failed:', error)
      return false
    }
  },

  touchAccess: (sessionId) => {
    set((state) => {
      const idx = state.accessOrder.indexOf(sessionId)
      if (idx === -1 || idx === state.accessOrder.length - 1) return state
      const newOrder = [...state.accessOrder]
      newOrder.splice(idx, 1)
      newOrder.push(sessionId)
      return { accessOrder: newOrder }
    })
  },

  truncateSession: (sessionId) => {
    set((state) => {
      const conv = state.conversations[sessionId]
      if (!conv || conv.entries.length <= TRUNCATE_ENTRIES) return state
      return {
        conversations: {
          ...state.conversations,
          [sessionId]: {
            ...conv,
            entries: conv.entries.slice(-TRUNCATE_ENTRIES),
          },
        },
      }
    })
  },

  removeSession: (sessionId) => {
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.conversations
      void _removed
      return {
        conversations: rest,
        accessOrder: state.accessOrder.filter(id => id !== sessionId),
      }
    })
  },

  getConversation: (sessionId) => {
    return get().conversations[sessionId]
  },

  clear: () => {
    set({ conversations: {}, accessOrder: [] })
  },
}))

export { EMPTY_CONVERSATION, TRUNCATE_ENTRIES }
