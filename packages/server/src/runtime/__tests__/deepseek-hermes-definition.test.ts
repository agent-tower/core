import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpAgentDefinition } from '../acp/agents/registry.js';
import type { AcpAgentProfile } from '../acp/agents/types.js';
import type { RuntimeOpenInput } from '../contracts.js';

function provider(config: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  return {
    id: 'deepseek-provider',
    name: 'DeepSeek',
    agentType: AgentType.DEEPSEEK_HERMES,
    runtimeType: RuntimeType.ACP,
    env,
    config,
    isDefault: false,
  };
}

function inheritedEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...process.env, ...overrides } as Record<string, string>;
}

function openInput(workingDir: string): RuntimeOpenInput {
  return {
    towerSessionId: 'session-1',
    agentType: AgentType.DEEPSEEK_HERMES,
    runtimeType: RuntimeType.ACP,
    variant: 'default',
    providerId: 'deepseek-provider',
    workingDir,
    env: { toObject: () => ({}), clone: () => undefined } as unknown as RuntimeOpenInput['env'],
  };
}

function selectOption(id: string, currentValue: string): acp.SessionConfigOption {
  return {
    id,
    name: id,
    type: 'select',
    currentValue,
    options: [],
  } as unknown as acp.SessionConfigOption;
}

describe('DeepSeek Harness ACP definition', () => {
  const originalDataDir = process.env.AGENT_TOWER_DATA_DIR;
  const originalDshPath = process.env.DSH_PATH;
  let dataDir: string;
  let workingDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'agent-tower-dsh-test-'));
    workingDir = await mkdtemp(path.join(tmpdir(), 'agent-tower-dsh-ws-'));
    process.env.AGENT_TOWER_DATA_DIR = dataDir;
    // Resolve the executable deterministically without requiring a real `dsh`.
    process.env.DSH_PATH = process.execPath;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.AGENT_TOWER_DATA_DIR;
    else process.env.AGENT_TOWER_DATA_DIR = originalDataDir;
    if (originalDshPath === undefined) delete process.env.DSH_PATH;
    else process.env.DSH_PATH = originalDshPath;
    await rm(dataDir, { recursive: true, force: true });
    await rm(workingDir, { recursive: true, force: true });
  });

  it('launches the published automation profile from a persistent harness home', async () => {
    const definition = getAcpAgentDefinition(AgentType.DEEPSEEK_HERMES);
    const profile = definition.projectProvider(
      provider({ model: 'deepseek-v4-pro' }, { DEEPSEEK_API_KEY: 'sk-test' }) as never,
      inheritedEnvironment(),
    );
    const launch = await definition.resolveLaunch(openInput(workingDir), profile);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(['--profile', 'acp']);
    expect(launch.cwd).toBe(workingDir);
    // The harness reads credentials from the launch environment.
    expect(launch.env.DEEPSEEK_API_KEY).toBe('sk-test');
    // Permission policy is a launch variable, not a config file.
    expect(launch.env.DSH_PERMISSION_MODE).toBe('workspace-write');

    const harnessHome = launch.env.DSH_HOME;
    expect(harnessHome).toBe(path.join(dataDir, 'deepseek-harness', 'deepseek-provider'));
    // The profile is pre-seeded so the first session skips the bootstrap.
    await expect(stat(path.join(harnessHome!, 'profiles', 'acp', 'package.json'))).resolves.toBeTruthy();
    // Durable harness state must never be scheduled for deletion.
    expect(launch.cleanup).toBeUndefined();
  });

  it('keeps the harness home stable across relaunches and per provider', async () => {
    const definition = getAcpAgentDefinition(AgentType.DEEPSEEK_HERMES);
    const profile = definition.projectProvider(provider({}, { DEEPSEEK_API_KEY: 'sk-test' }) as never, inheritedEnvironment());
    const first = await definition.resolveLaunch(openInput(workingDir), profile);
    const second = await definition.resolveLaunch(openInput(workingDir), profile);
    expect(second.env.DSH_HOME).toBe(first.env.DSH_HOME);

    const otherProvider = await definition.resolveLaunch(
      { ...openInput(workingDir), providerId: 'another-provider' },
      profile,
    );
    expect(otherProvider.env.DSH_HOME).not.toBe(first.env.DSH_HOME);
  });

  it('does not overwrite harness files a previous launch already wrote', async () => {
    const definition = getAcpAgentDefinition(AgentType.DEEPSEEK_HERMES);
    const profile = definition.projectProvider(provider({}, { DEEPSEEK_API_KEY: 'sk-test' }) as never, inheritedEnvironment());
    const launch = await definition.resolveLaunch(openInput(workingDir), profile);
    const patchPath = path.join(launch.env.DSH_HOME!, 'profiles', 'acp', 'cordis.patch.yml');
    await writeFile(patchPath, '- id: user-owned\n', 'utf-8');

    await definition.resolveLaunch(openInput(workingDir), profile);
    await expect(readFile(patchPath, 'utf-8')).resolves.toBe('- id: user-owned\n');
  });

  it('encodes the composite model tuple and selects reasoning effort separately', async () => {
    const definition = getAcpAgentDefinition(AgentType.DEEPSEEK_HERMES);
    const profile: AcpAgentProfile = definition.projectProvider(
      provider(
        { model: 'deepseek-v4-pro', effort: 'low' },
        { DEEPSEEK_API_KEY: 'sk-test' },
      ) as never,
      inheritedEnvironment(),
    );
    const request = vi.fn(async () => ({ configOptions: [] }));
    const context = { request } as unknown as acp.ClientContext;
    const response = {
      configOptions: [selectOption('model', ''), selectOption('reasoning_effort', 'high')],
    };

    await definition.configureSession?.(context, 'session-1', response, profile);

    expect(request).toHaveBeenCalledWith(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId: 'session-1',
        configId: 'model',
        // `dsh` rejects a bare model id: the option is a JSON [route, model] tuple.
        value: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']),
      },
    );
    expect(request).toHaveBeenCalledWith(
      acp.methods.agent.session.setConfigOption,
      { sessionId: 'session-1', configId: 'reasoning_effort', value: 'low' },
    );
  });

  it('maps permission modes onto the harness sandbox presets instead of an ACP mode', async () => {
    const definition = getAcpAgentDefinition(AgentType.DEEPSEEK_HERMES);
    const launchWith = async (permissionMode: string) =>
      definition.resolveLaunch(
        openInput(workingDir),
        definition.projectProvider(
          provider({ permissionMode }, { DEEPSEEK_API_KEY: 'sk-test' }) as never,
          inheritedEnvironment(),
        ),
      );

    // `dsh-base` binds sandbox scope and approval policy into one variable:
    // workspace-write confines to the workspace, danger-full-access does not.
    expect((await launchWith('ASK')).env.DSH_PERMISSION_MODE).toBe('workspace-write');
    expect((await launchWith('UNRESTRICTED')).env.DSH_PERMISSION_MODE).toBe('danger-full-access');

    // No ACP mode switch may be attempted: `dsh` advertises no mode selector.
    const request = vi.fn(async () => ({ configOptions: [] }));
    const context = { request } as unknown as acp.ClientContext;
    const profile = definition.projectProvider(
      provider({ permissionMode: 'UNRESTRICTED' }, { DEEPSEEK_API_KEY: 'sk-test' }) as never,
      inheritedEnvironment(),
    );
    await definition.configureSession?.(context, 'session-1', { configOptions: [] }, profile);
    expect(request).not.toHaveBeenCalled();
  });
});
