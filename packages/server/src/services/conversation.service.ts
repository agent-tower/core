import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/index.js';
import { AgentType, SessionContext, SessionStatus } from '../types/index.js';
import type { Conversation } from '@agent-tower/shared';
import { NotFoundError, ServiceError, ValidationError } from '../errors.js';
import { getProviderById } from '../executors/index.js';
import { resolveDataDir } from '../utils/data-dir.js';
import type { SessionManager } from './session-manager.js';
import { appendAttachmentMarkdownContext } from './attachment-context.js';

const CONVERSATIONS_DIR = 'conversations';
const TITLE_MAX_LENGTH = 80;

type ConversationWithSession = Prisma.ConversationGetPayload<{
  include: { session: true };
}>;

export interface CreateConversationInput {
  prompt: string;
  providerId: string;
  variant?: string;
  attachmentIds?: string[];
}

export interface SendConversationMessageInput {
  message: string;
  providerId?: string;
  attachmentIds?: string[];
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function titleFromPrompt(prompt: string): string {
  const compact = compactWhitespace(prompt);
  if (compact.length <= TITLE_MAX_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

function parseTokenUsage(tokenUsage: string | null): Conversation['tokenUsage'] {
  if (!tokenUsage) return null;
  try {
    return JSON.parse(tokenUsage) as Conversation['tokenUsage'];
  } catch {
    return null;
  }
}

function dateToIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toConversationDto(conversation: ConversationWithSession): Conversation {
  const session = conversation.session;
  if (!session) {
    throw new ServiceError('Conversation has no session', 'CONVERSATION_SESSION_MISSING', 409);
  }

  return {
    id: conversation.id,
    title: conversation.title,
    directoryName: conversation.directoryName,
    workingDir: conversation.workingDir,
    sessionId: session.id,
    agentType: session.agentType as AgentType,
    status: session.status as SessionStatus,
    providerId: session.providerId ?? null,
    variant: session.variant ?? null,
    tokenUsage: parseTokenUsage(session.tokenUsage),
    deletedAt: dateToIso(conversation.deletedAt),
    lastActiveAt: conversation.lastActiveAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export function getConversationRoot(): string {
  return path.join(resolveDataDir(), CONVERSATIONS_DIR);
}

export function assertPathInsideConversationRoot(targetPath: string, root = getConversationRoot()): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (
    relative === ''
    || relative.startsWith('..')
    || path.isAbsolute(relative)
  ) {
    throw new ServiceError(
      'Conversation directory is outside the managed conversations root',
      'UNSAFE_CONVERSATION_PATH',
      400,
    );
  }

  return resolvedTarget;
}

export class ConversationService {
  constructor(private readonly sessionManager: SessionManager) {}

  async list(limit = 50) {
    const conversations = await prisma.conversation.findMany({
      where: { deletedAt: null },
      include: { session: true },
      orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100),
    });
    return conversations.map(toConversationDto);
  }

  async findById(id: string) {
    const conversation = await prisma.conversation.findFirst({
      where: { id, deletedAt: null },
      include: { session: true },
    });
    return conversation ? toConversationDto(conversation) : null;
  }

  async create(input: CreateConversationInput) {
    const rawPrompt = input.prompt.trim();
    if (!rawPrompt) {
      throw new ValidationError('Prompt is required');
    }
    const prompt = await appendAttachmentMarkdownContext(rawPrompt, input.attachmentIds);

    const provider = getProviderById(input.providerId);
    if (!provider) {
      throw new ValidationError(`Provider not found: ${input.providerId}`);
    }

    const conversationId = randomUUID();
    const root = getConversationRoot();
    const directoryName = `${formatTimestamp()}-${conversationId.slice(0, 8)}`;
    const workingDir = assertPathInsideConversationRoot(path.join(root, directoryName), root);

    await fs.mkdir(workingDir, { recursive: true });

    let created: ConversationWithSession;
    try {
      created = await prisma.conversation.create({
        data: {
          id: conversationId,
          title: titleFromPrompt(rawPrompt),
          directoryName,
          workingDir,
          lastActiveAt: new Date(),
          session: {
            create: {
              context: SessionContext.CONVERSATION,
              agentType: provider.agentType as AgentType,
              variant: input.variant ?? 'DEFAULT',
              providerId: provider.id,
              prompt,
              status: SessionStatus.PENDING,
            },
          },
        },
        include: { session: true },
      });
    } catch (error) {
      await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    if (!created.session) {
      throw new ServiceError('Conversation session was not created', 'CONVERSATION_SESSION_MISSING', 500);
    }

    try {
      await this.sessionManager.start(created.session.id);
    } catch (error) {
      await prisma.session.update({
        where: { id: created.session.id },
        data: { status: SessionStatus.FAILED },
      }).catch(() => {});
      throw error;
    }

    const refreshed = await prisma.conversation.findUniqueOrThrow({
      where: { id: created.id },
      include: { session: true },
    });
    return toConversationDto(refreshed);
  }

  async sendMessage(id: string, input: SendConversationMessageInput) {
    const message = await appendAttachmentMarkdownContext(input.message.trim(), input.attachmentIds);
    if (!message) {
      throw new ValidationError('Message is required');
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id, deletedAt: null },
      include: { session: true },
    });
    if (!conversation) {
      throw new NotFoundError('Conversation', id);
    }
    if (!conversation.session) {
      throw new ServiceError('Conversation has no session', 'CONVERSATION_SESSION_MISSING', 409);
    }

    await this.sessionManager.sendMessage(
      conversation.session.id,
      message,
      input.providerId,
    );

    const updated = await prisma.conversation.update({
      where: { id },
      data: { lastActiveAt: new Date() },
      include: { session: true },
    });
    return toConversationDto(updated);
  }

  async stop(id: string) {
    const conversation = await prisma.conversation.findFirst({
      where: { id, deletedAt: null },
      include: { session: true },
    });
    if (!conversation) {
      throw new NotFoundError('Conversation', id);
    }
    if (conversation.session) {
      await this.sessionManager.stop(conversation.session.id);
    }
    const updated = await prisma.conversation.findUniqueOrThrow({
      where: { id },
      include: { session: true },
    });
    return toConversationDto(updated);
  }

  async delete(id: string) {
    const conversation = await prisma.conversation.findFirst({
      where: { id, deletedAt: null },
      include: { session: true },
    });
    if (!conversation) {
      throw new NotFoundError('Conversation', id);
    }

    if (conversation.session) {
      await this.sessionManager.stop(conversation.session.id).catch(() => {});
    }

    const safePath = assertPathInsideConversationRoot(conversation.workingDir);
    await fs.rm(safePath, { recursive: true, force: true });
    await prisma.conversation.delete({ where: { id } });
    return true;
  }
}
