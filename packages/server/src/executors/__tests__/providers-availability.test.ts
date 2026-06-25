import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentType } from '../../types/index.js';
import { getAllProvidersAvailability } from '../index.js';
import { reloadProviders } from '../providers.js';

const whichMock = vi.hoisted(() => vi.fn<(command: string) => Promise<string | null>>());

vi.mock('../../utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/index.js')>();
  return {
    ...actual,
    which: whichMock,
  };
});

const originalDataDir = process.env.AGENT_TOWER_DATA_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

let tempDataDir = '';
let tempHome = '';

function writeUserProviders(providers: unknown[]) {
  fs.writeFileSync(
    path.join(tempDataDir, 'providers.json'),
    JSON.stringify({ providers }, null, 2),
    'utf-8',
  );
}

describe('provider availability', () => {
  beforeEach(() => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-providers-availability-'));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-provider-home-'));
    process.env.AGENT_TOWER_DATA_DIR = tempDataDir;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    whichMock.mockReset();
    reloadProviders();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.AGENT_TOWER_DATA_DIR;
    else process.env.AGENT_TOWER_DATA_DIR = originalDataDir;

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;

    if (tempDataDir) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }

    reloadProviders();
  });

  it('reuses the same Claude Code availability across providers of the same agent type', async () => {
    writeUserProviders([
      {
        id: 'claude-code-default',
        name: 'Claude Code Default',
        agentType: AgentType.CLAUDE_CODE,
        env: {},
        config: { dangerouslySkipPermissions: true },
        isDefault: true,
      },
      {
        id: 'claude-code-custom',
        name: 'Claude Code Custom',
        agentType: AgentType.CLAUDE_CODE,
        env: {},
        config: {
          dangerouslySkipPermissions: true,
          cmd: { baseCommandOverride: 'custom-claude --proxy' },
        },
        isDefault: false,
      },
    ]);
    reloadProviders();

    whichMock.mockResolvedValue(null);

    const results = await getAllProvidersAvailability();
    const byId = new Map(results.map(item => [item.provider.id, item.availability]));
    const unavailable = {
      type: 'NOT_FOUND',
      error: 'Claude Code CLI executable not found in PATH',
    };

    expect(byId.get('claude-code-default')).toEqual(unavailable);
    expect(byId.get('claude-code-custom')).toEqual(unavailable);
    expect(whichMock.mock.calls.filter(([command]) => command === 'claude')).toHaveLength(1);
    expect(whichMock).toHaveBeenCalledWith('claude');
    expect(whichMock).not.toHaveBeenCalledWith('custom-claude');
  });
});
