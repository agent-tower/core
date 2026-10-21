import type { Attachment, StructuredMention } from '@agent-tower/shared'
import type { PostRoomMessageInput } from '@/hooks/use-team-run'

function formatGeneratedAttachmentMarkdown(attachment: Pick<Attachment, 'originalName' | 'mimeType' | 'storagePath'>): string {
  const prefix = attachment.mimeType.startsWith('image/') ? '!' : ''
  return `${prefix}[${attachment.originalName}](${attachment.storagePath})`
}

export function filterGeneratedAttachmentMarkdown(content: string, attachments: Array<Pick<Attachment, 'originalName' | 'mimeType' | 'storagePath'>>): string {
  if (attachments.length === 0) return content

  const generatedLines = new Set(attachments.map(formatGeneratedAttachmentMarkdown))
  return content
    .split('\n')
    .map((line) => {
      const leadingWhitespace = line.match(/^\s*/)?.[0] ?? ''
      const normalizedLine = line.trimStart()
      for (const generatedLine of generatedLines) {
        if (normalizedLine === generatedLine) return null
        if (normalizedLine.startsWith(`${generatedLine} `) || normalizedLine.startsWith(`${generatedLine}\t`)) {
          return `${leadingWhitespace}${normalizedLine.slice(generatedLine.length).trimStart()}`
        }
      }
      return line
    })
    .filter((line): line is string => line != null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function buildRoomMessageSubmitInput({
  draft,
  attachmentMarkdown,
  attachmentIds,
  mentions,
}: {
  draft: string
  attachmentMarkdown: string
  attachmentIds: string[]
  mentions: StructuredMention[]
}): PostRoomMessageInput | null {
  const content = draft.trim()
  const messageContent = [content, attachmentMarkdown].filter(Boolean).join('\n\n')
  if (!messageContent) return null

  return {
    content: messageContent,
    mentions,
    senderType: 'user',
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
  }
}

