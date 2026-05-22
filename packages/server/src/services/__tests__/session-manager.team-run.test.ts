import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AgentType, SessionStatus } from '../../types/index.js';
import { EventBus } from '../../core/event-bus.js';
import type { ExecutorSpawnConfig } from '../../executors/index.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-session-manager-team-run-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const { spawnMock, spawnFollowUpMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnFollowUpMock: vi.fn(),
}));

vi.mock('../../executors/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../executors/index.js')>();
  return {
    ...actual,
      getExecutor: vi.fn(() => ({
        agentType: 'CODEX',
        displayName: 'Mock Codex',
        getAvailabilityInfo: vi.fn(),
        getCapabilities: vi.fn(() => []),
        spawn: spawnMock,
        spawnFollowUp: spawnFollowUpMock,
      })),
      getExecutorByProvider: vi.fn(() => ({
        agentType: 'CODEX',
        displayName: 'Mock Codex',
        getAvailabilityInfo: vi.fn(),
        getCapabilities: vi.fn(() => []),
        spawn: spawnMock,
        spawnFollowUp: spawnFollowUpMock,
      })),
    getProviderById: vi.fn(() => ({
      id: 'codex-default',
      name: 'Codex',
      agentType: 'CODEX',
      env: {},
      config: {},
      isDefault: true,
    })),
  };
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let SessionManager: typeof import('../session-manager.js').SessionManager;

function createPty() {
  return {
    pid: 12345,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

async function createWorkspace() {
  const project = await prisma.project.create({
    data: {
      name: 'Session manager TeamRun project',
      repoPath: testDir,
    },
  });
  const task = await prisma.task.create({
    data: {
      title: 'Session manager TeamRun task',
      projectId: project.id,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      branchName: 'team-shared',
      worktreePath: testDir,
      status: 'ACTIVE',
    },
  });

  return { project, task, workspace };
}

describe('SessionManager TeamRun env injection', () => {
  let manager: InstanceType<typeof SessionManager>;

  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      }
    );

    const utilsModule = await import('../../utils/index.js');
    const sessionManagerModule = await import('../session-manager.js');
    prisma = utilsModule.prisma;
    SessionManager = sessionManagerModule.SessionManager;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    spawnMock.mockImplementation(async () => ({
      pid: 12345,
      pty: createPty(),
    }));
    spawnFollowUpMock.mockImplementation(async () => ({
      pid: 12346,
      pty: createPty(),
    }));
    manager = new SessionManager(new EventBus());
    await prisma.executionProcess.deleteMany();
    await prisma.agentInvocation.deleteMany();
    await prisma.workRequest.deleteMany();
    await prisma.roomMessage.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
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

  it('injects TeamRun identity env when the session is linked to an AgentInvocation', async () => {
    const { task, workspace } = await createWorkspace();
    const teamRun = await prisma.teamRun.create({
      data: {
        taskId: task.id,
        mode: 'AUTO',
      },
    });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        presetId: null,
        name: 'Member 1',
        aliases: '["member-1"]',
        providerId: 'codex-default',
        rolePrompt: 'Role 1',
        capabilities: '{}',
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
        avatar: null,
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'message-1',
        instruction: 'Do the work',
        status: 'STARTED',
      },
    });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'prompt',
        status: SessionStatus.PENDING,
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: member.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        status: 'RUNNING',
      },
    });

    await manager.start(session.id);

    const spawnConfig = spawnMock.mock.calls[0]![0] as ExecutorSpawnConfig;
    expect(spawnConfig.env.toObject()).toMatchObject({
      AGENT_TOWER_SESSION_ID: session.id,
      AGENT_TOWER_INVOCATION_ID: invocation.id,
      AGENT_TOWER_TEAM_RUN_ID: teamRun.id,
      AGENT_TOWER_MEMBER_ID: member.id,
    });
    manager.destroyAll();
  });

  it('does not inject TeamRun env for a solo session', async () => {
    const { workspace } = await createWorkspace();
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'prompt',
        status: SessionStatus.PENDING,
      },
    });

    await manager.start(session.id);

    const spawnConfig = spawnMock.mock.calls[0]![0] as ExecutorSpawnConfig;
    expect(spawnConfig.env.toObject()).not.toHaveProperty('AGENT_TOWER_SESSION_ID');
    expect(spawnConfig.env.toObject()).not.toHaveProperty('AGENT_TOWER_INVOCATION_ID');
    expect(spawnConfig.env.toObject()).not.toHaveProperty('AGENT_TOWER_TEAM_RUN_ID');
    expect(spawnConfig.env.toObject()).not.toHaveProperty('AGENT_TOWER_MEMBER_ID');
    manager.destroyAll();
  });

  it('starts a new Tower session as an executor follow-up while injecting the new invocation env', async () => {
    const { task, workspace } = await createWorkspace();
    const teamRun = await prisma.teamRun.create({
      data: {
        taskId: task.id,
        mode: 'AUTO',
      },
    });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        presetId: null,
        name: 'Member 1',
        aliases: '["member-1"]',
        providerId: 'codex-default',
        rolePrompt: 'Role 1',
        capabilities: '{}',
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
        avatar: null,
      },
    });
    const previousSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'previous prompt',
        status: SessionStatus.COMPLETED,
        logSnapshot: JSON.stringify({ sessionId: 'agent-native-session-1', entries: [] }),
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'message-2',
        instruction: 'Continue the work',
        status: 'STARTED',
      },
    });
    const nextSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'next prompt',
        status: SessionStatus.PENDING,
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: member.id,
        workspaceId: workspace.id,
        sessionId: nextSession.id,
        status: 'RUNNING',
      },
    });

    await manager.startFollowUp(nextSession.id, previousSession.id);

    expect(spawnFollowUpMock).toHaveBeenCalledTimes(1);
    expect(spawnFollowUpMock.mock.calls[0]![1]).toBe('agent-native-session-1');
    expect(spawnMock).not.toHaveBeenCalled();
    const spawnConfig = spawnFollowUpMock.mock.calls[0]![0] as ExecutorSpawnConfig;
    expect(spawnConfig.prompt).toBe('next prompt');
    expect(spawnConfig.env.toObject()).toMatchObject({
      AGENT_TOWER_SESSION_ID: nextSession.id,
      AGENT_TOWER_INVOCATION_ID: invocation.id,
      AGENT_TOWER_TEAM_RUN_ID: teamRun.id,
      AGENT_TOWER_MEMBER_ID: member.id,
    });
    await expect(prisma.session.findUnique({ where: { id: nextSession.id } })).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
    });
    manager.destroyAll();
  });
});
