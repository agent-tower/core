/**
 * 任务相关 MCP tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentTowerClient } from '../http-client.js';
import {
  ListTasksInput,
  CreateTaskInput,
  GetTaskInput,
  UpdateTaskInput,
  DeleteTaskInput,
} from '../types.js';

export function registerTaskTools(server: McpServer, client: AgentTowerClient) {
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
    "Update a task's title, description, or status. `task_id` is required.",
    UpdateTaskInput.shape,
    async (params) => {
      try {
        const { task_id, status, ...fields } = params;
        // 更新字段（title/description）
        const hasFields = fields.title !== undefined || fields.description !== undefined;
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
    'Delete a task. `task_id` is required.',
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
