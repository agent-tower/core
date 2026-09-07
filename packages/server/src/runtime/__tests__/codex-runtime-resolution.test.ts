import path from 'node:path';
import { AgentType, RuntimeType, type Provider } from '@agent-tower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { which } from '../../utils/index.js';
import { codexAcpAgentDefinition } from '../acp/agents/codex.js';
import { resolveBundledCodexEntrypoint } from '../acp/agents/executable-resolution.js';

vi.mock('../../utils/index.js', () => ({ which: vi.fn() }));
vi.mock('../acp/agents/executable-resolution.js', () => ({
  resolveBundledCodexEntrypoint: vi.fn(),
}));

const systemDirectory = path.join(path.parse(process.cwd()).root, 'system tools', 'bin');
const systemCodex = path.join(systemDirectory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
const bundledCodex = path.join(process.cwd(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

function setup(environment: Record<string, string> = {}) {
  const provider: Provider = {
    id: 'codex-system-first',
    name: 'Codex ACP',
    agentType: AgentType.CODEX,
    runtimeType: RuntimeType.ACP,
    env: { PATH: systemDirectory, ...environment },
    config: {},
    isDefault: false,
  };
  const profile = codexAcpAgentDefinition.projectProvider(provider, provider.env);
  const input = {
    towerSessionId: 'codex-system-first',
    agentType: AgentType.CODEX,
    runtimeType: RuntimeType.ACP,
    variant: 'DEFAULT',
    workingDir: process.cwd(),
    env: ExecutionEnv.default(process.cwd()),
  };
  return { provider, profile, input };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(which).mockResolvedValue(null);
  vi.mocked(resolveBundledCodexEntrypoint).mockReturnValue(bundledCodex);
});

describe('Codex ACP runtime resolution', () => {
  it('automatically prefers system Codex without requiring configuration', async () => {
    vi.mocked(which).mockResolvedValue(systemCodex);
    const { provider, profile, input } = setup();

    const launch = await codexAcpAgentDefinition.resolveLaunch(input, profile);

    expect(launch.command).toBe(process.execPath);
    expect(launch.env.CODEX_PATH).toBe(systemCodex);
    expect(launch.env.DISABLE_MCP_CONFIG_FILTERING).toBe('true');
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(await codexAcpAgentDefinition.checkAvailability(provider)).toEqual({ type: 'INSTALLATION_FOUND' });
    expect(which).toHaveBeenCalledWith('codex', { env: expect.objectContaining({ PATH: systemDirectory }) });
    expect(resolveBundledCodexEntrypoint).not.toHaveBeenCalled();
    expect(profile.environment).not.toHaveProperty('CODEX_PATH');
  });

  it('uses bundled Codex when no system installation is found', async () => {
    const { provider, profile, input } = setup();

    const launch = await codexAcpAgentDefinition.resolveLaunch(input, profile);

    expect(launch.env).not.toHaveProperty('CODEX_PATH');
    expect(resolveBundledCodexEntrypoint).toHaveBeenCalledOnce();
    expect(await codexAcpAgentDefinition.checkAvailability(provider)).toEqual({ type: 'INSTALLATION_FOUND' });
  });

  it.each([systemCodex, null])('replaces inherited CODEX_PATH with the automatically selected runtime: %s', async (detectedCodex) => {
    vi.mocked(which).mockResolvedValue(detectedCodex);
    const { profile, input } = setup({ CODEX_PATH: process.execPath });

    const launch = await codexAcpAgentDefinition.resolveLaunch(input, profile);

    expect(launch.env.CODEX_PATH).toBe(detectedCodex ?? undefined);
    expect(profile.environment.CODEX_PATH).toBe(process.execPath);
  });

  it('still launches system Codex when the bundled runtime is unavailable', async () => {
    vi.mocked(which).mockResolvedValue(systemCodex);
    vi.mocked(resolveBundledCodexEntrypoint).mockReturnValue(undefined);
    const { provider, profile, input } = setup();

    const launch = await codexAcpAgentDefinition.resolveLaunch(input, profile);

    expect(launch.env.CODEX_PATH).toBe(systemCodex);
    expect(await codexAcpAgentDefinition.checkAvailability(provider)).toEqual({ type: 'INSTALLATION_FOUND' });
    expect(resolveBundledCodexEntrypoint).not.toHaveBeenCalled();
  });

  it('fails consistently when neither runtime is available', async () => {
    vi.mocked(resolveBundledCodexEntrypoint).mockReturnValue(undefined);
    const { provider, profile, input } = setup();

    await expect(codexAcpAgentDefinition.resolveLaunch(input, profile)).rejects.toMatchObject({
      code: 'missing_codex',
      stage: 'dependency_check',
    });
    expect(await codexAcpAgentDefinition.checkAvailability(provider)).toMatchObject({ type: 'NOT_FOUND' });
  });

  it.each(['PATH', 'Path'])('excludes project package bins and relative paths from %s lookup without changing the agent environment', async (pathKey) => {
    const environment = {
      [pathKey]: [
        path.join(process.cwd(), 'node_modules', '.bin'),
        path.join(process.cwd(), 'node_modules', '.pnpm', 'node_modules', '.bin'),
        '.',
        '',
        'relative-bin',
        systemDirectory,
      ].join(path.delimiter),
    };
    const { profile, input } = setup();
    profile.environment = environment;
    vi.mocked(which).mockResolvedValue(systemCodex);

    const launch = await codexAcpAgentDefinition.resolveLaunch(input, profile);

    expect(which).toHaveBeenCalledWith('codex', { env: { [pathKey]: systemDirectory } });
    expect(launch.env[pathKey]).toBe(environment[pathKey]);
    expect(profile.environment).toEqual(environment);
  });
});
