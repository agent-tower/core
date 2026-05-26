import { describe, expect, it } from 'vitest';
import type { TeamMember } from '@agent-tower/shared';
import {
  addSelectedMemberId,
  buildStructuredMentionsFromSelectedMembers,
  removeSelectedMemberId,
} from '../room-mentions';

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
});
