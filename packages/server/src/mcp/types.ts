/**
 * MCP tool 输入参数的 Zod schema 定义
 */
import { z } from 'zod';

// ── Projects ──

export const ListProjectsInput = z.object({});

// ── Tasks ──

export const ListTasksInput = z.object({
  project_id: z.string().describe('The ID of the project to list tasks from'),
  status: z.enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED']).optional()
    .describe("Optional status filter: 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'"),
  limit: z.number().int().min(1).max(100).optional()
    .describe('Maximum number of tasks to return (default: 50)'),
});

export const CreateTaskInput = z.object({
  project_id: z.string().describe('The ID of the project to create the task in'),
  title: z.string().min(1).describe('The title of the task'),
  description: z.string().optional().describe('Optional description of the task'),
  priority: z.number().int().min(-1).max(2).optional()
    .describe('Task priority: -1 low, 0 normal, 1 high, 2 urgent'),
});

export const GetTaskInput = z.object({
  task_id: z.string().describe('The ID of the task to retrieve'),
});

export const UpdateTaskInput = z.object({
  task_id: z.string().describe('The ID of the task to update'),
  title: z.string().min(1).optional().describe('New title for the task'),
  description: z.string().optional().describe('New description for the task'),
  priority: z.number().int().min(-1).max(2).optional()
    .describe('Task priority: -1 low, 0 normal, 1 high, 2 urgent'),
  status: z.enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED']).optional()
    .describe("New status: 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'"),
});

export const DeleteTaskInput = z.object({
  task_id: z.string().describe('The ID of the task to delete'),
});

// ── Providers ──

export const ListProvidersInput = z.object({});

// ── Workspaces ──

export const StartWorkspaceSessionInput = z.object({
  task_id: z.string().describe('The ID of the task to start a workspace session for'),
  prompt: z.string().min(1).describe('The prompt/instruction for the AI agent'),
  provider_id: z.string().describe('The provider ID to use for the AI agent session. Use list_providers to get available provider IDs.'),
  mode: z.enum(['worktree', 'main_directory']).optional()
    .describe("Workspace mode. Defaults to 'worktree'. Use 'main_directory' to run in the project's main directory."),
});

export const GetWorkspaceDiffInput = z.object({
  workspace_id: z.string().describe('The ID of the workspace'),
});

export const MergeWorkspaceInput = z.object({
  workspace_id: z.string().describe('The ID of the workspace to merge'),
});

export const ListMergeableWorkspacesInput = z.object({});

export const MergeAllMemberWorkspacesInput = z.object({
  workspace_ids: z.array(z.string().min(1)).optional()
    .describe('Optional list of TeamRun dedicated workspace IDs to merge. Defaults to all merge-ready member workspaces.'),
  dry_run: z.boolean().optional()
    .describe('When true, return the workspaces that would be merged without changing git or workspace state.'),
  stop_on_conflict: z.boolean().optional()
    .describe('When true, stop processing after the first merge conflict. Defaults to false.'),
});

export const RecordReviewVerdictInput = z.object({
  workspace_id: z.string().describe('The ID of the workspace being reviewed'),
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED'])
    .describe("Review verdict: 'APPROVED' or 'CHANGES_REQUESTED'"),
  reviewed_sha: z.string().min(1).describe('Workspace HEAD commit SHA that this review applies to'),
  reason: z.string().optional().describe('Optional review summary or reason'),
});

export const ReportTestResultInput = z.object({
  workspace_id: z.string().describe('The ID of the workspace tested'),
  verdict: z.enum(['PASSED', 'FAILED'])
    .describe("Test verdict: 'PASSED' or 'FAILED'"),
  reviewed_sha: z.string().min(1).describe('Workspace HEAD commit SHA that this test result applies to'),
  reason: z.string().optional().describe('Optional test report summary'),
});

// ── Workspace background services (workspace-context only) ──

export const StartWorkspaceServiceInput = z.object({
  service_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .describe('Stable name for the service within the current workspace.'),
  command: z.string().min(1).max(512)
    .describe('Executable name only. Pass arguments separately; do not provide a shell command string.'),
  args: z.array(z.string().max(8_192)).max(100).optional()
    .describe('Structured executable arguments.'),
  relative_cwd: z.string().max(1_024).optional()
    .describe('Directory relative to the current workspace. Defaults to ".".'),
}).strict();

export const ListWorkspaceServicesInput = z.object({}).strict();

export const GetWorkspaceServiceLogsInput = z.object({
  service_name: z.string().min(1),
  runtime_instance_id: z.string().min(1).max(128).optional()
    .describe('Expected runtime generation from the previous log response. Omit for the first read.'),
  after_seq: z.number().int().min(0).optional()
    .describe('Return entries with a sequence greater than this cursor. Omit to return the latest entries.'),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const SendWorkspaceServiceInput = z.object({
  service_name: z.string().min(1),
  data: z.string().min(1).max(8_192)
    .describe('UTF-8 input written as-is. Include a newline explicitly when required.'),
}).strict();

export const ControlWorkspaceServiceInput = z.object({
  service_name: z.string().min(1),
  action: z.enum(['stop', 'restart']),
}).strict();

// ── Sessions ──

export const StopSessionInput = z.object({
  session_id: z.string().describe('The ID of the session to stop'),
});

export const SendMessageInput = z.object({
  session_id: z.string().describe('The ID of the session'),
  message: z.string().min(1).describe('The message to send'),
});
