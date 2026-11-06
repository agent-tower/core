import { withTaskHandoff } from './task-handoff.js';

const WORKSPACE_BACKGROUND_SERVICE_POLICY = `<workspace_background_service_policy>
For commands expected to keep running after this agent turn ends, including development servers, file watchers, and background workers, use the Agent Tower workspace service MCP tools. Do not start those commands in the agent terminal, and do not use nohup, disown, shell backgrounding, or a detached child process as a substitute.

Use start_workspace_service to start a long-running command, list_workspace_services to inspect state, get_workspace_service_logs for bounded log polling, send_workspace_service_input for PTY input, and control_workspace_service to stop or restart it. Continue using the normal terminal for builds, tests, and other commands that are expected to finish. If the workspace service tools are unavailable, report that limitation instead of starting the long-running command in the normal terminal.

Waiting for long work: do not poll a service with sleep loops inside your turn. Start it with wake_on_exit, or call wait_for_workspace_service, then finish your turn; Agent Tower re-invokes you with a system notification when the service exits. Use schedule_wakeup to be re-invoked after a delay. These wake-ups survive the end of your turn.
</workspace_background_service_policy>`;

/** Only Claude Code print mode keeps a run alive for its own background work; other agents end at their result. */
const CLAUDE_CODE_RUN_LIFETIME_NOTE = `<claude_code_run_lifetime>
Background commands and subagents you start keep the current run alive until they finish, and their outcome starts another turn in the same run. Agent-native scheduled wakeups do not survive the end of the run; use schedule_wakeup instead.
</claude_code_run_lifetime>`;

export interface WorkspaceRuntimePromptOptions {
  agentType?: string | null;
}

export function withWorkspaceBackgroundServicePolicy(prompt: string, options: WorkspaceRuntimePromptOptions = {}): string {
  const notes = options.agentType === 'CLAUDE_CODE'
    ? `${WORKSPACE_BACKGROUND_SERVICE_POLICY}\n\n${CLAUDE_CODE_RUN_LIFETIME_NOTE}`
    : WORKSPACE_BACKGROUND_SERVICE_POLICY;
  return `${notes}\n\n${prompt}`;
}

export function buildWorkspaceRuntimePrompt(
  session: {
    context?: string | null;
    purpose?: string | null;
    conversationId?: string | null;
    agentType?: string | null;
    workspace?: { task: { id: string; handoff?: string | null } } | null;
  },
  prompt: string,
): string {
  return session.context === 'WORKSPACE'
    && session.purpose === 'CHAT'
    && !session.conversationId
    ? withWorkspaceBackgroundServicePolicy(
      session.workspace ? withTaskHandoff(prompt, session.workspace.task) : prompt,
      { agentType: session.agentType },
    )
    : prompt;
}

export { WORKSPACE_BACKGROUND_SERVICE_POLICY };
