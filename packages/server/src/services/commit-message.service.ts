/**
 * CommitMessageService - 自动生成 commit message
 *
 * 在 Task 进入 IN_REVIEW 状态时，创建一个隐藏的 COMMIT_MSG session，
 * 利用当前 workspace 使用的 agent 来分析 diff 并生成简洁的 commit message。
 * 生成结果缓存到 workspace.commitMessage 字段。
 */

import { prisma } from '../utils/index.js';
import { AgentType, SessionStatus, SessionPurpose, WorkspaceStatus } from '../types/index.js';
import { execGit } from '../git/git-cli.js';
import { getSessionManager } from '../core/container.js';
import type { NormalizedConversation } from '../output/index.js';
import { sessionMsgStoreManager } from '../output/index.js';

/** diff 最大字符数，超出则截断并附加 stat 摘要 */
const MAX_DIFF_CHARS = 8000;

export class CommitMessageService {
  /**
   * 为指定 workspace 触发 commit message 生成。
   * 创建一个 purpose=COMMIT_MSG 的隐藏 session 并启动。
   */
  async triggerGeneration(workspaceId: string): Promise<void> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        task: { include: { project: true } },
        sessions: {
          where: { purpose: SessionPurpose.CHAT },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!workspace || workspace.status !== WorkspaceStatus.ACTIVE) return;
    if (!workspace.worktreePath) return;

    // 确定 agent 类型：使用最近一个正常 session 的 agentType
    const lastSession = workspace.sessions[0];
    if (!lastSession) return;

    const agentType = lastSession.agentType as AgentType;
    const variant = lastSession.variant ?? 'DEFAULT';

    // 检查是否已有正在运行的 COMMIT_MSG session
    const existing = await prisma.session.findFirst({
      where: {
        workspaceId,
        purpose: SessionPurpose.COMMIT_MSG,
        status: { in: [SessionStatus.PENDING, SessionStatus.RUNNING] },
      },
    });
    if (existing) return;

    // 清空旧的 commitMessage（可能是上一轮生成的）
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { commitMessage: null },
    });

    // 构造 prompt
    const prompt = await this.buildPrompt(workspace);
    if (!prompt) return;

    // 创建隐藏 session 并启动
    const sessionManager = getSessionManager();
    const session = await sessionManager.create(workspaceId, agentType, prompt, variant);

    // 标记为 COMMIT_MSG purpose
    await prisma.session.update({
      where: { id: session.id },
      data: { purpose: SessionPurpose.COMMIT_MSG },
    });

    try {
      await sessionManager.start(session.id);
      console.log(`[CommitMessageService] Started COMMIT_MSG session ${session.id} for workspace ${workspaceId}`);
    } catch (error) {
      console.warn(
        `[CommitMessageService] Failed to start COMMIT_MSG session for workspace ${workspaceId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * COMMIT_MSG session 完成后，从输出中提取 commit message 并缓存。
   */
  async extractAndCache(sessionId: string): Promise<void> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { workspace: true },
    });

    if (!session || session.purpose !== SessionPurpose.COMMIT_MSG) return;

    const commitMessage = this.extractCommitMessage(sessionId, session.logSnapshot);
    if (!commitMessage) {
      console.warn(`[CommitMessageService] No commit message extracted from session ${sessionId}`);
      return;
    }

    await prisma.workspace.update({
      where: { id: session.workspaceId },
      data: { commitMessage },
    });

    console.log(`[CommitMessageService] Cached commit message for workspace ${session.workspaceId}`);
  }

  /**
   * 从 session 输出中提取 commit message 文本。
   * 优先从内存 MsgStore 读取，fallback 到 logSnapshot。
   */
  private extractCommitMessage(sessionId: string, logSnapshot: string | null): string | null {
    // 优先从内存 MsgStore 读取
    const msgStore = sessionMsgStoreManager.get(sessionId);
    if (msgStore) {
      const snapshot = msgStore.getSnapshot();
      return this.extractFromSnapshot(snapshot);
    }

    // fallback: 从持久化的 logSnapshot 读取
    if (logSnapshot) {
      try {
        const snapshot = JSON.parse(logSnapshot) as NormalizedConversation;
        return this.extractFromSnapshot(snapshot);
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * 从 NormalizedConversation 中提取最后一个 assistant_message 的内容。
   */
  private extractFromSnapshot(snapshot: NormalizedConversation): string | null {
    // 从后往前找最后一个 assistant_message
    for (let i = snapshot.entries.length - 1; i >= 0; i--) {
      const entry = snapshot.entries[i];
      if (entry.entryType === 'assistant_message' && entry.content) {
        // 清理：去掉可能的 markdown 代码块包裹
        let msg = entry.content.trim();
        if (msg.startsWith('```') && msg.endsWith('```')) {
          msg = msg.slice(3, -3).trim();
          // 去掉可能的语言标识（如 ```text）
          const firstNewline = msg.indexOf('\n');
          if (firstNewline > 0 && firstNewline < 20) {
            msg = msg.slice(firstNewline + 1).trim();
          }
        }
        return msg || null;
      }
    }
    return null;
  }

  /**
   * 构造生成 commit message 的 prompt。
   */
  private async buildPrompt(workspace: {
    worktreePath: string;
    branchName: string;
    task: {
      title: string;
      description: string | null;
      project: { repoPath: string; mainBranch: string };
    };
  }): Promise<string | null> {
    const { worktreePath, branchName, task } = workspace;
    const { repoPath, mainBranch } = task.project;

    try {
      // 获取 commit log
      const commitLog = await execGit(repoPath, [
        'log', `${mainBranch}..${branchName}`, '--oneline', '--no-decorate',
      ]).catch(() => '');

      if (!commitLog.trim()) return null; // 没有提交，无需生成

      // 获取 diff
      let diff = await execGit(repoPath, [
        'diff', `${mainBranch}...${branchName}`,
      ]).catch(() => '');

      // diff 截断策略
      let diffTruncated = false;
      if (diff.length > MAX_DIFF_CHARS) {
        diffTruncated = true;
        diff = diff.slice(0, MAX_DIFF_CHARS);
      }

      // 如果 diff 被截断，附加 stat 摘要
      let diffStat = '';
      if (diffTruncated) {
        diffStat = await execGit(repoPath, [
          'diff', '--stat', `${mainBranch}...${branchName}`,
        ]).catch(() => '');
      }

      // 构造 prompt
      const parts: string[] = [
        'You are a Git commit message generator. Generate a concise commit message based on the following information.',
        '',
        'Requirements:',
        '- Use conventional commits format (feat/fix/refactor/docs/chore/style/test/perf/ci/build)',
        '- First line must not exceed 72 characters',
        '- If necessary, add a blank line followed by a detailed description',
        '- Output ONLY the commit message itself, no explanations, no markdown formatting, no code blocks',
        '',
        `Task: ${task.title}`,
      ];

      if (task.description) {
        parts.push(`Task description: ${task.description}`);
      }

      parts.push('', 'Commit history:', commitLog.trim());

      if (diffTruncated && diffStat) {
        parts.push('', 'Change summary (diff was truncated):', diffStat.trim());
      }

      parts.push('', 'Code changes:', diff);

      return parts.join('\n');
    } catch (error) {
      console.warn(
        `[CommitMessageService] Failed to build prompt for workspace:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }
}
