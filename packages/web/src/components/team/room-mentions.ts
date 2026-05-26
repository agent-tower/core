import type { StructuredMention, TeamMember } from '@agent-tower/shared'

export function addSelectedMemberId(selectedMemberIds: string[], memberId: string): string[] {
  return selectedMemberIds.includes(memberId)
    ? selectedMemberIds
    : [...selectedMemberIds, memberId]
}

export function removeSelectedMemberId(selectedMemberIds: string[], memberId: string): string[] {
  return selectedMemberIds.filter((selectedMemberId) => selectedMemberId !== memberId)
}

export function buildStructuredMentionsFromSelectedMembers(
  selectedMemberIds: string[],
  members: TeamMember[],
): StructuredMention[] {
  const memberById = new Map(members.map((member) => [member.id, member]))
  return selectedMemberIds
    .map((memberId) => memberById.get(memberId))
    .filter((member): member is TeamMember => Boolean(member))
    .map((member) => ({
      memberId: member.id,
      label: member.name,
    }))
}
