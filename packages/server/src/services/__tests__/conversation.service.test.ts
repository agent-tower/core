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

/**
 * Detects a UTF-16 code unit kept without its surrogate-pair counterpart.
 * Bounded failure text used to be sliced straight at the cut point, which
 * persisted half an emoji (rendered as U+FFFD) into the queued turn row.
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
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
    fs.mkdirSync(dataDir, { recursive: true });
    fs.closeSync(fs.openSync(dbPath, 'a'));
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

  it.each(['stop-fails', 'cleanup-unconfirmed'] as const)(
    'preserves conversation directory and process evidence when %s', async (failure) => {
      const workingDir = path.join(dataDir, 'conversations', 'retained-owner');
      fs.mkdirSync(workingDir, { recursive: true });
      const conversation = await prisma.conversation.create({ data: {
        title: 'Cleanup pending', directoryName: 'retained-owner', workingDir,
        session: { create: {
          context: SessionContext.CONVERSATION, agentType: 'CODEX', runtimeType: 'ACP',
          prompt: 'audit', status: 'RUNNING',
          processes: { create: { pid: 999999, cleanupState: 'FAILED' } },
        } },
      }, include: { session: true } });
      const stop = vi.fn(async () => {
        if (failure === 'stop-fails') throw new Error('process still alive');
        return conversation.session;
      });
      const isRuntimeCleanupConfirmed = vi.fn(async () => false);
      const service = new ConversationService({ stop, isRuntimeCleanupConfirmed } as unknown as InstanceType<typeof SessionManager>);
      await expect(service.delete(conversation.id)).rejects.toThrow();
      expect(fs.existsSync(workingDir)).toBe(true);
      expect(await prisma.conversation.findUnique({ where: { id: conversation.id } })).not.toBeNull();
      expect(await prisma.executionProcess.count({ where: { sessionId: conversation.session!.id } })).toBe(1);
      stop.mockImplementation(async () => conversation.session);
      isRuntimeCleanupConfirmed.mockResolvedValue(true);
      await expect(service.delete(conversation.id)).resolves.toBe(true);
      expect(fs.existsSync(workingDir)).toBe(false);
      expect(await prisma.executionProcess.count({ where: { sessionId: conversation.session!.id } })).toBe(0);
    },
  );

  it('rejects follow-ups and queued messages while conversation deletion is awaiting cleanup', async () => {
    const workingDir = path.join(dataDir, 'conversations', 'delete-admission');
    fs.mkdirSync(workingDir, { recursive: true });
    const conversation = await prisma.conversation.create({ data: {
      title: 'Deleting', directoryName: 'delete-admission', workingDir,
      session: { create: { context: SessionContext.CONVERSATION, agentType: 'CODEX', prompt: 'audit', status: 'COMPLETED' } },
    }, include: { session: true } });
    const stopEntered = deferred<void>();
    const releaseStop = deferred<void>();
    const service = new ConversationService({
      stop: async () => { stopEntered.resolve(); await releaseStop.promise; return conversation.session; },
      isRuntimeCleanupConfirmed: async () => true,
    } as unknown as InstanceType<typeof SessionManager>);
    const manager = new SessionManager(new EventBus());
    const deleting = service.delete(conversation.id);
    try {
      await stopEntered.promise;
      await expect(manager.sendMessage(conversation.session!.id, 'late follow-up'))
        .rejects.toMatchObject({ code: 'SESSION_NOT_ADMITTED' });
      await expect(manager.enqueueConversationMessage(conversation.session!.id, 'late queued turn'))
        .rejects.toMatchObject({ code: 'SESSION_NOT_ADMITTED' });
      expect(await prisma.conversationTurn.count()).toBe(0);
      expect(await prisma.executionProcess.count()).toBe(0);
    } finally {
      releaseStop.resolve();
      await deleting;
      await manager.destroyAll();
    }
  });

  it('keeps the root cause line whether it sits at the head or the tail of an oversized failure', async () => {
    const workingDir = path.join(dataDir, 'conversations', 'queue-failure-tail');
    fs.mkdirSync(workingDir, { recursive: true });
    const conversation = await prisma.conversation.create({
      data: {
        title: 'Queue failure',
        directoryName: 'queue-failure-tail',
        workingDir,
        session: {
          create: {
            context: SessionContext.CONVERSATION,
            agentType: 'CODEX',
            runtimeType: 'ACP',
            prompt: 'audit',
            status: SessionStatus.RUNNING,
          },
        },
      },
      include: { session: true },
    });
    const manager = new SessionManager(new EventBus());
    // Mirrors the real failure shape: a generic transport prefix, a long adapter
    // diagnostic, and the root cause on either the first or the final line.
    const tailRootCause = 'Fatal: ACP adapter rejected the prompt because the workspace credential expired';
    const headRootCause = 'Fatal: ACP adapter could not load the workspace manifest';
    const stderrNoise = Array.from(
      { length: 60 },
      () => 'adapter stderr line that is not the root cause',
    ).join('; ');
    vi.spyOn(manager, 'sendMessage')
      .mockRejectedValueOnce(
        new Error(`ACP connection closed; ACP adapter exited with code 1: ${stderrNoise}; ${tailRootCause}`),
      )
      .mockRejectedValueOnce(new Error(`${headRootCause}; ${stderrNoise}`));

    try {
      await manager.enqueueConversationMessage(conversation.session!.id, 'failure with the root cause last');
      await manager.enqueueConversationMessage(conversation.session!.id, 'failure with the root cause first');
      await waitForCondition(async () => await prisma.conversationTurn.count({
        where: { sessionId: conversation.session!.id, status: 'FAILED' },
      }) === 2);

      const tailTurn = await prisma.conversationTurn.findFirstOrThrow({
        where: { sessionId: conversation.session!.id, message: 'failure with the root cause last' },
      });
      expect(tailTurn.lastError).toContain(tailRootCause);
      expect(tailTurn.lastError).toContain('chars omitted');
      expect(tailTurn.lastError!.length).toBeLessThanOrEqual(2_000);

      const headTurn = await prisma.conversationTurn.findFirstOrThrow({
        where: { sessionId: conversation.session!.id, message: 'failure with the root cause first' },
      });
      expect(headTurn.lastError).toContain(headRootCause);
      expect(headTurn.lastError).toContain('chars omitted');
      expect(headTurn.lastError!.length).toBeLessThanOrEqual(2_000);
    } finally {
      await manager.destroyAll();
    }
  });

  it('keeps surrogate pairs whole when bounding a queued turn failure (2_000 code units)', async () => {
    const workingDir = path.join(dataDir, 'conversations', 'queue-failure-surrogate');
    fs.mkdirSync(workingDir, { recursive: true });
    const conversation = await prisma.conversation.create({
      data: {
        title: 'Queue failure with emoji',
        directoryName: 'queue-failure-surrogate',
        workingDir,
        session: {
          create: {
            context: SessionContext.CONVERSATION,
            agentType: 'CODEX',
            runtimeType: 'ACP',
            prompt: 'audit',
            status: SessionStatus.RUNNING,
          },
        },
      },
      include: { session: true },
    });
    const manager = new SessionManager(new EventBus());
    // The 2_000-unit queue bound cuts the head at index 666 and starts the tail
    // 1_286 units before the end. Each failure puts an emoji on one of the cuts,
    // so a straight UTF-16 slice would store half of it in `lastError`.
    const headSplitFailure = `${'a'.repeat(665)}😀${'b'.repeat(2_000)}`;
    const tailSplitFailure = `${'b'.repeat(800)}😀${'c'.repeat(1_285)}`;
    expect(hasUnpairedSurrogate(headSplitFailure.slice(0, 666))).toBe(true);
    expect(hasUnpairedSurrogate(tailSplitFailure.slice(tailSplitFailure.length - 1_286))).toBe(true);
    vi.spyOn(manager, 'sendMessage')
      .mockRejectedValueOnce(new Error(headSplitFailure))
      .mockRejectedValueOnce(new Error(tailSplitFailure));

    try {
      await manager.enqueueConversationMessage(conversation.session!.id, 'failure with a split head emoji');
      await manager.enqueueConversationMessage(conversation.session!.id, 'failure with a split tail emoji');
      const turnsOf = async () => await prisma.conversationTurn.findMany({
        where: { sessionId: conversation.session!.id },
        orderBy: { createdAt: 'asc' },
      });
      await waitForCondition(
        async () => (await turnsOf()).filter((turn) => turn.status === 'FAILED').length === 2,
      ).catch(() => undefined);

      // A lone surrogate is rejected by Prisma before it reaches SQLite, so a
      // code-unit-sliced bound never gets persisted at all; the status assertion
      // reports that as a plain mismatch instead of a bare wait timeout.
      const turns = await turnsOf();
      expect(turns.map((turn) => turn.status)).toEqual(['FAILED', 'FAILED']);
      for (const turn of turns) {
        expect(turn.lastError).toContain('chars omitted');
        expect(turn.lastError!.length).toBeLessThanOrEqual(2_000);
        expect(hasUnpairedSurrogate(turn.lastError!)).toBe(false);
      }
    } finally {
      await manager.destroyAll();
    }
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
