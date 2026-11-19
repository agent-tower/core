import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/event-bus.js';
import { notifyMainDirectoryGitMetadataChanged, notifyWorkspaceGitMetadataChanged, notifyWorkspaceGitOperation } from './git-operation-events.js';
import { WorkspaceGitSignals, type WorkspaceGitSignalRegistry } from './workspace-git-signals.js';

vi.mock('../utils/index.js', () => ({ prisma: {} }));

describe('WorkspaceGitSignals', () => {
  let bridge: WorkspaceGitSignals;
  let bus: EventBus;
  let subscribed: boolean;
  let registry: WorkspaceGitSignalRegistry;
  let resolveSessionWorkspace: ReturnType<typeof vi.fn<(sessionId: string) => Promise<string | null>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    subscribed = true;
    bus = new EventBus();
    registry = {
      hasSubscribers: () => subscribed,
      invalidateWorkspace: vi.fn(), invalidatePath: vi.fn(), refreshPath: vi.fn(),
    };
    resolveSessionWorkspace = vi.fn(async () => 'workspace');
    bridge = new WorkspaceGitSignals(bus, registry, { resolveSessionWorkspace });
  });

  afterEach(() => { bridge.destroy(); vi.useRealTimers(); });

  const tool = (status: string) => ({ op: 'replace', path: '/entries/4', value: { id: 'tool-1', entryType: 'tool_use', metadata: { status } } });

  it('looks up a session once and only signals completed tool transitions or lifecycle events', async () => {
    bus.emit('session:patch', { sessionId: 'session', seq: 1, patch: [tool('in_progress')] });
    bus.emit('session:patch', { sessionId: 'session', seq: 2, patch: [{ op: 'replace', path: '/entries/4/content', value: 'streamed text' }] });
    expect(resolveSessionWorkspace).not.toHaveBeenCalled();
    bus.emit('session:patch', { sessionId: 'session', seq: 3, patch: [{ op: 'replace', path: '/entries/4/metadata/status', value: 'success' }] });
    await Promise.resolve();
    expect(registry.invalidateWorkspace).toHaveBeenCalledTimes(1);
    bus.emit('session:patch', { sessionId: 'session', seq: 4, patch: [tool('success')] });
    await Promise.resolve();
    expect(registry.invalidateWorkspace).toHaveBeenCalledTimes(1);
    bus.emit('session:turn-completed', { sessionId: 'session' });
    bus.emit('session:completed', { sessionId: 'session', status: 'COMPLETED' });
    bus.emit('session:exit', { sessionId: 'session' });
    await Promise.resolve();
    expect(resolveSessionWorkspace).toHaveBeenCalledTimes(1);
    expect(registry.invalidateWorkspace).toHaveBeenCalledTimes(4);
    expect(registry.invalidateWorkspace).toHaveBeenLastCalledWith('workspace', 'agent');
  });

  it('requires terminal input and quiet, and keeps the input association through gaps in a long command', async () => {
    bus.emit('terminal:stdout', { terminalId: 'terminal', data: 'startup' });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(registry.invalidatePath).not.toHaveBeenCalled();
    bus.emit('terminal:input', { terminalId: 'terminal', cwd: '/worktree/child' });
    bus.emit('terminal:stdout', { terminalId: 'terminal', data: 'first output' });
    await vi.advanceTimersByTimeAsync(900);
    bus.emit('terminal:stdout', { terminalId: 'terminal', data: 'last output' });
    await vi.advanceTimersByTimeAsync(999);
    expect(registry.invalidatePath).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.invalidatePath).toHaveBeenCalledExactlyOnceWith('/worktree/child', 'terminal');
    bus.emit('terminal:stdout', { terminalId: 'terminal', data: 'delayed command output' });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(registry.invalidatePath).toHaveBeenCalledTimes(2);
  });

  it('keeps terminal input before the first subscription for delayed output, until exit', async () => {
    subscribed = false;
    bus.emit('terminal:input', { terminalId: 'terminal', cwd: '/worktree' });
    expect(vi.getTimerCount()).toBe(0);
    expect(resolveSessionWorkspace).not.toHaveBeenCalled();
    subscribed = true;
    bus.emit('terminal:stdout', { terminalId: 'terminal', data: 'delayed output' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.invalidatePath).toHaveBeenCalledExactlyOnceWith('/worktree', 'terminal');
    bus.emit('terminal:exit', { terminalId: 'terminal' });
    bus.emit('terminal:stdout', { terminalId: 'terminal', data: 'output after exit' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.invalidatePath).toHaveBeenCalledTimes(1);
  });

  it('debounces service output and replaces its pending signal with exit', async () => {
    const event = { serviceId: 'service', workspaceId: 'workspace', runtimeInstanceId: 'runtime' };
    bus.emit('workspace-service:output', event);
    await vi.advanceTimersByTimeAsync(900);
    bus.emit('workspace-service:output', event);
    await vi.advanceTimersByTimeAsync(999);
    expect(registry.invalidateWorkspace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.invalidateWorkspace).toHaveBeenCalledExactlyOnceWith('workspace', 'service');
    bus.emit('workspace-service:output', event);
    bus.emit('workspace-service:exit', event);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(registry.invalidateWorkspace).toHaveBeenCalledTimes(2);
  });

  it('forwards operations once per distinct worktree and refreshes recreated paths', () => {
    notifyWorkspaceGitOperation(['/worktree', '/worktree', '/target']);
    expect(vi.mocked(registry.invalidatePath).mock.calls).toEqual([['/worktree', 'operation'], ['/target', 'operation']]);
    notifyWorkspaceGitOperation(['/worktree'], true);
    expect(registry.refreshPath).toHaveBeenCalledExactlyOnceWith('/worktree', true);
  });

  it('reloads shared-directory metadata without recreating watches and ignores worktree-only metadata', () => {
    notifyMainDirectoryGitMetadataChanged({ workspaceKind: 'WORKTREE', workingDir: '/worktree' });
    expect(registry.refreshPath).not.toHaveBeenCalled();
    notifyMainDirectoryGitMetadataChanged({ workspaceKind: 'MAIN_DIRECTORY', workingDir: '/repo', worktreePath: '' });
    expect(registry.refreshPath).toHaveBeenCalledExactlyOnceWith('/repo', false);
    notifyWorkspaceGitMetadataChanged(['/repo', '/repo', '']);
    expect(registry.refreshPath).toHaveBeenCalledTimes(2);
    expect(registry.invalidatePath).not.toHaveBeenCalled();
    subscribed = false;
    notifyMainDirectoryGitMetadataChanged({ workspaceKind: 'MAIN_DIRECTORY', workingDir: '/repo' });
    expect(registry.refreshPath).toHaveBeenCalledTimes(3);
    expect(resolveSessionWorkspace).not.toHaveBeenCalled();
  });

  it('does no lookup, parsing or scheduling without subscribers and releases listeners and timers', async () => {
    subscribed = false;
    bus.emit('session:patch', { sessionId: 'session', seq: 1, patch: [tool('success')] });
    bus.emit('session:exit', { sessionId: 'session' });
    bus.emit('terminal:input', { terminalId: 'terminal', cwd: '/worktree' });
    bus.emit('terminal:stdout', { terminalId: 'terminal', data: 'output' });
    bus.emit('workspace-service:output', { serviceId: 'service', workspaceId: 'workspace', runtimeInstanceId: 'runtime' });
    notifyWorkspaceGitOperation(['/worktree']);
    expect(resolveSessionWorkspace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(registry.invalidatePath).not.toHaveBeenCalled();
    subscribed = true;
    bus.emit('workspace-service:output', { serviceId: 'service', workspaceId: 'workspace', runtimeInstanceId: 'runtime' });
    expect(vi.getTimerCount()).toBe(1);
    bridge.destroy();
    expect(vi.getTimerCount()).toBe(0);
    notifyWorkspaceGitOperation(['/worktree']);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(registry.invalidateWorkspace).not.toHaveBeenCalled();
    expect(registry.invalidatePath).not.toHaveBeenCalled();
  });
});
