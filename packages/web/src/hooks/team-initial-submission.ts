import { createUuid } from '@/lib/uuid'
import type { CreateTaskTeamRunInput } from './use-team-run'
const prefix = 'tower:team-initial-submission:'
export type InitialCreationBody = CreateTaskTeamRunInput & { clientSubmissionId: string }
export function pendingTeamInitialSubmission(taskId: string): InitialCreationBody | null {
  const raw = sessionStorage.getItem(`${prefix}${taskId}`)
  if (!raw) return null
  try {
    const saved = JSON.parse(raw)
    if (saved.version !== 1 || saved.taskId !== taskId || !saved.body || !['AUTO', 'CONFIRM'].includes(saved.body.mode) || typeof saved.body.clientSubmissionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(saved.body.clientSubmissionId)) throw new Error()
    return saved.body
  } catch { throw new Error('Pending team creation is damaged. Check the original submission before creating again.') }
}
export function rememberTeamInitialSubmission(taskId: string, input: CreateTaskTeamRunInput & { clientSubmissionId?: string }): InitialCreationBody {
  const saved = pendingTeamInitialSubmission(taskId)
  if (saved) {
    const { clientSubmissionId: savedId, ...intent } = saved
    const { clientSubmissionId, ...incoming } = input
    if (JSON.stringify(intent) !== JSON.stringify(incoming) || clientSubmissionId && clientSubmissionId !== savedId) throw new Error('Check the original team creation before changing its configuration.')
    return saved
  }
  const body = { ...input, clientSubmissionId: input.clientSubmissionId ?? createUuid() }
  sessionStorage.setItem(`${prefix}${taskId}`, JSON.stringify({ version: 1, taskId, body }))
  return body
}
export function forgetTeamInitialSubmission(taskId: string, id: string) {
  try { if (pendingTeamInitialSubmission(taskId)?.clientSubmissionId === id) sessionStorage.removeItem(`${prefix}${taskId}`) } catch { /* Keep damaged or unknown evidence. */ }
}
