import type { PrismaClient } from '@prisma/client';
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
  attachmentIds: string[] | null | undefined,
  preserveText = false
): Promise<string> {
  const attachmentContext = await buildAttachmentMarkdownContext(attachmentIds, content);
  return [preserveText ? content : content.trim(), attachmentContext].filter(Boolean).join('\n\n');
}

/** Recover only exact, server-generated attachment lines from legacy task prompts. */
export async function splitAttachmentReferences(content: string, db: Pick<PrismaClient, 'attachment'> = prisma): Promise<{ text: string; attachmentIds: string[] }> {
  const lines = content.split('\n');
  const paths = lines.flatMap(line => {
    const match = /^!?\[[^\n]*\]\(([^\n]*)\)$/.exec(line);
    return match ? [match[1]!] : [];
  });
  if (!paths.length) return { text: content, attachmentIds: [] };
  const attachments = await db.attachment.findMany({ where: { storagePath: { in: paths } } });
  const references = new Map(attachments.map(attachment => [formatAttachmentMarkdown(attachment), attachment.id]));
  const attachmentIds: string[] = [];
  const body = lines.filter(line => {
    const id = references.get(line);
    if (!id) return true;
    attachmentIds.push(id); return false;
  }).join('\n');
  return { text: attachmentIds.length ? body.trim() : content, attachmentIds: uniqueIds(attachmentIds) };
}
