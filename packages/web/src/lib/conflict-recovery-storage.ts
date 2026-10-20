import type { ConflictDetails } from '@/components/workspace/GitOperationsDialog'

const prefix = 'tower:conflict-recovery:v1:'
export const conflictRecoveryEvent = 'tower:conflict-recovery-changed'
export interface ConflictRecoveryDraft {
  actor: string
  operationId: string
  details: ConflictDetails
  intent: 'resolve_conflicts'
  savedAt: number
  expiresAt?: number
  receiverSessionId?: string
}
const memory = new Map<string, ConflictRecoveryDraft>()
let storageUnavailable = false

/** A storage/idempotency hint from a server response, never client-side authorization. */
export function conflictTokenHint(token?: string): { actor: string; operationId: string; context: object; recovery?: { expiresAt?: number }; expiresAt?: number } | undefined {
  try {
    if (!token || token.length > 256 * 1024) return
    const body = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0))))
    if (typeof value.actor === 'string' && typeof value.operationId === 'string' && value.context && typeof value.context === 'object') return value
  } catch { /* Legacy tokens have no recoverable hint. */ }
}
export function conflictSubmissionIdentity(token?: string) {
  const hint = conflictTokenHint(token)
  return hint ? [hint.actor, hint.operationId, hint.context] : null
}
/** Token hints restore the original display snapshot, never authorize a request. */
export function completeConflictDetails(details: ConflictDetails): ConflictDetails {
  const context = conflictTokenHint(details.resolutionContextToken)?.context as Record<string, unknown> | undefined
  const result = { ...details }
  if (!context) return result
  for (const field of ['sourceWorkspaceId', 'targetWorkspaceId', 'sourceWorktreePath', 'targetWorktreePath', 'sourceBranch', 'targetBranch'] as const) {
    if (typeof context[field] === 'string' && context[field]) result[field] = context[field]
  }
  if (context.conflictOp === 'MERGE' || context.conflictOp === 'REBASE') result.conflictOp = context.conflictOp as ConflictDetails['conflictOp']
  if (Array.isArray(context.conflictedFiles) && context.conflictedFiles.every(file => typeof file === 'string')) result.conflictedFiles = context.conflictedFiles
  if (typeof context.mergeAborted === 'boolean') result.mergeAborted = context.mergeAborted
  if (context.mergeStrategy === 'squash' || context.mergeStrategy === 'no_ff') result.mergeStrategy = context.mergeStrategy
  return result
}
const keyFor = (draft: Pick<ConflictRecoveryDraft, 'actor' | 'operationId'>) => `${prefix}${draft.actor}:${draft.operationId}`
function notify() { window.dispatchEvent(new Event(conflictRecoveryEvent)) }

/** Called synchronously before a MERGE_CONFLICT response is thrown to any UI. */
export function saveConflictRecovery(details: ConflictDetails, receiverSessionId?: string): ConflictRecoveryDraft | undefined {
  details = completeConflictDetails(details)
  const hint = conflictTokenHint(details.resolutionContextToken)
  if (!hint || hint.actor === 'unbound') return
  const key = keyFor(hint)
  const old = memory.get(key)
  const draft: ConflictRecoveryDraft = { actor: hint.actor, operationId: hint.operationId, details, intent: 'resolve_conflicts',
    savedAt: old?.savedAt ?? Date.now(), expiresAt: hint.recovery?.expiresAt ?? hint.expiresAt, receiverSessionId: receiverSessionId ?? old?.receiverSessionId }
  memory.set(key, draft)
  try { sessionStorage.setItem(key, JSON.stringify(draft)); storageUnavailable = false } catch { storageUnavailable = true }
  notify()
  return draft
}
export function readConflictRecovery(actor: string): ConflictRecoveryDraft[] {
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)
      if (!key?.startsWith(`${prefix}${actor}:`)) continue
      try {
        const draft = JSON.parse(sessionStorage.getItem(key)!) as ConflictRecoveryDraft
        const hint = conflictTokenHint(draft.details?.resolutionContextToken)
        if (draft.actor === actor && draft.intent === 'resolve_conflicts' && hint?.actor === actor && hint.operationId === draft.operationId) memory.set(key, { ...draft, details: completeConflictDetails(draft.details) })
      } catch { storageUnavailable = true }
    }
  } catch { storageUnavailable = true }
  return [...memory.values()].filter(draft => draft.actor === actor).sort((a, b) => b.savedAt - a.savedAt)
}
export function removeConflictRecovery(token?: string) {
  const hint = conflictTokenHint(token)
  if (!hint) return
  const key = keyFor(hint)
  memory.delete(key)
  try { sessionStorage.removeItem(key) } catch { storageUnavailable = true }
  notify()
}
export function conflictRecoveryStorageUnavailable() { return storageUnavailable }
