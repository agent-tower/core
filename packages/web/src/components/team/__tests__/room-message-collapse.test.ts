import { describe, expect, it } from 'vitest'
import {
  ROOM_MESSAGE_COLLAPSED_LINE_COUNT,
  ROOM_MESSAGE_COLLAPSED_LINE_HEIGHT,
  ROOM_MESSAGE_COLLAPSED_MAX_HEIGHT,
  isRoomMessageContentOverflowing,
} from '../room-message-collapse'

describe('room message collapse threshold', () => {
  it('defaults to a ten-line preview height', () => {
    expect(ROOM_MESSAGE_COLLAPSED_LINE_COUNT).toBe(10)
    expect(ROOM_MESSAGE_COLLAPSED_MAX_HEIGHT).toBe(
      ROOM_MESSAGE_COLLAPSED_LINE_COUNT * ROOM_MESSAGE_COLLAPSED_LINE_HEIGHT,
    )
  })

  it('does not collapse content at or just above the preview height', () => {
    expect(isRoomMessageContentOverflowing(ROOM_MESSAGE_COLLAPSED_MAX_HEIGHT)).toBe(false)
    expect(isRoomMessageContentOverflowing(ROOM_MESSAGE_COLLAPSED_MAX_HEIGHT + 8)).toBe(false)
  })

  it('collapses content once rendered height clears the tolerance', () => {
    expect(isRoomMessageContentOverflowing(ROOM_MESSAGE_COLLAPSED_MAX_HEIGHT + 9)).toBe(true)
  })

  it('allows a custom preview height for local tuning', () => {
    expect(isRoomMessageContentOverflowing(129, 120)).toBe(true)
    expect(isRoomMessageContentOverflowing(128, 120)).toBe(false)
  })
})
