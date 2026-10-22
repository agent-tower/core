import { conflictSubmissionIdentity, conflictTokenHint } from '@/lib/conflict-recovery-storage'
import { createUuid } from '@/lib/uuid'

interface Pending { id: string; key: string; identity: unknown; body?: object }
const pending = new Map<string, Pending>()
const systemPrefix = 'tower:system-submission:'
const withoutToken = (input: object) => Object.fromEntries(Object.entries(input).filter(([field]) => field !== 'resolutionContextToken'))
const tokenOf = (input: object) => 'resolutionContextToken' in input ? String(input.resolutionContextToken) : undefined
const identityOf = (input: object) => conflictSubmissionIdentity(tokenOf(input)) ?? withoutToken(input)
let unavailable = false
export const submissionStorageUnavailable = () => unavailable
function parsePending(value: unknown): Pending | undefined {
  if (!value || typeof value !== 'object') return
  const record = value as Pending
  if (typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.id) || typeof record.key !== 'string'
    || !record.identity || typeof record.identity !== 'object' || (record.body !== undefined && (!record.body || typeof record.body !== 'object' || Array.isArray(record.body)))) return
  return record
}

export function pendingConflictReceiver(token?: string): string | undefined {
  const identity = conflictSubmissionIdentity(token)
  if (!identity) return
  loadPendingConflicts()
  return [...pending.values()].find(record => JSON.stringify(record.identity) === JSON.stringify(identity) && record.key.startsWith('message:'))?.key.slice('message:'.length)
}

function loadPendingConflicts() {
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(systemPrefix)) {
        const record = parsePending(JSON.parse(sessionStorage.getItem(key)!))
        if (record) pending.set(key, record)
        else unavailable = true
      }
    }
  } catch { unavailable = true }
}

/** Unknown requests survive explicit removal of display evidence and new status observations. */
export function pendingConflictSubmission(actor: string, sourceWorkspaceId: string) {
  loadPendingConflicts()
  for (const record of pending.values()) {
    if (!record.body || !record.key.startsWith('message:')) continue
    const token = tokenOf(record.body)
    const hint = conflictTokenHint(token)
    if (hint?.actor === actor && (hint.context as { sourceWorkspaceId?: string }).sourceWorkspaceId === sourceWorkspaceId) {
      return { token, receiverSessionId: record.key.slice('message:'.length), identity: record.identity }
    }
  }
}

/** An uncertain system request retains its original destination, UUID and body as one atomic record. */
export async function userSubmission<T>(key: string, input: object, send: (body: object & { clientSubmissionId: string }) => Promise<T>): Promise<T> {
  const system = 'systemAction' in input && input.systemAction === 'resolve_conflicts'
  const identity = system ? identityOf(input) : input
  const hint = system ? conflictTokenHint(tokenOf(input)) : undefined
  const sourceId = (hint?.context as { sourceWorkspaceId?: string } | undefined)?.sourceWorkspaceId
  const unknown = hint && sourceId ? pendingConflictSubmission(hint.actor, sourceId) : undefined
  if (unknown && (JSON.stringify(unknown.identity) !== JSON.stringify(identity) || key !== `message:${unknown.receiverSessionId}`)) {
    throw new Error('Check the original conflict submission with its original Session, UUID and body before starting another request.')
  }
  const storageKey = system ? `${systemPrefix}${key}:${JSON.stringify(identity)}` : `tower:user-submission:${key}:${JSON.stringify(input)}`
  let record = pending.get(storageKey)
  const adopted: string[] = []
  try {
    const saved = sessionStorage.getItem(storageKey)
    if (saved) {
      const parsed = system ? parsePending(JSON.parse(saved)) : { id: saved, key, identity }
      if (!parsed || parsed.key !== key || JSON.stringify(parsed.identity) !== JSON.stringify(identity)) throw new Error('Invalid pending submission')
      record = parsed
    }
    if (system && !record) {
      const prefix = `tower:user-submission:${key}:`
      for (let index = 0; index < sessionStorage.length; index++) {
        const candidate = sessionStorage.key(index)
        if (!candidate?.startsWith(prefix) || candidate.endsWith(':body')) continue
        const parsed = JSON.parse(candidate.slice(prefix.length)) as object
        const storedBody = sessionStorage.getItem(`${candidate}:body`)
        const oldBody = storedBody ? JSON.parse(storedBody) as object : parsed
        const oldHint = conflictTokenHint(tokenOf(oldBody)); const newHint = conflictTokenHint(tokenOf(input))
        if (!oldHint && newHint && JSON.stringify(withoutToken(oldBody)) === JSON.stringify(withoutToken(input))) {
          // Pre-atomic clients could leave an ID without its original body. Do not replace this unknown request.
          throw new Error('Incomplete legacy submission')
        }
        if (oldHint || newHint) {
          if (JSON.stringify(identityOf(oldBody)) !== JSON.stringify(identity)) continue
        } else if (JSON.stringify(withoutToken(oldBody)) !== JSON.stringify(withoutToken(input))) continue
        const id = sessionStorage.getItem(candidate)
        if (id) { record = { id, key, identity, body: oldBody }; adopted.push(candidate, `${candidate}:body`); break }
      }
    }
  } catch {
    unavailable = true
    // Unreadable/invalid persistence may hide an accepted UUID; never silently replace it.
    if (system) throw new Error('Pending submission storage is unavailable or damaged. Preserve the operation details and check the original submission before sending again.')
  }
  record ??= { id: createUuid(), key, identity }
  if (system) record.body ??= input
  pending.set(storageKey, record)
  try {
    sessionStorage.setItem(storageKey, system ? JSON.stringify(record) : record.id)
    for (const legacy of adopted) sessionStorage.removeItem(legacy)
  } catch { unavailable = true }
  let result: T
  try { result = await send({ ...(record.body ?? input), clientSubmissionId: record.id }) }
  catch (error) {
    // Only a definite non-acceptance permits refreshed credentials, always under the same UUID.
    if (system && (error as { details?: { accepted?: boolean } }).details?.accepted === false) {
      record.body = undefined
      try { sessionStorage.setItem(storageKey, JSON.stringify(record)) } catch { unavailable = true }
    }
    throw error
  }
  pending.delete(storageKey)
  try { sessionStorage.removeItem(storageKey) } catch { unavailable = true }
  return result
}

/** Clear only a UUID that an authoritative delivery has acknowledged. */
export function acknowledgeUserSubmission(key: string, input: object, id: string) {
  const storageKey = `tower:user-submission:${key}:${JSON.stringify(input)}`
  if (pending.get(storageKey)?.id === id) pending.delete(storageKey)
  try { if (sessionStorage.getItem(storageKey) === id) sessionStorage.removeItem(storageKey) } catch { unavailable = true }
}
