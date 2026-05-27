import { prisma } from '../utils/index.js';

interface AttachmentContextItem {
  id: string;
  originalName: string;
  mimeType: string;
  storagePath: string;
}

function uniqueIds(ids: string[] | null | undefined): string[] {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

function formatAttachmentMarkdown(attachment: AttachmentContextItem): string {
  const prefix = attachment.mimeType.startsWith('image/') ? '!' : '';
  return `${prefix}[${attachment.originalName}](${attachment.storagePath})`;
}

export async function buildAttachmentMarkdownContext(
  attachmentIds: string[] | null | undefined,
  existingContent = ''
): Promise<string> {
  const ids = uniqueIds(attachmentIds);
  if (ids.length === 0) return '';

  const attachments = await prisma.attachment.findMany({
    where: { id: { in: ids } },
  });
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));

  const lines: string[] = [];
  for (const id of ids) {
    const attachment = attachmentById.get(id);
    if (!attachment) continue;
    if (existingContent.includes(attachment.storagePath)) continue;
    lines.push(formatAttachmentMarkdown(attachment));
  }

  if (lines.length === 0) return '';

  return ['Attachments:', ...lines].join('\n');
}

export async function appendAttachmentMarkdownContext(
  content: string,
  attachmentIds: string[] | null | undefined
): Promise<string> {
  const attachmentContext = await buildAttachmentMarkdownContext(attachmentIds, content);
  return [content.trim(), attachmentContext].filter(Boolean).join('\n\n');
}
