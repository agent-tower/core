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
import {
  AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
} from '../../executors/execution-env.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-session-manager-team-run-'));
const dbPath = path.join(testDir, 'test.db');
const envKeysToRestore = [
  ...AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  ...AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  ...AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
  'AGENT_TOWER_TEST_NORMAL_ENV',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of envKeysToRestore) {
  originalEnv[key] = process.env[key];
}

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
      env: {
        DATABASE_URL: 'file:/provider/database-url.db',
        AGENT_TOWER_DATABASE_URL: 'file:/provider/agent-tower.db',
        AGENT_TOWER_DATA_DIR: '/provider/agent-tower-data',
        AGENT_TOWER_WEB_DIR: '/provider/agent-tower-web',
        DATA_DIR: '/provider/data-dir',
        AGENT_TOWER_SESSION_ID: 'provider-session',
        AGENT_TOWER_INVOCATION_ID: 'provider-invocation',
        AGENT_TOWER_TEAM_RUN_ID: 'provider-team-run',
        AGENT_TOWER_MEMBER_ID: 'provider-member',
        AGENT_TOWER_URL: 'http://127.0.0.1:9999',
        AGENT_TOWER_PORT: '9999',
        PROVIDER_SAFE_ENV: 'provider-value',
      },
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

function seedServiceEnv(): void {
  process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
  process.env.DATABASE_URL = 'file:/prod/database-url.db';
  process.env.AGENT_TOWER_DATA_DIR = '/prod/agent-tower-data';
  process.env.AGENT_TOWER_WEB_DIR = '/prod/agent-tower-web';
  process.env.DATA_DIR = '/prod/data-dir';
  process.env.AGENT_TOWER_SESSION_ID = 'inherited-session';
  process.env.AGENT_TOWER_INVOCATION_ID = 'inherited-invocation';
  process.env.AGENT_TOWER_TEAM_RUN_ID = 'inherited-team-run';
  process.env.AGENT_TOWER_MEMBER_ID = 'inherited-member';
  process.env.AGENT_TOWER_URL = 'http://127.0.0.1:12580';
  process.env.AGENT_TOWER_PORT = '12580';
  process.env.AGENT_TOWER_TEST_NORMAL_ENV = 'keep-me';
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function expectServiceEnvFiltered(fullEnv: Record<string, string>): void {
  for (const key of AGENT_SUBPROCESS_BLOCKED_ENV_KEYS) {
    expect(fullEnv).not.toHaveProperty(key);
  }
  expect(fullEnv).toMatchObject({
    AGENT_TOWER_URL: 'http://127.0.0.1:12580',
    AGENT_TOWER_PORT: '12580',
    AGENT_TOWER_TEST_NORMAL_ENV: 'keep-me',
    PROVIDER_SAFE_ENV: 'provider-value',
  });
}

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
    seedServiceEnv();
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
    restoreEnv();
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
    const fullEnv = spawnConfig.env.getFullEnv();
    expectServiceEnvFiltered(fullEnv);
    expect(fullEnv).toMatchObject({
      AGENT_TOWER_SESSION_ID: session.id,
      AGENT_TOWER_INVOCATION_ID: invocation.id,
      AGENT_TOWER_TEAM_RUN_ID: teamRun.id,
      AGENT_TOWER_MEMBER_ID: member.id,
    });
    manager.destroyAll();
  });

  it('injects targeted test port env when the invocation has allocated ports', async () => {
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
        name: 'Tester',
        aliases: '["tester"]',
        providerId: 'codex-default',
        rolePrompt: 'Test role',
        capabilities: '{}',
        workspacePolicy: 'dedicated',
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
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'TEST',
        targetSourceWorkspaceId: workspace.id,
        targetHeadSha: 'a'.repeat(40),
        targetBranchName: workspace.branchName,
        triggerMessageId: 'message-target-test',
        instruction: 'Run tests',
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
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: member.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'TEST',
        targetSourceWorkspaceId: workspace.id,
        targetHeadSha: 'a'.repeat(40),
        targetBranchName: workspace.branchName,
        targetSyncStatus: 'SYNCED',
        targetPort: 21000,
        targetVitePort: 21001,
        targetE2EPort: 21002,
        status: 'RUNNING',
      },
    });

    await manager.start(session.id);

    const spawnConfig = spawnMock.mock.calls[0]![0] as ExecutorSpawnConfig;
    expect(spawnConfig.env.toObject()).toMatchObject({
      PORT: '21000',
      VITE_PORT: '21001',
      E2E_PORT: '21002',
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
    const fullEnv = spawnConfig.env.getFullEnv();
    expectServiceEnvFiltered(fullEnv);
    expect(fullEnv).not.toHaveProperty('AGENT_TOWER_SESSION_ID');
    expect(fullEnv).not.toHaveProperty('AGENT_TOWER_INVOCATION_ID');
    expect(fullEnv).not.toHaveProperty('AGENT_TOWER_TEAM_RUN_ID');
    expect(fullEnv).not.toHaveProperty('AGENT_TOWER_MEMBER_ID');
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
    const fullEnv = spawnConfig.env.getFullEnv();
    expectServiceEnvFiltered(fullEnv);
    expect(fullEnv).toMatchObject({
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

  it('kills a spawned process when the task is deleted during session start', async () => {
    const { task, workspace } = await createWorkspace();
    const pty = createPty();
    spawnMock.mockImplementationOnce(async () => {
      await prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date() },
      });
      return { pid: 22345, pty };
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

    await expect(manager.start(session.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(pty.kill).toHaveBeenCalled();
    await expect(prisma.executionProcess.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.CANCELLED,
    });
  });

  it('kills a spawned follow-up process when the task is deleted during follow-up start', async () => {
    const { task, workspace } = await createWorkspace();
    const previousSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'previous prompt',
        status: SessionStatus.COMPLETED,
        logSnapshot: JSON.stringify({ sessionId: 'agent-native-session-2', entries: [] }),
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
    const pty = createPty();
    spawnFollowUpMock.mockImplementationOnce(async () => {
      await prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date() },
      });
      return { pid: 32345, pty };
    });

    await expect(manager.startFollowUp(nextSession.id, previousSession.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(spawnFollowUpMock).toHaveBeenCalledTimes(1);
    expect(pty.kill).toHaveBeenCalled();
    await expect(prisma.executionProcess.count({ where: { sessionId: nextSession.id } })).resolves.toBe(0);
    await expect(prisma.session.findUnique({ where: { id: nextSession.id } })).resolves.toMatchObject({
      status: SessionStatus.CANCELLED,
    });
  });

  it('kills a spawned reply process when the task is deleted during sendMessage', async () => {
    const { task, workspace } = await createWorkspace();
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'prompt',
        status: SessionStatus.COMPLETED,
      },
    });
    const pty = createPty();
    spawnMock.mockImplementationOnce(async () => {
      await prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date() },
      });
      return { pid: 42345, pty };
    });

    await expect(manager.sendMessage(session.id, 'continue')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(pty.kill).toHaveBeenCalled();
    await expect(prisma.executionProcess.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.CANCELLED,
    });
  });
});
