import { withTaskHandoff } from './task-handoff.js';

const WORKSPACE_BACKGROUND_SERVICE_POLICY = `<workspace_background_service_policy>
For commands expected to keep running after this agent turn ends, including development servers, file watchers, and background workers, use the Agent Tower workspace service MCP tools. Do not start those commands in the agent terminal, and do not use nohup, disown, shell backgrounding, or a detached child process as a substitute.

Use start_workspace_service to start a long-running command, list_workspace_services to inspect state, get_workspace_service_logs for bounded log polling, send_workspace_service_input for PTY input, and control_workspace_service to stop or restart it. Continue using the normal terminal for builds, tests, and other commands that are expected to finish. If the workspace service tools are unavailable, report that limitation instead of starting the long-running command in the normal terminal.
</workspace_background_service_policy>`;

export function withWorkspaceBackgroundServicePolicy(prompt: string): string {
  return `${WORKSPACE_BACKGROUND_SERVICE_POLICY}\n\n${prompt}`;
}

export function buildWorkspaceRuntimePrompt(
  session: {
    context?: string | null;
    purpose?: string | null;
    conversationId?: string | null;
    workspace?: { task: { id: string; handoff?: string | null } } | null;
  },
  prompt: string,
): string {
  return session.context === 'WORKSPACE'
    && session.purpose === 'CHAT'
    && !session.conversationId
    ? withWorkspaceBackgroundServicePolicy(session.workspace ? withTaskHandoff(prompt, session.workspace.task) : prompt)
    : prompt;
}

export { WORKSPACE_BACKGROUND_SERVICE_POLICY };
