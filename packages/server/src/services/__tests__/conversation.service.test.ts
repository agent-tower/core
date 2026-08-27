import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { SessionContext, SessionStatus } from '../../types/index.js';
import type { ServiceError } from '../../errors.js';
import type { TeamReconcilerService } from '../team-reconciler.service.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-conversation-service-'));
const dataDir = path.join(testDir, 'data');
const dbPath = path.join(testDir, 'test.db');

process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = dataDir;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let EventBus: typeof import('../../core/event-bus.js').EventBus;
let SessionManager: typeof import('../session-manager.js').SessionManager;
let ConversationService: typeof import('../conversation.service.js').ConversationService;
let assertPathInsideConversationRoot: typeof import('../conversation.service.js').assertPathInsideConversationRoot;
let CommandBuildError: typeof import('../../executors/command-builder.js').CommandBuildError;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Conversation service safety', () => {
  async function waitForCondition(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 2_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for condition');
  }

  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: {
          ...process.env,
          AGENT_TOWER_DATABASE_URL: `file:${dbPath}`,
          AGENT_TOWER_DATA_DIR: dataDir,
        },
        stdio: 'pipe',
      },
    );

    const utilsModule = await import('../../utils/index.js');
    const eventBusModule = await import('../../core/event-bus.js');
    const sessionManagerModule = await import('../session-manager.js');
    const conversationServiceModule = await import('../conversation.service.js');
    const commandBuilderModule = await import('../../executors/command-builder.js');
    prisma = utilsModule.prisma;
    EventBus = eventBusModule.EventBus;
    SessionManager = sessionManagerModule.SessionManager;
    ConversationService = conversationServiceModule.ConversationService;
    assertPathInsideConversationRoot = conversationServiceModule.assertPathInsideConversationRoot;
    CommandBuildError = commandBuilderModule.CommandBuildError;
  });

  beforeEach(async () => {
    process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
    process.env.AGENT_TOWER_DATA_DIR = dataDir;
    vi.clearAllMocks();
    await prisma.executionProcess.deleteMany();
    await prisma.agentInvocation.deleteMany();
    await prisma.workRequest.deleteMany();
    await prisma.roomMessage.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
    await prisma.conversation.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects deletion paths outside the conversations root', () => {
    const root = path.join(dataDir, 'conversations');

    expect(assertPathInsideConversationRoot(path.join(root, '20260618-test'), root))
      .toBe(path.join(root, '20260618-test'));
    expect(() => assertPathInsideConversationRoot(path.join(root, '..', 'outside'), root))
      .toThrow(/outside the managed conversations root/);
    expect(() => assertPathInsideConversationRoot(root, root))
      .toThrow(/outside the managed conversations root/);
  });

  it('does not run TeamRun reconciliation when stopping a conversation session', async () => {
    const conversation = await prisma.conversation.create({
      data: {
        title: 'Quick question',
        directoryName: '20260618-quick-question',
        workingDir: path.join(dataDir, 'conversations', '20260618-quick-question'),
        session: {
          create: {
            context: SessionContext.CONVERSATION,
            agentType: 'CODEX',
            providerId: 'provider-1',
            prompt: 'Hello',
            status: SessionStatus.RUNNING,
          },
        },
      },
      include: { session: true },
    });
    const handleSessionStopped = vi.fn();
    const reconciler = {
      handleSessionStopped,
    } as unknown as TeamReconcilerService;
    const manager = new SessionManager(new EventBus(), reconciler);

    await expect(manager.stop(conversation.session!.id)).resolves.toMatchObject({
      id: conversation.session!.id,
    });

    expect(handleSessionStopped).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({ where: { id: conversation.session!.id } }))
      .resolves.toMatchObject({ status: SessionStatus.CANCELLED });
  });

  it('maps command build failures while starting a conversation to a service error', async () => {
    const start = vi.fn(async () => {
      throw new CommandBuildError("Executable 'claude' not found in PATH");
    });
    const service = new ConversationService({
      start,
    } as unknown as InstanceType<typeof SessionManager>);

    await expect(service.create({
      prompt: 'hello',
      providerId: 'claude-code-default',
    })).rejects.toMatchObject({
      name: 'ServiceError',
      code: 'AGENT_COMMAND_UNAVAILABLE',
      statusCode: 400,
      message: "Agent command unavailable: Executable 'claude' not found in PATH",
    } satisfies Partial<ServiceError>);

    expect(start).toHaveBeenCalledTimes(1);
    const session = await prisma.session.findFirst({
      where: { agentType: 'CLAUDE_CODE' },
      select: { status: true },
    });
    expect(session?.status).toBe(SessionStatus.FAILED);
  });

  it('queues the initial prompt without waiting for runtime startup', async () => {
    const enqueueConversationMessage = vi.fn(async () => ({ turnId: 'turn-1' }));
    const start = vi.fn();
    const service = new ConversationService({
      enqueueConversationMessage,
      start,
    } as unknown as InstanceType<typeof SessionManager>);

    const result = await service.create({
      prompt: 'hello',
      providerId: 'claude-code-default',
    });

    expect(enqueueConversationMessage).toHaveBeenCalledWith(
      result.sessionId,
      'hello',
      'claude-code-default',
    );
    expect(start).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({
      where: { id: result.sessionId },
      select: { status: true },
    })).resolves.toMatchObject({ status: SessionStatus.PENDING });
  });

  it('maps command build failures while sending a conversation message to a service error', async () => {
    const sendMessage = vi.fn(async () => {
      throw new CommandBuildError("Executable 'claude' not found in PATH");
    });
    const service = new ConversationService({
      sendMessage,
    } as unknown as InstanceType<typeof SessionManager>);
    const conversation = await prisma.conversation.create({
      data: {
        title: 'Quick question',
        directoryName: '20260618-quick-question',
        workingDir: path.join(dataDir, 'conversations', '20260618-quick-question'),
        session: {
          create: {
            context: SessionContext.CONVERSATION,
            agentType: 'CLAUDE_CODE',
            providerId: 'claude-code-default',
            prompt: 'Hello',
            status: SessionStatus.COMPLETED,
          },
        },
      },
      include: { session: true },
    });

    await expect(service.sendMessage(conversation.id, {
      message: 'continue',
      providerId: 'claude-code-default',
    })).rejects.toMatchObject({
      name: 'ServiceError',
      code: 'AGENT_COMMAND_UNAVAILABLE',
      statusCode: 400,
      message: "Agent command unavailable: Executable 'claude' not found in PATH",
    } satisfies Partial<ServiceError>);

    expect(sendMessage).toHaveBeenCalledWith(
      conversation.session!.id,
      'continue',
      'claude-code-default',
    );
  });

  it('persists a conversation turn through the queue without waiting for runtime startup', async () => {
    const enqueueConversationMessage = vi.fn(async () => ({ turnId: 'turn-1' }));
    const sendMessage = vi.fn();
    const service = new ConversationService({
      enqueueConversationMessage,
      sendMessage,
    } as unknown as InstanceType<typeof SessionManager>);
    const conversation = await prisma.conversation.create({
      data: {
        title: 'Queued question',
        directoryName: '20260618-queued-question',
        workingDir: path.join(dataDir, 'conversations', '20260618-queued-question'),
        session: {
          create: {
            context: SessionContext.CONVERSATION,
            agentType: 'CODEX',
            providerId: 'provider-1',
            prompt: 'Hello',
            status: SessionStatus.COMPLETED,
          },
        },
      },
      include: { session: true },
    });

    const result = await service.sendMessage(conversation.id, {
      message: 'continue',
      providerId: 'provider-1',
    });

    expect(enqueueConversationMessage).toHaveBeenCalledWith(
      conversation.session!.id,
      'continue',
      'provider-1',
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.id).toBe(conversation.id);
  });

  it('executes queued conversation turns serially without cancelling the prior turn', async () => {
    const conversation = await prisma.conversation.create({
      data: {
        title: 'Serial queue',
        directoryName: '20260618-serial-queue',
        workingDir: path.join(dataDir, 'conversations', '20260618-serial-queue'),
        session: {
          create: {
            context: SessionContext.CONVERSATION,
            agentType: 'CODEX',
            prompt: 'Hello',
            status: SessionStatus.COMPLETED,
          },
        },
      },
      include: { session: true },
    });
    const manager = new SessionManager(new EventBus());
    const runtimeCoordinator = (manager as any).runtimeCoordinator as {
      waitForTurnCompletion: (...args: never[]) => Promise<void>;
      abandonTurn: (...args: never[]) => Promise<boolean>;
    };
    const firstTurnCompletion = deferred<void>();
    const waitForTurnCompletion = vi.spyOn(runtimeCoordinator, 'waitForTurnCompletion')
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(firstTurnCompletion.promise)
      .mockResolvedValue(undefined);
    const abandonTurn = vi.spyOn(runtimeCoordinator, 'abandonTurn');
    const dispatch = vi.spyOn(manager, 'sendMessage').mockResolvedValue(null);

    await manager.enqueueConversationMessage(conversation.session!.id, 'first');
    await manager.enqueueConversationMessage(conversation.session!.id, 'second');
    await waitForCondition(() => dispatch.mock.calls.length === 1);
    expect(dispatch.mock.calls[0]?.[1]).toBe('first');
    expect(waitForTurnCompletion).toHaveBeenCalledTimes(2);
    expect(abandonTurn).not.toHaveBeenCalled();

    await expect(prisma.conversationTurn.findMany({
      where: { sessionId: conversation.session!.id },
      orderBy: { queuedAt: 'asc' },
      select: { message: true, status: true },
    })).resolves.toEqual([
      { message: 'first', status: 'RUNNING' },
      { message: 'second', status: 'QUEUED' },
    ]);

    firstTurnCompletion.resolve();
    await waitForCondition(() => dispatch.mock.calls.length === 2);
    expect(dispatch.mock.calls[1]?.[1]).toBe('second');
    await waitForCondition(async () => {
      const turns = await prisma.conversationTurn.findMany({
        where: { sessionId: conversation.session!.id },
        orderBy: { queuedAt: 'asc' },
        select: { message: true, status: true },
      });
      return turns.every((turn) => turn.status === 'COMPLETED');
    });
    manager.stopConversationQueue();
  });

  it('persists a failed queue turn and records the runtime error', async () => {
    const conversation = await prisma.conversation.create({
      data: {
        title: 'Failed queue',
        directoryName: '20260618-failed-queue',
        workingDir: path.join(dataDir, 'conversations', '20260618-failed-queue'),
        session: {
          create: {
            context: SessionContext.CONVERSATION,
            agentType: 'CODEX',
            prompt: 'Hello',
            status: SessionStatus.COMPLETED,
          },
        },
      },
      include: { session: true },
    });
    const manager = new SessionManager(new EventBus());
    const dispatch = vi.spyOn(manager, 'sendMessage')
      .mockRejectedValue(new Error('ACP prompt failed'));

    await manager.enqueueConversationMessage(conversation.session!.id, 'will fail');
    await waitForCondition(() => dispatch.mock.calls.length === 1);
    await waitForCondition(async () => {
      const turn = await prisma.conversationTurn.findFirst({
        where: { sessionId: conversation.session!.id },
      });
      return turn?.status === 'FAILED';
    });

    await expect(prisma.conversationTurn.findFirst({
      where: { sessionId: conversation.session!.id },
      select: { status: true, attempts: true, lastError: true, completedAt: true },
    })).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'ACP prompt failed',
      completedAt: expect.any(Date),
    });
    manager.stopConversationQueue();
  });
});
