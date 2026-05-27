import type { AgentInvocation, RoomMessage, WorkRequest } from '@agent-tower/shared'

export const ACTIVE_ROOM_INVOCATION_STATUSES = new Set<AgentInvocation['status']>([
  'RUNNING',
  'WAITING_ROOM_REPLY',
  'QUEUED',
  'SESSION_ENDED',
])

export type RoomTimelineItem =
  | {
    kind: 'message'
    key: string
    sortTime?: string
    order: number
    message: RoomMessage
  }
  | {
    kind: 'pendingApproval'
    key: string
    sortTime?: string
    order: number
    request: WorkRequest
  }

function toTimestamp(value?: string) {
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function buildRoomTimelineItems(
  messages: RoomMessage[],
  workRequests: WorkRequest[] = [],
  invocations: AgentInvocation[] = [],
): RoomTimelineItem[] {
  const activeInvocationWorkRequestIds = new Set(
    invocations
      .filter((invocation) => ACTIVE_ROOM_INVOCATION_STATUSES.has(invocation.status))
      .map((invocation) => invocation.workRequestId),
  )

  const items: RoomTimelineItem[] = [
    ...messages.map((message): RoomTimelineItem => ({
      kind: 'message',
      key: `message:${message.id}`,
      sortTime: message.createdAt,
      order: 0,
      message,
    })),
    ...workRequests
      .filter((request) => request.status === 'PENDING_APPROVAL')
      .filter((request) => !activeInvocationWorkRequestIds.has(request.id))
      .map((request): RoomTimelineItem => ({
        kind: 'pendingApproval',
        key: `pending-approval:${request.id}`,
        sortTime: request.updatedAt ?? request.createdAt,
        order: 1,
        request,
      })),
  ]

  return items.sort((a, b) => {
    const timeDiff = toTimestamp(a.sortTime) - toTimestamp(b.sortTime)
    if (timeDiff !== 0) return timeDiff
    if (a.order !== b.order) return a.order - b.order
    return a.key.localeCompare(b.key)
  })
}
