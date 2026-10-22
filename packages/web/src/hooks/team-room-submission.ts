import { createUuid } from '@/lib/uuid'
import type { PostRoomMessageInput } from './use-team-run'
const prefix = 'tower:team-room-submission:'
function submissionIntent(input: PostRoomMessageInput) {
  return JSON.stringify([input.content, input.mentions ?? [], input.attachmentIds ?? [], input.artifactRefs ?? [], input.kind ?? null])
}

export function pendingTeamRoomSubmissions(teamRunId: string): PostRoomMessageInput[] {
  const items: PostRoomMessageInput[] = []
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)
      if (!key?.startsWith(`${prefix}${teamRunId}:`)) continue
      const input = JSON.parse(sessionStorage.getItem(key)!) as PostRoomMessageInput
      if (typeof input.content === 'string' && typeof input.clientSubmissionId === 'string') items.push(input)
    }
  } catch { /* Preserve unknown records; sending requires writable storage below. */ }
  return items
}
export function rememberTeamRoomSubmission(teamRunId: string, input: PostRoomMessageInput): PostRoomMessageInput & { clientSubmissionId: string } {
  // Callers such as conflict assistance have no optimistic message ID. Recover
  // their exact unknown request before allocating another submission identity.
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index)
    if (!key?.startsWith(`${prefix}${teamRunId}:`)) continue
    let saved: PostRoomMessageInput
    try {
      saved = JSON.parse(sessionStorage.getItem(key)!)
      if (!saved || typeof saved.content !== 'string' || typeof saved.clientSubmissionId !== 'string' || key !== `${prefix}${teamRunId}:${saved.clientSubmissionId}`) throw new Error()
    } catch { throw new Error('Pending room submission is unavailable or damaged. Check the original submission before sending again.') }
    if (input.clientSubmissionId === saved.clientSubmissionId) {
      if (submissionIntent(input) !== submissionIntent(saved)) throw new Error('The original room submission must be checked before changing its content.')
      return saved as PostRoomMessageInput & { clientSubmissionId: string }
    }
    if (!input.clientSubmissionId && submissionIntent(input) === submissionIntent(saved)) return saved as PostRoomMessageInput & { clientSubmissionId: string }
  }
  const body = { ...input, clientSubmissionId: input.clientSubmissionId ?? createUuid() }
  // Persist exact body + ID before HTTP; a failed write cannot create an unrecoverable send.
  sessionStorage.setItem(`${prefix}${teamRunId}:${body.clientSubmissionId}`, JSON.stringify(body))
  return body
}
export function forgetTeamRoomSubmission(teamRunId: string, id: string) {
  try { sessionStorage.removeItem(`${prefix}${teamRunId}:${id}`) } catch { /* An accepted response remains authoritative; replay keeps the same UUID. */ }
}
