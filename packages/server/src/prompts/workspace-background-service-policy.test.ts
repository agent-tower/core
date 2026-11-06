import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceRuntimePrompt,
  withWorkspaceBackgroundServicePolicy,
} from './workspace-background-service-policy.js';

describe('workspace background service policy', () => {
  it('routes long-running commands to MCP without changing the user prompt', () => {
    const prompt = withWorkspaceBackgroundServicePolicy('Run the app');
    expect(prompt).toContain('start_workspace_service');
    expect(prompt).toContain('Do not start those commands in the agent terminal');
    expect(prompt).toContain('Run the app');
  });

  it('tells every agent about wake-ups but only Claude Code about its run lifetime', () => {
    const generic = withWorkspaceBackgroundServicePolicy('Run the app', { agentType: 'CODEX' });
    expect(generic).toContain('wait_for_workspace_service');
    expect(generic).toContain('schedule_wakeup');
    expect(generic).not.toContain('claude_code_run_lifetime');
    expect(withWorkspaceBackgroundServicePolicy('Run the app')).toBe(generic);
    const claude = buildWorkspaceRuntimePrompt({ context: 'WORKSPACE', purpose: 'CHAT', agentType: 'CLAUDE_CODE' }, 'Run the app');
    expect(claude).toContain('claude_code_run_lifetime');
    expect(claude).toContain('keep the current run alive');
    expect(buildWorkspaceRuntimePrompt({ context: 'WORKSPACE', purpose: 'CHAT', agentType: 'GEMINI_CLI' }, 'Run the app')).toBe(generic);
  });

  it('injects only workspace chat turns', () => {
    expect(buildWorkspaceRuntimePrompt({ context: 'WORKSPACE', purpose: 'CHAT' }, 'hello'))
      .toContain('start_workspace_service');
    expect(buildWorkspaceRuntimePrompt({ context: 'WORKSPACE', purpose: 'COMMIT_MSG' }, 'hello'))
      .toBe('hello');
    expect(buildWorkspaceRuntimePrompt({ context: 'CONVERSATION', purpose: 'CHAT', conversationId: 'c1' }, 'hello'))
      .toBe('hello');
  });
});
