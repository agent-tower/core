import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AgentType, SessionStatus } from '../../types/index.js';
import { EventBus } from '../../core/event-bus.js';
import type { BaseExecutor, ExecutorSpawnConfig } from '../../executors/index.js';
import { withWorkspaceBackgroundServicePolicy } from '../../prompts/workspace-background-service-policy.js';
import { appendAgentOutputIntentInstructions } from '../../prompts/agent-output-intents.js';
import { TeamLockService } from '../team-lock.service.js';
import {
  AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
} from '../../executors/execution-env.js';
import {
  AGENT_API_CREDENTIAL_ENV,
  validateAgentApiCredential,
} from '../../utils/agent-api-credential.js';

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
        AGENT_TOWER_INTERNAL_TOKEN: 'provider-token',
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
let getExecutorByProvider: typeof import('../../executors/index.js').getExecutorByProvider;
let getProviderById: typeof import('../../executors/index.js').getProviderById;
let CommandBuildError: typeof import('../../executors/command-builder.js').CommandBuildError;
let CodexExecutor: typeof import('../../executors/codex.executor.js').CodexExecutor;
let ClaudeCodeExecutor: typeof import('../../executors/claude-code.executor.js').ClaudeCodeExecutor;
let TeamSchedulerService: typeof import('../team-scheduler.service.js').TeamSchedulerService;

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
  process.env.AGENT_TOWER_INTERNAL_TOKEN = 'service-internal-token';
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
  expect(fullEnv).not.toHaveProperty('AGENT_TOWER_INTERNAL_TOKEN');
  expect(validateAgentApiCredential(
    fullEnv[AGENT_API_CREDENTIAL_ENV],
  )).toMatchObject({ sessionId: fullEnv.AGENT_TOWER_SESSION_ID });
}

function createPty() {
  let exited = false;
  let exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  const emitExit = (event: { exitCode: number; signal?: number }) => {
    if (exited) return;
    exited = true;
    for (const listener of [...exitListeners]) listener(event);
  };
  const kill = vi.fn(() => emitExit({ exitCode: 0 }));
  return {
    pid: 12345,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(listener);
      return {
        dispose: vi.fn(() => {
          exitListeners = exitListeners.filter((candidate) => candidate !== listener);
        }),
      };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill,
  };
}

function spawnResult(pid: number, pty = createPty()) {
  return {
    pid,
    processGroupId: String(pid),
    birthMarker: `test-birth:${pid}`,
    ownershipToken: `test-owner:${pid}`,
    pty,
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
    const executorsModule = await import('../../executors/index.js');
    const commandBuilderModule = await import('../../executors/command-builder.js');
    const codexModule = await import('../../executors/codex.executor.js');
    const claudeModule = await import('../../executors/claude-code.executor.js');
    const schedulerModule = await import('../team-scheduler.service.js');
    prisma = utilsModule.prisma;
    SessionManager = sessionManagerModule.SessionManager;
    getExecutorByProvider = executorsModule.getExecutorByProvider;
    getProviderById = executorsModule.getProviderById;
    CommandBuildError = commandBuilderModule.CommandBuildError;
    CodexExecutor = codexModule.CodexExecutor;
    ClaudeCodeExecutor = claudeModule.ClaudeCodeExecutor;
    TeamSchedulerService = schedulerModule.TeamSchedulerService;
  });

  beforeEach(async () => {
    seedServiceEnv();
    vi.clearAllMocks();
    spawnMock.mockImplementation(async () => spawnResult(12345));
    spawnFollowUpMock.mockImplementation(async () => spawnResult(12346));
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
    spawnMock.mockImplementationOnce(async (config: ExecutorSpawnConfig) => {
      expect(config.env.toObject().AGENT_TOWER_SESSION_ID).toBe(session.id);
      await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
        status: SessionStatus.RUNNING,
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 1,
        runtimeLaunchResolvedCount: 0,
      });
      return spawnResult(12345);
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
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      runtimeLaunchState: 'PROCESS_RECORDED',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 1,
      runtimeLaunchProcessCount: 1,
    });
    await manager.destroyAll();
  });

  it('revokes TeamRun dispatch before a direct Session stop waits for unresolved cleanup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { task, workspace } = await createWorkspace();
    const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        name: 'Direct stop member',
        aliases: '[]',
        providerId: 'codex-default',
        rolePrompt: 'Role',
        capabilities: '{}',
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'direct-stop-cleanup-pending',
        instruction: 'Run',
        status: 'STARTED',
      },
    });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'prompt',
        status: SessionStatus.RUNNING,
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 1,
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

    await manager.stop(session.id);

    await expect(prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'RUNNING',
      dispatchRevokedAt: expect.any(Date),
    });
    await expect(prisma.workRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.session.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
      runtimeLaunchState: 'QUARANTINED',
      runtimeLaunchResolvedCount: 0,
    });
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
    await manager.destroyAll();
  });

  it('injects only the workspace-bound session identity for a solo session', async () => {
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
    expect(spawnConfig.env.toObject()).toMatchObject({ AGENT_TOWER_SESSION_ID: session.id });
    expect(spawnConfig.env.toObject()).not.toHaveProperty('AGENT_TOWER_INVOCATION_ID');
    expect(spawnConfig.env.toObject()).not.toHaveProperty('AGENT_TOWER_TEAM_RUN_ID');
    expect(spawnConfig.env.toObject()).not.toHaveProperty('AGENT_TOWER_MEMBER_ID');
    const fullEnv = spawnConfig.env.getFullEnv();
    expectServiceEnvFiltered(fullEnv);
    expect(fullEnv).toMatchObject({ AGENT_TOWER_SESSION_ID: session.id });
    expect(fullEnv).not.toHaveProperty('AGENT_TOWER_INVOCATION_ID');
    expect(fullEnv).not.toHaveProperty('AGENT_TOWER_TEAM_RUN_ID');
    expect(fullEnv).not.toHaveProperty('AGENT_TOWER_MEMBER_ID');
    await manager.destroyAll();
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
    spawnFollowUpMock.mockImplementationOnce(async (config: ExecutorSpawnConfig) => {
      expect(config.env.toObject().AGENT_TOWER_SESSION_ID).toBe(nextSession.id);
      await expect(prisma.session.findUnique({ where: { id: nextSession.id } })).resolves.toMatchObject({
        status: SessionStatus.RUNNING,
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 1,
        runtimeLaunchResolvedCount: 0,
      });
      return spawnResult(12346);
    });

    const startTurnSpy = vi.spyOn((manager as any).runtimeCoordinator, 'startTurn');
    await manager.startFollowUp(nextSession.id, previousSession.id);

    expect(spawnFollowUpMock).toHaveBeenCalledTimes(1);
    expect(startTurnSpy).toHaveBeenCalledWith(expect.objectContaining({
      towerSessionId: nextSession.id,
      resumeExternalSessionId: 'agent-native-session-1',
      resumeMode: 'resume',
    }));
    expect(spawnFollowUpMock.mock.calls[0]![1]).toBe('agent-native-session-1');
    expect(spawnMock).not.toHaveBeenCalled();
    const spawnConfig = spawnFollowUpMock.mock.calls[0]![0] as ExecutorSpawnConfig;
    expect(spawnConfig.prompt).toBe(
      appendAgentOutputIntentInstructions(withWorkspaceBackgroundServicePolicy('next prompt')),
    );
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
      runtimeLaunchState: 'PROCESS_RECORDED',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 1,
      runtimeLaunchProcessCount: 1,
    });
    await manager.destroyAll();
  });

  it('quarantines a spawned process when its process row cannot be written during session start', async () => {
    const { task, workspace } = await createWorkspace();
    const pty = createPty();
    spawnMock.mockImplementationOnce(async () => {
      await prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date() },
      });
      return spawnResult(22345, pty);
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
      status: SessionStatus.RUNNING,
      runtimeLaunchState: 'QUARANTINED',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 0,
    });
  });

  it('normalizes a real CommandBuildError as a deterministic start error', async () => {
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
    spawnMock.mockRejectedValueOnce(new CommandBuildError("Executable 'codex' not found in PATH"));

    await expect(manager.start(session.id)).rejects.toMatchObject({
      code: 'AGENT_COMMAND_UNAVAILABLE',
      statusCode: 400,
    });
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.CANCELLED,
      runtimeLaunchState: 'SAFE_PRE_CHILD_FAILURE',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 1,
      runtimeLaunchProcessCount: 0,
    });
  });

  it('reports a missing executor as a deterministic start error', async () => {
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
    vi.mocked(getExecutorByProvider).mockReturnValueOnce(undefined);

    await expect(manager.start(session.id)).rejects.toMatchObject({
      code: 'EXECUTOR_NOT_FOUND',
      statusCode: 400,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports invalid static executor configuration as a deterministic start error', async () => {
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
    vi.mocked(getExecutorByProvider).mockImplementationOnce(() => {
      throw new Error('Unknown agent type: INVALID');
    });

    await expect(manager.start(session.id)).rejects.toMatchObject({
      code: 'EXECUTOR_CONFIGURATION_INVALID',
      statusCode: 400,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  async function expectInvalidExecutorSettingsToTerminate(
    agentType: AgentType,
    executor: BaseExecutor,
  ): Promise<void> {
    const { task, workspace } = await createWorkspace();
    const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
    const providerId = `invalid-settings-${agentType}`;
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        name: `${agentType} member`,
        aliases: '[]',
        providerId,
        rolePrompt: 'Role',
        capabilities: JSON.stringify({
          readRoom: true,
          postRoomMessage: true,
          mentionMembers: true,
          stopMemberWork: false,
          markReadyForReview: false,
          readFiles: true,
          writeFiles: true,
          runCommands: false,
          readDiff: true,
          mergeWorkspace: false,
        }),
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        queueManagementPolicy: 'own_only',
      },
    });
    const workRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: `invalid-settings-${agentType}`,
        instruction: 'Start with invalid provider settings',
        status: 'QUEUED',
      },
    });
    vi.mocked(getExecutorByProvider).mockReturnValueOnce(executor);
    vi.mocked(getProviderById).mockReturnValueOnce({
      id: providerId,
      name: `${agentType} invalid settings`,
      agentType,
      env: {},
      config: {},
      isDefault: false,
    });
    const scheduler = new TeamSchedulerService(new TeamLockService(), {
      workspaceService: { create: vi.fn(async () => workspace) },
      sessionManager: manager,
      getProviderById: vi.fn(() => ({
        id: providerId,
        name: `${agentType} invalid settings`,
        agentType,
        env: {},
        config: {},
        isDefault: false,
      })),
    });

    await expect(scheduler.startNextSessions(teamRun.id)).resolves.toEqual([]);

    await expect(prisma.workRequest.findUnique({ where: { id: workRequest.id } })).resolves.toMatchObject({
      status: 'FAILED',
      startAttemptCount: 1,
      lastStartError: expect.stringContaining('EXECUTOR_CONFIGURATION_INVALID'),
      nextStartRetryAt: null,
    });
    await expect(prisma.agentInvocation.findFirst({ where: { workRequestId: workRequest.id } })).resolves.toMatchObject({
      status: 'FAILED',
      sessionId: expect.any(String),
    });
  }

  it('terminates real invalid Codex TOML through SessionManager and scheduler', async () => {
    await expectInvalidExecutorSettingsToTerminate(
      AgentType.CODEX,
      new CodexExecutor({ settings: 'invalid = [' }),
    );
  });

  it('terminates real invalid Claude settings JSON through SessionManager and scheduler', async () => {
    await expectInvalidExecutorSettingsToTerminate(
      AgentType.CLAUDE_CODE,
      new ClaudeCodeExecutor({ settings: '{"env":' }),
    );
  });

  it('tracks an attached runtime process through its real PTY exit', async () => {
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
    const pty = createPty();
    spawnMock.mockResolvedValueOnce(spawnResult(52345, pty));
    await manager.start(session.id);

    await expect(prisma.executionProcess.findFirst({ where: { sessionId: session.id } })).resolves.toMatchObject({
      pid: 52345,
      exitCode: null,
    });

    for (const [listener] of pty.onExit.mock.calls) listener({ exitCode: 0 });

    await vi.waitFor(async () => {
      await expect(prisma.executionProcess.findFirst({ where: { sessionId: session.id } })).resolves.toMatchObject({
        pid: 52345,
        exitCode: 0,
      });
    });
  });

  it('rejects an initial start after direct stop has cancelled the Session', async () => {
    const { workspace } = await createWorkspace();
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'cancelled before spawn',
        status: SessionStatus.CANCELLED,
      },
    });

    await expect(manager.start(session.id)).rejects.toMatchObject({
      code: 'SESSION_NOT_ADMITTED',
    });
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.CANCELLED,
    });
  });

  it('rejects a cross-Tower resume start after direct stop cancelled the new Session', async () => {
    const { workspace } = await createWorkspace();
    const previousSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'previous prompt',
        status: SessionStatus.COMPLETED,
        externalSessionId: 'native-resume-session',
      },
    });
    const nextSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'cancelled resume',
        status: SessionStatus.CANCELLED,
      },
    });

    await expect(manager.startFollowUp(nextSession.id, previousSession.id)).rejects.toMatchObject({
      code: 'SESSION_NOT_ADMITTED',
    });
    expect(spawnFollowUpMock).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({ where: { id: nextSession.id } })).resolves.toMatchObject({
      status: SessionStatus.CANCELLED,
    });
  });

  it('does not spawn a real resume_last follow-up when pre-invocation direct stop wins', async () => {
    const { task, workspace } = await createWorkspace();
    const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        name: 'Resume member',
        aliases: '[]',
        providerId: 'codex-default',
        rolePrompt: 'Continue prior work',
        capabilities: JSON.stringify({
          readRoom: true,
          postRoomMessage: true,
          mentionMembers: true,
          stopMemberWork: false,
          markReadyForReview: false,
          readFiles: true,
          writeFiles: true,
          runCommands: false,
          readDiff: true,
          mergeWorkspace: false,
        }),
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: 'resume_last',
        queueManagementPolicy: 'own_only',
      },
    });
    const previousRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'previous-resume-request',
        instruction: 'Previous work',
        status: 'COMPLETED',
      },
    });
    const previousSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: member.providerId,
        prompt: 'previous prompt',
        status: SessionStatus.COMPLETED,
        externalSessionId: 'native-resume-context',
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: previousRequest.id,
        memberId: member.id,
        workspaceId: workspace.id,
        sessionId: previousSession.id,
        status: 'COMPLETED',
      },
    });
    const nextRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'next-resume-request',
        instruction: 'Continue with the native context',
        status: 'QUEUED',
      },
    });
    let resolveSessionCreated!: (session: { id: string }) => void;
    const sessionCreated = new Promise<{ id: string }>((resolve) => {
      resolveSessionCreated = resolve;
    });
    let allowCreateReturn!: () => void;
    const createReturn = new Promise<void>((resolve) => {
      allowCreateReturn = resolve;
    });
    const originalCreate = manager.create.bind(manager);
    vi.spyOn(manager, 'create').mockImplementationOnce(async (...args) => {
      const session = await originalCreate(...args);
      resolveSessionCreated(session);
      await createReturn;
      return session;
    });
    const scheduler = new TeamSchedulerService(new TeamLockService(), {
      workspaceService: { create: vi.fn(async () => workspace) },
      sessionManager: manager,
      getProviderById: vi.fn(() => ({
        id: member.providerId,
        name: 'Codex',
        agentType: AgentType.CODEX,
        env: {},
        config: {},
        isDefault: true,
      })),
    });

    const starting = scheduler.startNextSessions(teamRun.id);
    const createdSession = await sessionCreated;
    await scheduler.stopSession(createdSession.id);
    allowCreateReturn();
    await expect(starting).resolves.toEqual([]);

    expect(spawnFollowUpMock).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({ where: { id: createdSession.id } })).resolves.toMatchObject({
      status: SessionStatus.CANCELLED,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: nextRequest.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });

  it('quarantines a spawned follow-up when its process row cannot be written', async () => {
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
      return spawnResult(32345, pty);
    });

    await expect(manager.startFollowUp(nextSession.id, previousSession.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(spawnFollowUpMock).toHaveBeenCalledTimes(1);
    expect(pty.kill).toHaveBeenCalled();
    await expect(prisma.executionProcess.count({ where: { sessionId: nextSession.id } })).resolves.toBe(0);
    await expect(prisma.session.findUnique({ where: { id: nextSession.id } })).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
      runtimeLaunchState: 'QUARANTINED',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 0,
    });
  });

  it('quarantines a spawned reply process when its process row cannot be written', async () => {
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
      return spawnResult(42345, pty);
    });

    await expect(manager.sendMessage(session.id, 'continue')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(pty.kill).toHaveBeenCalled();
    await expect(prisma.executionProcess.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
      runtimeLaunchState: 'QUARANTINED',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 0,
    });
  });

  it('rejects a revoked TeamRun reminder before replacing the active turn', async () => {
    const { task, workspace } = await createWorkspace();
    const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        name: 'Reminder member',
        aliases: '[]',
        providerId: 'codex-default',
        rolePrompt: 'Role',
        capabilities: '{}',
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        queueManagementPolicy: 'own_only',
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'revoked-reminder-request',
        instruction: 'Run',
        status: 'STARTED',
      },
    });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'active prompt',
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
    const activePty = createPty();
    spawnMock.mockResolvedValueOnce({ pid: 43001, pty: activePty });
    await manager.start(session.id);
    await prisma.agentInvocation.update({
      where: { id: invocation.id },
      data: { dispatchRevokedAt: new Date() },
    });

    await expect(manager.sendMessage(
      session.id,
      'late reminder',
      undefined,
      invocation.id,
    )).rejects.toMatchObject({ code: 'SESSION_NOT_ADMITTED' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(activePty.kill).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
    });
    await manager.stop(session.id, { skipTeamRunReconcile: true });
  });

  it('rejects a direct follow-up bound to a terminal TeamRun invocation', async () => {
    const { task, workspace } = await createWorkspace();
    const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        name: 'Terminal member',
        aliases: '[]',
        providerId: 'codex-default',
        rolePrompt: 'Role',
        capabilities: '{}',
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'terminal-direct-send',
        instruction: 'Run',
        status: 'COMPLETED',
      },
    });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: AgentType.CODEX,
        providerId: 'codex-default',
        prompt: 'completed prompt',
        status: SessionStatus.COMPLETED,
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: member.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        status: 'COMPLETED',
      },
    });

    await expect(manager.sendMessage(
      session.id,
      'late direct follow-up',
      undefined,
      invocation.id,
    )).rejects.toMatchObject({ code: 'SESSION_NOT_ADMITTED' });

    expect(spawnMock).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.COMPLETED,
    });
  });

  it('does not record a TeamRun heartbeat from the local user_message patch created by sendMessage', async () => {
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
        triggerMessageId: 'message-heartbeat',
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
        status: SessionStatus.COMPLETED,
      },
    });
    const lastHeartbeatAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const nextRoomReplyReminderAt = new Date(Date.UTC(2026, 0, 1, 0, 5, 0));
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: member.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        status: 'RUNNING',
        lastHeartbeatAt,
        roomReplyReminderCount: 3,
        nextRoomReplyReminderAt,
      },
    });

    await manager.sendMessage(session.id, 'heartbeat nudge', undefined, invocation.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.lastHeartbeatAt?.toISOString()).toBe(lastHeartbeatAt.toISOString());
    expect(reloaded.roomReplyReminderCount).toBe(3);
    expect(reloaded.nextRoomReplyReminderAt?.toISOString()).toBe(nextRoomReplyReminderAt.toISOString());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await manager.destroyAll();
  });
});
