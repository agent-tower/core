/**
 * 任务相关 MCP tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentTowerClient } from '../http-client.js';
import { AgentTowerApiError } from '../http-client.js';
import {
  ListTasksInput,
  CreateTaskInput,
  GetTaskInput,
  UpdateTaskInput,
  DeleteTaskInput,
  GetTaskHandoffInput,
  UpdateTaskHandoffInput,
} from '../types.js';

export function registerTaskTools(server: McpServer, client: AgentTowerClient) {
  server.tool(
    'get_task_handoff',
    'Read the task handoff Markdown before continuing work or editing the note. It summarizes progress, decisions, verification, and next steps; detailed evidence stays in existing session history. An empty note returns content="". task_id is required.',
    GetTaskHandoffInput.shape,
    async ({ task_id }) => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await client.getTaskHandoff(task_id)) }] };
      } catch (error) { return handoffError(error); }
    },
  );

  server.tool(
    'update_task_handoff',
    'Edit the shared task handoff like a file: replace exactly one literal occurrence of old_string with new_string. Read the current note first. Empty old_string only initializes an empty note; empty new_string deletes the match. Missing or ambiguous matches and concurrent changes fail without overwriting. Include more context or reread before retrying. Write a concise, self-contained Markdown handoff so the next person or AI can continue without rereading the entire conversation. Start with the current status, group related information under descriptive headings, use short paragraphs or bullets with one point per item, and list next steps in execution order. Use plain language and enough context for human readers; never sacrifice clarity or readability for brevity. Preserve human corrections and distinguish completed and verified work from proposals or uncertainty. Update at useful milestones; keep detailed logs in session history. Returns the saved note.',
    UpdateTaskHandoffInput.shape,
    async ({ task_id, old_string, new_string }) => {
      try {
        const result = await client.updateTaskHandoff(task_id, { oldString: old_string, newString: new_string });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) { return handoffError(error); }
    },
  );

  server.tool(
    'list_tasks',
    'List tasks in a project with optional status filter. `project_id` is required!',
    ListTasksInput.shape,
    async (params) => {
      try {
        const result = await client.listTasks(params.project_id, {
          status: params.status,
          limit: params.limit,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'create_task',
    'Create a new task in a project. `project_id` is required!',
    CreateTaskInput.shape,
    async (params) => {
      try {
        const task = await client.createTask(params.project_id, {
          title: params.title,
          description: params.description,
          priority: params.priority,
          baseBranch: params.base_branch,
          parentTaskId: params.parent_task_id,
        });
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_task',
    'Get detailed information about a specific task. `task_id` is required.',
    GetTaskInput.shape,
    async (params) => {
      try {
        const task = await client.getTask(params.task_id);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'update_task',
    "Update a task's title, description, priority, or status. `task_id` is required.",
    UpdateTaskInput.shape,
    async (params) => {
      try {
        const { task_id, status, ...fields } = params;
        // 更新字段（title/description/priority）
        const hasFields = fields.title !== undefined || fields.description !== undefined || fields.priority !== undefined;
        let result: any;
        if (hasFields) {
          result = await client.updateTask(task_id, fields);
        }
        // 更新状态
        if (status) {
          result = await client.updateTaskStatus(task_id, status);
        }
        if (!result) {
          result = await client.getTask(task_id);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'delete_task',
    'Delete a task AND ALL its descendants (children and grandchildren), stopping their sessions and cleaning up their worktrees and owned branches. Confirm the complete deletion scope with the user first. `task_id` is required.',
    DeleteTaskInput.shape,
    async (params) => {
      try {
        await client.deleteTask(params.task_id);
        return { content: [{ type: 'text', text: JSON.stringify({ deleted_task_id: params.task_id }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}

function handoffError(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({
      code: error instanceof AgentTowerApiError ? error.code : 'HANDOFF_REQUEST_FAILED',
      message: error instanceof Error ? error.message : 'Task handoff request failed.',
    }) }],
  };
}
