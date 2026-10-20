export type ProviderLastUsedAt = Record<string, number>

const STORAGE_KEY = 'providerLastUsedAt'

export function readProviderLastUsedAt(): ProviderLastUsedAt {
  const lastUsedAt: ProviderLastUsedAt = {}

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, timestamp] of Object.entries(parsed)) {
        if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) {
          lastUsedAt[id] = timestamp
        }
      }
    }
  } catch {
    // A damaged or inaccessible preference must not prevent task creation.
  }

  try {
    // Older versions only tracked usage counts and the most recent selection.
    // Preserve that one known recent choice until timestamp history is recorded.
    const lastProviderId = localStorage.getItem('lastSelectedProviderId')
    if (lastProviderId && Object.keys(lastUsedAt).length === 0) {
      lastUsedAt[lastProviderId] = 1
    }
  } catch {
    // Continue with the in-memory history when storage is unavailable.
  }

  return lastUsedAt
}

export function persistProviderLastUsedAt(lastUsedAt: ProviderLastUsedAt): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lastUsedAt))
  } catch {
    // Sorting still updates for this page when preferences cannot be saved.
  }
}
