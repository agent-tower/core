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
});

export const GetTaskInput = z.object({
  task_id: z.string().describe('The ID of the task to retrieve'),
});

export const UpdateTaskInput = z.object({
  task_id: z.string().describe('The ID of the task to update'),
  title: z.string().min(1).optional().describe('New title for the task'),
  description: z.string().optional().describe('New description for the task'),
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
});

export const GetWorkspaceDiffInput = z.object({
  workspace_id: z.string().describe('The ID of the workspace'),
});

export const MergeWorkspaceInput = z.object({
  workspace_id: z.string().describe('The ID of the workspace to merge'),
});

// ── Sessions ──

export const StopSessionInput = z.object({
  session_id: z.string().describe('The ID of the session to stop'),
});

export const SendMessageInput = z.object({
  session_id: z.string().describe('The ID of the session'),
  message: z.string().min(1).describe('The message to send'),
});
