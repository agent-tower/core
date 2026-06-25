import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeExecutor } from '../claude-code.executor.js';

const whichMock = vi.hoisted(() => vi.fn<(command: string) => Promise<string | null>>());

vi.mock('../../utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/index.js')>();
  return {
    ...actual,
    which: whichMock,
  };
});

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

function useTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-claude-home-'));
  tempHomes.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function restoreHome(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
}

describe('ClaudeCodeExecutor availability', () => {
  afterEach(() => {
    restoreHome();
    whichMock.mockReset();
    for (const home of tempHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns NOT_FOUND when login config exists but claude is not on PATH', async () => {
    const home = useTempHome();
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    whichMock.mockResolvedValue(null);

    const availability = await new ClaudeCodeExecutor().getAvailabilityInfo();

    expect(availability).toEqual({
      type: 'NOT_FOUND',
      error: 'Claude Code CLI executable not found in PATH',
    });
    expect(whichMock).toHaveBeenCalledWith('claude');
  });

  it('returns LOGIN_DETECTED only when claude resolves', async () => {
    const home = useTempHome();
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    whichMock.mockResolvedValue('/usr/local/bin/claude');

    const availability = await new ClaudeCodeExecutor().getAvailabilityInfo();

    expect(availability.type).toBe('LOGIN_DETECTED');
    expect(availability).toHaveProperty('lastAuthTimestamp');
  });

  it('always checks the default claude executable for availability even when command override exists', async () => {
    useTempHome();
    whichMock.mockImplementation(async (command) => (
      command === 'claude' ? '/usr/local/bin/claude' : null
    ));

    const availability = await new ClaudeCodeExecutor({
      cmd: { baseCommandOverride: 'custom-claude --shim' },
    }).getAvailabilityInfo();

    expect(availability).toEqual({ type: 'INSTALLATION_FOUND' });
    expect(whichMock).toHaveBeenCalledTimes(1);
    expect(whichMock).toHaveBeenCalledWith('claude');
  });
});
