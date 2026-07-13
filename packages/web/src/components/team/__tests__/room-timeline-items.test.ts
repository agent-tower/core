import { describe, expect, it } from 'vitest'
import type { AgentInvocation, RoomMessage, WorkRequest } from '@agent-tower/shared'
import { buildRoomTimelineItems } from '../room-timeline-items'

function message(input: Partial<RoomMessage> & Pick<RoomMessage, 'id'>): RoomMessage {
  return {
    teamRunId: 'team-run-1',
    senderType: 'user',
    kind: 'chat',
    visibility: 'PUBLIC',
    content: 'message',
    mentions: [],
    ...input,
  }
}

function workRequest(input: Partial<WorkRequest> & Pick<WorkRequest, 'id'>): WorkRequest {
  return {
    teamRunId: 'team-run-1',
    requesterType: 'user',
    targetMemberId: 'member-1',
    triggerMessageId: 'message-1',
    instruction: 'work request',
    ifBusy: 'queue',
    cancelQueued: false,
    status: 'PENDING_APPROVAL',
    startAttemptCount: 0,
    ...input,
  }
}

function invocation(input: Partial<AgentInvocation> & Pick<AgentInvocation, 'id' | 'workRequestId'>): AgentInvocation {
  return {
    teamRunId: 'team-run-1',
    memberId: 'member-1',
    sessionId: 'session-1',
    status: 'RUNNING',
    roomReplyReminderCount: 0,
    ...input,
  }
}

describe('buildRoomTimelineItems', () => {
  it('interleaves room messages and pending approvals by time without active invocations', () => {
    const items = buildRoomTimelineItems(
      [
        message({ id: 'message-2', createdAt: '2026-05-26T10:03:00.000Z' }),
        message({ id: 'message-1', createdAt: '2026-05-26T10:01:00.000Z' }),
      ],
      [
        workRequest({ id: 'request-1', createdAt: '2026-05-26T10:02:00.000Z' }),
      ],
      [
        invocation({ id: 'invocation-1', workRequestId: 'request-2', createdAt: '2026-05-26T10:04:00.000Z' }),
      ],
    )

    expect(items.map((item) => item.key)).toEqual([
      'message:message-1',
      'pending-approval:request-1',
      'message:message-2',
    ])
  })

  it('does not render a pending approval item once an active invocation exists for that request', () => {
    const items = buildRoomTimelineItems(
      [],
      [
        workRequest({ id: 'request-1', status: 'PENDING_APPROVAL', createdAt: '2026-05-26T10:01:00.000Z' }),
      ],
      [
        invocation({ id: 'invocation-1', workRequestId: 'request-1', status: 'RUNNING', createdAt: '2026-05-26T10:02:00.000Z' }),
      ],
    )

    expect(items).toEqual([])
  })

  it('treats SESSION_ENDED as active for suppressing stale pending approvals', () => {
    const items = buildRoomTimelineItems(
      [],
      [
        workRequest({ id: 'request-1', status: 'PENDING_APPROVAL', createdAt: '2026-05-26T10:01:00.000Z' }),
      ],
      [
        invocation({ id: 'invocation-1', workRequestId: 'request-1', status: 'SESSION_ENDED', createdAt: '2026-05-26T10:02:00.000Z' }),
      ],
    )

    expect(items).toEqual([])
  })

  it('omits active and terminal invocations from timeline items', () => {
    const items = buildRoomTimelineItems(
      [],
      [],
      [
        invocation({ id: 'invocation-0', workRequestId: 'request-0', status: 'RUNNING' }),
        invocation({ id: 'invocation-1', workRequestId: 'request-1', status: 'COMPLETED' }),
        invocation({ id: 'invocation-2', workRequestId: 'request-2', status: 'FAILED' }),
      ],
    )

    expect(items).toEqual([])
  })
})
