import { describe, expect, it } from 'vitest';
import type { TeamMember } from '@agent-tower/shared';
import type { RoomMessage } from '@agent-tower/shared';
import { upsertRoomMessage } from '@/hooks/use-team-run';
import {
  addSelectedMemberId,
  buildStructuredMentionsFromSelectedMembers,
  removeSelectedMemberId,
} from '../room-mentions';
import {
  buildRoomMessageSubmitInput,
  filterGeneratedAttachmentMarkdown,
} from '../RoomTimeline';

describe('RoomTimeline mention contract', () => {
  const sameNameMembers = [
    { id: 'member-1', name: 'Coder', providerId: 'provider-a' },
    { id: 'member-2', name: 'Coder', providerId: 'provider-b' },
  ] as TeamMember[];

  it('submits only selected memberId mentions for same-name members', () => {
    const selectedMemberIds = addSelectedMemberId([], 'member-2');

    expect(buildStructuredMentionsFromSelectedMembers(selectedMemberIds, sameNameMembers)).toEqual([
      { memberId: 'member-2', label: 'Coder' },
    ]);
  });

  it('does not submit mentions after the selected mention chip is removed, even when @ text remains', () => {
    const draft = '@Coder please implement this';
    const selectedMemberIds = removeSelectedMemberId(
      addSelectedMemberId([], 'member-2'),
      'member-2',
    );

    expect(draft).toContain('@Coder');
    expect(buildStructuredMentionsFromSelectedMembers(selectedMemberIds, sameNameMembers)).toEqual([]);
  });

  it('does not keep duplicate hidden selected memberIds when the same member is selected again', () => {
    const selectedMemberIds = addSelectedMemberId(
      addSelectedMemberId([], 'member-2'),
      'member-2',
    );

    expect(selectedMemberIds).toEqual(['member-2']);
  });

  it('does not derive mentions from text @name tokens', () => {
    const manuallyTypedContent = '@Coder please implement this';

    expect(manuallyTypedContent).toContain('@Coder');
    expect(buildStructuredMentionsFromSelectedMembers([], sameNameMembers)).toEqual([]);
  });

  it('builds room message content with attachment markdown and attachmentIds', () => {
    expect(buildRoomMessageSubmitInput({
      draft: 'Please inspect this',
      attachmentMarkdown: '![screenshot.png](/tmp/screenshot.png)',
      attachmentIds: ['attachment-1'],
      mentions: [{ memberId: 'member-2', label: 'Coder' }],
    })).toEqual({
      content: 'Please inspect this\n\n![screenshot.png](/tmp/screenshot.png)',
      mentions: [{ memberId: 'member-2', label: 'Coder' }],
      senderType: 'user',
      attachmentIds: ['attachment-1'],
    });
  });

  it('allows attachment-only room messages', () => {
    expect(buildRoomMessageSubmitInput({
      draft: '',
      attachmentMarkdown: '![screenshot.png](/tmp/screenshot.png)',
      attachmentIds: ['attachment-1'],
      mentions: [],
    })).toMatchObject({
      content: '![screenshot.png](/tmp/screenshot.png)',
      attachmentIds: ['attachment-1'],
    });
  });

  it('filters generated attachment markdown when attachment metadata is available', () => {
    expect(filterGeneratedAttachmentMarkdown(
      'Please inspect this\n\n![screenshot.png](/tmp/screenshot.png)',
      [{
        originalName: 'screenshot.png',
        mimeType: 'image/png',
        storagePath: '/tmp/screenshot.png',
      }],
    )).toBe('Please inspect this');
  });

  it('keeps non-generated markdown while filtering generated attachment markdown', () => {
    expect(filterGeneratedAttachmentMarkdown(
      'Please inspect this\n\n![external.png](https://example.com/external.png)\n![screenshot.png](/tmp/screenshot.png)',
      [{
        originalName: 'screenshot.png',
        mimeType: 'image/png',
        storagePath: '/tmp/screenshot.png',
      }],
    )).toBe('Please inspect this\n\n![external.png](https://example.com/external.png)');
  });

  it('keeps appended mention labels when filtering generated attachment-only markdown', () => {
    expect(filterGeneratedAttachmentMarkdown(
      '![screenshot.png](/tmp/screenshot.png) @Coder',
      [{
        originalName: 'screenshot.png',
        mimeType: 'image/png',
        storagePath: '/tmp/screenshot.png',
      }],
    )).toBe('@Coder');
  });

  it('appends returned room messages to the messages cache', () => {
    const message = {
      id: 'message-1',
      teamRunId: 'team-run-1',
      senderType: 'user',
      kind: 'chat',
      content: 'Hello',
      mentions: [],
      createdAt: '2026-05-27T00:00:00.000Z',
    } as RoomMessage;

    expect(upsertRoomMessage([], message)).toEqual([message]);
  });

  it('replaces duplicate returned room messages in the messages cache', () => {
    const original = {
      id: 'message-1',
      teamRunId: 'team-run-1',
      senderType: 'user',
      kind: 'chat',
      content: 'Old',
      mentions: [],
      createdAt: '2026-05-27T00:00:00.000Z',
    } as RoomMessage;
    const updated = {
      ...original,
      content: 'Updated',
      workRequestIds: ['work-request-1'],
    } as RoomMessage;

    expect(upsertRoomMessage([original], updated)).toEqual([updated]);
  });
});
