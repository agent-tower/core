import { prisma } from '../utils/index.js';
import { AgentType, SessionStatus, SessionPurpose, TaskStatus } from '../types/index.js';
import { getExecutor, ExecutionEnv } from '../executors/index.js';
import {
  sessionMsgStoreManager,
  createClaudeCodeParser,
  createCursorAgentParser,
  createUserMessage,
  addNormalizedEntry,
} from '../output/index.js';
import type { NormalizedConversation } from '../output/index.js';
import type { SpawnedChild } from '../executors/index.js';
import { AgentPipeline, type OutputParser } from '../pipeline/agent-pipeline.js';
import { execGit } from '../git/git-cli.js';
import type { EventBus } from '../core/event-bus.js';
import { getCommitMessageService } from '../core/container.js';

const DEBUG_SNAPSHOT = process.env.DEBUG_SNAPSHOT === 'true';

export class SessionManager {
  private pipelines = new Map<string, AgentPipeline>();
  private snapshotFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshotFlushChains = new Map<string, Promise<void>>();
  private pendingSnapshotStatus = new Map<string, SessionStatus>();
  private static readonly SNAPSHOT_DEBOUNCE_MS = 1200;

  constructor(private readonly eventBus: EventBus) {
    // Debounced snapshot persistence: keep DB up-to-date without per-patch writes.
    this.eventBus.on('session:patch', ({ sessionId, patch }) => {
      if (DEBUG_SNAPSHOT) {
        const ops = (patch as Array<{ op?: string; path?: string }>).slice(0, 3)
          .map((p) => `${p.op ?? '?'}:${p.path ?? '?'}`)
          .join(', ');
        console.log(
          `[SessionManager:snapshot] patch sessionId=${sessionId} ops=${(patch as unknown[]).length} [${ops}]`
        );
      }
      this.scheduleSnapshotPersist(sessionId);
    });

    this.eventBus.on('session:exit', ({ sessionId }) => {
      const pipeline = this.pipelines.get(sessionId);
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] session:exit sessionId=${sessionId} hasPipeline=${Boolean(pipeline)}`);
      }
      if (pipeline) {
        // Must call destroy() to remove MsgStore onPatch/onSessionId listeners.
        // Without this, stale listeners accumulate across send/exit cycles and
        // each subsequent pushPatch() forwards the same patch N times.
        pipeline.destroy();
        this.pipelines.delete(sessionId);
      }
      this.handleSessionExit(sessionId).catch((error) => {
        console.error(`[SessionManager] post-exit handling failed for ${sessionId}:`, error);
      });
    });

    this.eventBus.on('session:started', ({ sessionId }) => {
      this.checkTaskAutoRevert(sessionId).catch((error) => {
        console.error(`[SessionManager] checkTaskAutoRevert failed for session ${sessionId}:`, error);
      });
    });
  }

  async findById(id: string) {
    return prisma.session.findUnique({
      where: { id },
      include: { processes: true, workspace: true },
    });
  }

  async create(workspaceId: string, agentType: AgentType, prompt: string, variant: string = 'DEFAULT') {
    return prisma.session.create({
      data: {
        workspaceId,
        agentType,
        variant,
        prompt,
        status: SessionStatus.PENDING,
      },
    });
  }

  async start(id: string) {
    const session = await prisma.session.findUnique({
      where: { id },
      include: { workspace: true },
    });
    if (!session) return null;

    const agentType = session.agentType as AgentType;
    const executor = getExecutor(agentType, session.variant ?? 'DEFAULT');
    if (!executor) {
      throw new Error(`Executor not found for agent type: ${session.agentType}`);
    }

    const workingDir = session.workspace.worktreePath;
    const spawnResult = await executor.spawn({
      workingDir,
      prompt: session.prompt,
      env: ExecutionEnv.default(workingDir),
    });

    await prisma.executionProcess.create({
      data: {
        sessionId: id,
        pid: spawnResult.pid,
      },
    });

    await prisma.session.update({
      where: { id },
      data: { status: SessionStatus.RUNNING },
    });

    this.attachPipeline(id, agentType, workingDir, spawnResult);
    this.eventBus.emit('session:started', { sessionId: id });
    return session;
  }

  async sendMessage(id: string, message: string) {
    const session = await prisma.session.findUnique({
      where: { id },
      include: { workspace: true },
    });
    if (!session) return null;

    const existing = this.pipelines.get(id);
    if (existing) {
      // Checkpoint snapshot before replacing PTY pipeline.
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] sendMessage checkpoint before pipeline replace sessionId=${id}`);
      }
      await this.flushSnapshotPersist(id);
      existing.destroy();
      this.pipelines.delete(id);
    }

    const isNewStore = !sessionMsgStoreManager.has(id);
    const msgStore = sessionMsgStoreManager.getOrCreate(id);

    if (isNewStore && session.logSnapshot) {
      try {
        const snapshot = JSON.parse(session.logSnapshot) as NormalizedConversation;
        msgStore.restoreFromSnapshot(snapshot);
      } catch (error) {
        console.error(`[SessionManager] Failed to restore snapshot for session ${id}:`, error);
      }
    }

    // Heal index drift caused by previously failed patches (e.g. invalid value).
    // If entryIndex is ahead of snapshot length, subsequent add/replace paths
    // become out-of-bounds and all later patches fail.
    const preflightSnapshot = msgStore.getSnapshot();
    const expectedIndex = preflightSnapshot.entries.length;
    const currentIndex = msgStore.entryIndex.current();
    if (currentIndex !== expectedIndex) {
      if (DEBUG_SNAPSHOT) {
        console.warn(
          `[SessionManager:snapshot] rebase entryIndex sessionId=${id} currentIndex=${currentIndex} expectedIndex=${expectedIndex}`
        );
      }
      msgStore.entryIndex.startFrom(expectedIndex);
    }

    const userEntry = createUserMessage(message);
    const userIndex = msgStore.entryIndex.next();
    const userPatch = addNormalizedEntry(userIndex, userEntry);
    if (DEBUG_SNAPSHOT) {
      console.log(
        `[SessionManager:snapshot] sendMessage userPatch sessionId=${id} index=${userIndex} currentIndex=${msgStore.entryIndex.current()}`
      );
    }
    msgStore.pushPatch(userPatch);
    // Emit directly to EventBus — the old pipeline was already destroyed so
    // MsgStore's patchListeners are empty at this point. Without this line
    // the user-message patch would never reach WebSocket subscribers.
    this.eventBus.emit('session:patch', { sessionId: id, patch: userPatch });

    const agentSessionId = this.resolveAgentSessionId(id, session.logSnapshot);
    const agentType = session.agentType as AgentType;
    const executor = getExecutor(agentType, session.variant ?? 'DEFAULT');
    if (!executor) {
      throw new Error(`Executor not found for agent type: ${session.agentType}`);
    }

    const workingDir = session.workspace.worktreePath;
    const spawnConfig = {
      workingDir,
      prompt: message,
      env: ExecutionEnv.default(workingDir),
    };

    let spawnResult: SpawnedChild;
    if (agentSessionId && executor.spawnFollowUp) {
      try {
        spawnResult = await executor.spawnFollowUp(spawnConfig, agentSessionId);
      } catch {
        spawnResult = await executor.spawn(spawnConfig);
      }
    } else {
      spawnResult = await executor.spawn(spawnConfig);
    }

    await prisma.executionProcess.create({
      data: {
        sessionId: id,
        pid: spawnResult.pid,
      },
    });

    await prisma.session.update({
      where: { id },
      data: { status: SessionStatus.RUNNING },
    });

    this.attachPipeline(id, agentType, workingDir, spawnResult);
    this.eventBus.emit('session:started', { sessionId: id });
    return session;
  }

  async stop(id: string) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return null;

    const pipeline = this.pipelines.get(id);
    if (pipeline) {
      pipeline.destroy();
      this.pipelines.delete(id);
    }

    const msgStore = sessionMsgStoreManager.get(id);
    if (msgStore) {
      msgStore.pushFinished();
      try {
        await this.flushSnapshotPersist(id, SessionStatus.CANCELLED);
      } catch (error) {
        console.error(`[SessionManager] Failed to persist cancelled snapshot for ${id}:`, error);
        await prisma.session.update({
          where: { id },
          data: { status: SessionStatus.CANCELLED },
        });
      }
    } else {
      await prisma.session.update({
        where: { id },
        data: { status: SessionStatus.CANCELLED },
      });
    }

    this.eventBus.emit('session:stopped', { sessionId: id });
    return session;
  }

  writeInput(sessionId: string, data: string): void {
    const pipeline = this.pipelines.get(sessionId);
    if (!pipeline) return;
    pipeline.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const pipeline = this.pipelines.get(sessionId);
    if (!pipeline) return;
    pipeline.resize(cols, rows);
  }

  private resolveAgentSessionId(sessionId: string, logSnapshot: string | null): string | null {
    const msgStore = sessionMsgStoreManager.get(sessionId);
    if (msgStore) {
      const snapshot = msgStore.getSnapshot();
      if (snapshot.sessionId) return snapshot.sessionId;
    }

    if (logSnapshot) {
      try {
        const parsed = JSON.parse(logSnapshot) as NormalizedConversation;
        if (parsed.sessionId) return parsed.sessionId;
      } catch {
        // ignore invalid snapshot json
      }
    }
    return null;
  }

  private attachPipeline(
    sessionId: string,
    agentType: AgentType,
    workingDir: string,
    spawnResult: SpawnedChild
  ): void {
    const msgStore = sessionMsgStoreManager.getOrCreate(sessionId);
    const parser = this.createParser(agentType, workingDir, msgStore);
    const pipeline = new AgentPipeline(sessionId, spawnResult.pty, parser, msgStore, this.eventBus);
    this.pipelines.set(sessionId, pipeline);
  }

  private createParser(agentType: AgentType, workingDir: string, msgStore: ReturnType<typeof sessionMsgStoreManager.getOrCreate>): OutputParser | null {
    if (agentType === AgentType.CLAUDE_CODE) {
      return createClaudeCodeParser(msgStore);
    }
    if (agentType === AgentType.CURSOR_AGENT) {
      return createCursorAgentParser(msgStore, workingDir);
    }
    return null;
  }

  /**
   * Agent 进程退出后自动提交未保存的变更。
   * 保证 worktree 始终干净的兜底机制，最终会被 squash merge 合并。
   * 参考: vibe-kanban crates/local-deployment/src/container.rs:496-505
   */
  private async autoCommitChanges(sessionId: string): Promise<void> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: true },
      });
      if (!session?.workspace?.worktreePath) return;

      const worktreePath = session.workspace.worktreePath;

      const status = await execGit(worktreePath, ['status', '--porcelain']);
      if (!status.trim()) return;

      await execGit(worktreePath, ['add', '-A']);
      await execGit(worktreePath, [
        'commit', '-m',
        `auto-commit: uncommitted changes from session ${sessionId.slice(0, 8)}`,
      ]);

      console.log(`[SessionManager] Auto-committed changes for session ${sessionId}`);
    } catch (error) {
      // auto-commit 失败不应阻断后续流程
      console.warn(
        `[SessionManager] Auto-commit failed for session ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  private async persistCompletedSnapshot(sessionId: string): Promise<void> {
    await this.flushSnapshotPersist(sessionId, SessionStatus.COMPLETED);
  }

  private scheduleSnapshotPersist(sessionId: string, status?: SessionStatus): void {
    if (status) {
      this.pendingSnapshotStatus.set(sessionId, status);
    }
    const timer = this.snapshotFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
    }
    const nextTimer = setTimeout(() => {
      this.snapshotFlushTimers.delete(sessionId);
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] debounce fire sessionId=${sessionId}`);
      }
      this.flushSnapshotPersist(sessionId).catch((error) => {
        console.error(`[SessionManager] Debounced snapshot persist failed for ${sessionId}:`, error);
      });
    }, SessionManager.SNAPSHOT_DEBOUNCE_MS);
    this.snapshotFlushTimers.set(sessionId, nextTimer);
    if (DEBUG_SNAPSHOT) {
      console.log(
        `[SessionManager:snapshot] debounce scheduled sessionId=${sessionId} ms=${SessionManager.SNAPSHOT_DEBOUNCE_MS} status=${status ?? 'none'}`
      );
    }
  }

  private async flushSnapshotPersist(sessionId: string, status?: SessionStatus): Promise<void> {
    if (status) {
      this.pendingSnapshotStatus.set(sessionId, status);
    }
    const timer = this.snapshotFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.snapshotFlushTimers.delete(sessionId);
    }

    const previous = this.snapshotFlushChains.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // Keep the chain alive even if previous flush failed.
      })
      .then(async () => {
        const pendingStatus = this.pendingSnapshotStatus.get(sessionId);
        this.pendingSnapshotStatus.delete(sessionId);
        if (DEBUG_SNAPSHOT) {
          console.log(
            `[SessionManager:snapshot] flush start sessionId=${sessionId} pendingStatus=${pendingStatus ?? 'none'}`
          );
        }

        const msgStore = sessionMsgStoreManager.get(sessionId);
        if (!msgStore) {
          if (DEBUG_SNAPSHOT) {
            console.log(`[SessionManager:snapshot] flush no-msgStore sessionId=${sessionId}`);
          }
          if (pendingStatus) {
            await prisma.session.update({
              where: { id: sessionId },
              data: { status: pendingStatus },
            });
            if (DEBUG_SNAPSHOT) {
              console.log(
                `[SessionManager:snapshot] flush status-only persisted sessionId=${sessionId} status=${pendingStatus}`
              );
            }
          }
          return;
        }

        const snapshot = msgStore.getSnapshot();
        const tokenUsage = this.extractTokenUsageFromSnapshot(snapshot);
        if (DEBUG_SNAPSHOT) {
          const msgCount = msgStore.getMessages().length;
          const nextIndex = msgStore.entryIndex.current();
          console.log(
            `[SessionManager:snapshot] flush snapshot sessionId=${sessionId} entries=${snapshot.entries.length} msgCount=${msgCount} nextIndex=${nextIndex} tokenUsage=${tokenUsage ? 'yes' : 'no'}`
          );
        }

        if (pendingStatus) {
          await prisma.session.update({
            where: { id: sessionId },
            data: {
              status: pendingStatus,
              logSnapshot: JSON.stringify(snapshot),
              ...(tokenUsage ? { tokenUsage: JSON.stringify(tokenUsage) } : {}),
            },
          });
          if (DEBUG_SNAPSHOT) {
            console.log(
              `[SessionManager:snapshot] flush persisted sessionId=${sessionId} status=${pendingStatus} entries=${snapshot.entries.length}`
            );
          }
          return;
        }

        await prisma.session.update({
          where: { id: sessionId },
          data: {
            logSnapshot: JSON.stringify(snapshot),
            ...(tokenUsage ? { tokenUsage: JSON.stringify(tokenUsage) } : {}),
          },
        });
        if (DEBUG_SNAPSHOT) {
          console.log(
            `[SessionManager:snapshot] flush persisted sessionId=${sessionId} status=unchanged entries=${snapshot.entries.length}`
          );
        }
      });

    this.snapshotFlushChains.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.snapshotFlushChains.get(sessionId) === current) {
        this.snapshotFlushChains.delete(sessionId);
      }
    }
  }

  private extractTokenUsageFromSnapshot(snapshot: NormalizedConversation): { totalTokens: number; modelContextWindow?: number } | null {
    for (let i = snapshot.entries.length - 1; i >= 0; i--) {
      const entry = snapshot.entries[i];
      if (entry.entryType === 'token_usage_info' && entry.metadata?.tokenUsage?.totalTokens != null) {
        return entry.metadata.tokenUsage as { totalTokens: number; modelContextWindow?: number };
      }
    }
    return null;
  }

  /**
   * Session 完成后检查 Task 是否可以自动推进状态。
   *
   * 规则：当一个 Task 下所有 Workspace 的所有 CHAT Session 都处于终态
   * （COMPLETED / CANCELLED / FAILED）时，自动将 IN_PROGRESS 的 Task
   * 推进到 IN_REVIEW，提示用户进行代码审查。
   * 同时触发 commit message 的后台生成。
   */
  private async checkTaskAutoAdvance(sessionId: string): Promise<void> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: { include: { task: true } } },
      });
      if (!session?.workspace?.task) return;

      const task = session.workspace.task;
      // 只对 IN_PROGRESS 的 Task 做自动推进
      if (task.status !== TaskStatus.IN_PROGRESS) return;

      // 查询该 Task 下所有 CHAT Session（排除 COMMIT_MSG）
      const allSessions = await prisma.session.findMany({
        where: {
          workspace: { taskId: task.id },
          purpose: { not: SessionPurpose.COMMIT_MSG },
        },
        select: { status: true },
      });

      const terminalStatuses: string[] = [SessionStatus.COMPLETED, SessionStatus.CANCELLED, SessionStatus.FAILED];
      const allDone = allSessions.every((s) => terminalStatuses.includes(s.status));

      if (allDone && allSessions.length > 0) {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: TaskStatus.IN_REVIEW },
        });

        this.eventBus.emit('task:updated', {
          taskId: task.id,
          projectId: task.projectId,
          status: TaskStatus.IN_REVIEW,
        });

        console.log(`[SessionManager] Task ${task.id} auto-advanced to IN_REVIEW (all sessions completed)`);
      }
    } catch (error) {
      console.error(`[SessionManager] checkTaskAutoAdvance failed for session ${sessionId}:`, error);
    }
  }

  /**
   * 异步触发 commit message 生成（fire-and-forget）
   */
  private triggerCommitMessageGeneration(workspaceId: string): void {
    const commitMessageService = getCommitMessageService();
    commitMessageService.triggerGeneration(workspaceId).catch((error) => {
      console.warn(
        `[SessionManager] Failed to trigger commit message generation for workspace ${workspaceId}:`,
        error instanceof Error ? error.message : error
      );
    });
  }

  /**
   * Session 启动时检查 Task 是否需要自动回退状态。
   *
   * 规则：当某个 Session 重新变为 RUNNING 时，如果所属 Task 处于
   * IN_REVIEW 或 DONE，自动回退到 IN_PROGRESS，表示工作重新进行中。
   * 注意：COMMIT_MSG session 启动不应触发状态回退。
   */
  private async checkTaskAutoRevert(sessionId: string): Promise<void> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: { include: { task: true } } },
      });
      if (!session?.workspace?.task) return;

      // COMMIT_MSG session 不触发状态回退
      if (session.purpose === SessionPurpose.COMMIT_MSG) return;

      const task = session.workspace.task;
      const revertableStatuses: string[] = [TaskStatus.IN_REVIEW, TaskStatus.DONE];
      if (!revertableStatuses.includes(task.status)) return;

      await prisma.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.IN_PROGRESS },
      });

      this.eventBus.emit('task:updated', {
        taskId: task.id,
        projectId: task.projectId,
        status: TaskStatus.IN_PROGRESS,
      });

      console.log(
        `[SessionManager] Task ${task.id} auto-reverted from ${task.status} to IN_PROGRESS (session ${sessionId} started)`,
      );
    } catch (error) {
      console.error(`[SessionManager] checkTaskAutoRevert failed for session ${sessionId}:`, error);
    }
  }

  /**
   * Session 退出后的统一处理入口。
   * 根据 session purpose 走不同的后处理路径。
   */
  private async handleSessionExit(sessionId: string): Promise<void> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { purpose: true },
    });

    if (session?.purpose === SessionPurpose.COMMIT_MSG) {
      // COMMIT_MSG session: 只需持久化快照，然后提取 commit message
      await this.flushSnapshotPersist(sessionId, SessionStatus.COMPLETED);
      try {
        const commitMessageService = getCommitMessageService();
        await commitMessageService.extractAndCache(sessionId);
      } catch (error) {
        console.warn(
          `[SessionManager] Failed to extract commit message from session ${sessionId}:`,
          error instanceof Error ? error.message : error
        );
      }
      // 通知前端 session 已完成（DB 状态已更新）
      this.eventBus.emit('session:completed', { sessionId, status: SessionStatus.COMPLETED });
    } else {
      // 正常 CHAT session: autoCommit → 持久化 → 检查 Task 推进 → 触发 commit message 生成
      await this.autoCommitChanges(sessionId);
      await this.flushSnapshotPersist(sessionId, SessionStatus.COMPLETED);
      // 通知前端 session 已完成（DB 状态已更新）
      this.eventBus.emit('session:completed', { sessionId, status: SessionStatus.COMPLETED });
      await this.checkTaskAutoAdvance(sessionId);

      // 每次 CHAT session 完成都触发 commit message 重新生成
      const sess = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { workspaceId: true },
      });
      if (sess?.workspaceId) {
        this.triggerCommitMessageGeneration(sess.workspaceId);
      }
    }
  }
}
