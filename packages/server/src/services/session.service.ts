import { prisma } from '../utils/index.js';
import { AgentType, SessionStatus } from '../types/index.js';
import { getExecutor, ExecutionEnv } from '../executors/index.js';
import {
  sessionMsgStoreManager,
  createClaudeCodeParser,
  createCursorAgentParser,
} from '../output/index.js';
import type { NormalizedConversation } from '../output/index.js';
import { getProcessManager } from '../socket/handlers/terminal.handler.js';
import type { SpawnedChild } from '../executors/index.js';

export class SessionService {

  /**
   * Pipeline generation tracker — 每次 attachPtyPipeline 递增，
   * 旧 PTY 的 onExit 通过比较 generation 来判断是否仍是当前 pipeline，
   * 避免被 sendMessage 替换后的旧 PTY exit 错误地更新 session 状态。
   */
  private pipelineGenerations = new Map<string, number>();

  /**
   * 当前活跃 parser 引用，sendMessage 中 kill PTY 前先 finish 旧 parser
   */
  private activeParsers = new Map<string, { processData(data: string): void; finish(): void }>();

  async findById(id: string) {
    return prisma.session.findUnique({
      where: { id },
      include: { processes: true, workspace: true },
    });
  }

  async create(workspaceId: string, agentType: AgentType, prompt: string) {
    return prisma.session.create({
      data: {
        workspaceId,
        agentType,
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

    if (!session) {
      return null;
    }

    const executor = getExecutor(session.agentType as AgentType);
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

    this.attachPtyPipeline(id, session.agentType as AgentType, workingDir, spawnResult);

    return session;
  }

  /**
   * 统一的消息发送入口 — 无论 session 是 RUNNING 还是 COMPLETED/CANCELLED，
   * 前端统一调此方法。后端自动处理 PTY 状态：
   * - RUNNING: 先 stop 当前 PTY，再 spawn 新 PTY
   * - COMPLETED/CANCELLED: 直接 spawn 新 PTY
   *
   * MsgStore 不销毁，新 PTY 的输出追加到已有消息列表后面。
   */
  async sendMessage(id: string, message: string) {
    const session = await prisma.session.findUnique({
      where: { id },
      include: { workspace: true },
    });

    if (!session) {
      return null;
    }

    // 如果当前 RUNNING，先 finish 旧 parser 并 kill 当前 PTY
    if (session.status === SessionStatus.RUNNING) {
      // Finish old parser synchronously before killing PTY
      const oldParser = this.activeParsers.get(id);
      if (oldParser) {
        oldParser.finish();
        this.activeParsers.delete(id);
      }

      const processManager = getProcessManager();
      processManager.kill(id);
      // 注意：不改 session.status，不销毁 MsgStore
      // kill 后旧 PTY 的 onExit 会触发，但 generation 已过期，不会更新 status
    }

    // 获取或创建 MsgStore（不销毁旧的！）
    const msgStore = sessionMsgStoreManager.getOrCreate(id);
    // 重置 MsgStore 的 finished 状态，让新 PATCH 事件能继续产出
    msgStore.resetFinished();

    // 解析 agentSessionId（用于 spawnFollowUp 继续会话）
    const agentSessionId = this.resolveAgentSessionId(id, session.logSnapshot);

    // spawn 新 PTY
    const agentType = session.agentType as AgentType;
    const executor = getExecutor(agentType);
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
        // spawnFollowUp 失败，fallback 到普通 spawn
        spawnResult = await executor.spawn(spawnConfig);
      }
    } else {
      spawnResult = await executor.spawn(spawnConfig);
    }

    // 创建新的 executionProcess 记录
    await prisma.executionProcess.create({
      data: {
        sessionId: id,
        pid: spawnResult.pid,
      },
    });

    // 更新 session 状态为 RUNNING
    await prisma.session.update({
      where: { id },
      data: { status: SessionStatus.RUNNING },
    });

    // attach 新 PTY 到同一个 MsgStore（关键：复用，不重建）
    this.attachPtyPipeline(id, agentType, workingDir, spawnResult);

    return session;
  }

  async stop(id: string) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) {
      return null;
    }

    // Finish parser before killing
    const parser = this.activeParsers.get(id);
    if (parser) {
      parser.finish();
      this.activeParsers.delete(id);
    }

    const processManager = getProcessManager();
    processManager.kill(id);

    // MsgStore 不销毁 — 用户可以继续发消息恢复会话
    // 但标记 finished，让前端知道当前轮次结束
    const msgStore = sessionMsgStoreManager.get(id);
    if (msgStore) {
      msgStore.pushFinished();

      // 持久化日志快照
      try {
        const snapshot = msgStore.getSnapshot();
        await prisma.session.update({
          where: { id },
          data: {
            status: SessionStatus.CANCELLED,
            logSnapshot: JSON.stringify(snapshot),
          },
        });
      } catch (error) {
        console.error(`[SessionService] Failed to persist log snapshot for session ${id}:`, error);
        // Fallback: just update status
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

    return session;
  }

  /**
   * 从内存 MsgStore 或数据库 logSnapshot 中解析 agent 内部的 sessionId
   */
  private resolveAgentSessionId(sessionId: string, logSnapshot: string | null): string | null {
    // 优先从内存 MsgStore 获取
    const msgStore = sessionMsgStoreManager.get(sessionId);
    if (msgStore) {
      const snapshot = msgStore.getSnapshot();
      if (snapshot.sessionId) {
        return snapshot.sessionId;
      }
    }

    // 从数据库 logSnapshot JSON 中解析
    if (logSnapshot) {
      try {
        const parsed = JSON.parse(logSnapshot) as NormalizedConversation;
        if (parsed.sessionId) {
          return parsed.sessionId;
        }
      } catch {
        // JSON 解析失败，忽略
      }
    }

    return null;
  }

  /**
   * 将 PTY 输出连接到 MsgStore + Parser pipeline 并注册到 ProcessManager
   * start 和 sendMessage 共用此逻辑
   *
   * 关键变化：MsgStore 通过 getOrCreate 获取，不再每次创建新的。
   * 每次调用会递增 pipeline generation，旧 PTY 的 onExit 通过 generation
   * 判断是否仍是当前 pipeline。
   */
  private attachPtyPipeline(
    sessionId: string,
    agentType: AgentType,
    workingDir: string,
    spawnResult: SpawnedChild
  ): void {
    // 获取或创建 MsgStore（复用已有的，不销毁重建）
    const msgStore = sessionMsgStoreManager.getOrCreate(sessionId);

    // 递增 pipeline generation
    const generation = (this.pipelineGenerations.get(sessionId) || 0) + 1;
    this.pipelineGenerations.set(sessionId, generation);

    // 根据 agent 类型创建解析器（将原始 PTY stdout 转换为标准化 JSON Patch）
    // 每次 PTY 重启需要新的 parser 实例（新的输出流），
    // 但 parser 使用 MsgStore 共享的 entryIndex，entry 会正确追加
    let parser: { processData(data: string): void; finish(): void } | null = null;
    if (agentType === AgentType.CLAUDE_CODE) {
      parser = createClaudeCodeParser(msgStore);
    } else if (agentType === AgentType.CURSOR_AGENT) {
      parser = createCursorAgentParser(msgStore, workingDir);
    }

    // 存储 parser 引用，供 sendMessage/stop 中 finish
    if (parser) {
      this.activeParsers.set(sessionId, parser);
    }

    // 将 PTY 输出转发到 MsgStore 和解析器
    spawnResult.pty.onData((data) => {
      msgStore.pushStdout(data);
      if (parser) {
        parser.processData(data);
      }
    });

    // PTY 退出时：仅当此 pipeline 仍是当前活跃的才做完整清理
    spawnResult.pty.onExit(async () => {
      if (parser) {
        parser.finish();
      }

      // 只有当前 generation 匹配时才做 session 状态更新和 finished 推送
      // 如果不匹配，说明 sendMessage 已经替换了新的 PTY，忽略此 exit
      if (this.pipelineGenerations.get(sessionId) !== generation) {
        return;
      }

      // 清理 parser 引用
      this.activeParsers.delete(sessionId);

      // 推送 finished 事件让前端知道此轮次结束
      msgStore.pushFinished();

      // 持久化日志快照到数据库
      try {
        const snapshot = msgStore.getSnapshot();
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            status: SessionStatus.COMPLETED,
            logSnapshot: JSON.stringify(snapshot),
          },
        });
      } catch (error) {
        console.error(`[SessionService] Failed to persist log snapshot for session ${sessionId}:`, error);
      }
    });

    // 使用共享的 ProcessManager，使 Socket.IO Terminal handler 能找到 PTY
    const processManager = getProcessManager();
    processManager.track(sessionId, spawnResult.pty);
  }
}
