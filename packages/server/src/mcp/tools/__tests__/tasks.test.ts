import { describe, expect, it, vi } from 'vitest';
import { registerTaskTools } from '../tasks.js';
import { CreateTaskInput, UpdateTaskHandoffInput } from '../../types.js';
import { AgentTowerApiError } from '../../http-client.js';

describe('task handoff tools', () => {
  it('preserves exact whitespace and literal replacement strings and exposes actionable errors', async () => {
    const handlers = new Map<string, (params: any) => Promise<any>>();
    const server = { tool: vi.fn((name, _description, _schema, handler) => handlers.set(name, handler)) };
    const client = {
      getTaskHandoff: vi.fn(async () => ({ taskId: 'task', content: ' original\n' })),
      updateTaskHandoff: vi.fn(async () => ({ taskId: 'task', content: '$&\nnew' })),
    };
    registerTaskTools(server as any, client as any);
    const note = await handlers.get('get_task_handoff')!({ task_id: 'task' });
    expect(JSON.parse(note.content[0].text).content).toBe(' original\n');
    const input = UpdateTaskHandoffInput.parse({ task_id: 'task', old_string: ' original\n', new_string: '$&\nnew' });
    await handlers.get('update_task_handoff')!(input);
    expect(client.updateTaskHandoff).toHaveBeenCalledWith('task', { oldString: ' original\n', newString: '$&\nnew' });
    client.updateTaskHandoff.mockRejectedValueOnce(new AgentTowerApiError(409, 'HANDOFF_TEXT_AMBIGUOUS', 'Include more context'));
    const failed = await handlers.get('update_task_handoff')!(input);
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content[0].text)).toMatchObject({ code: 'HANDOFF_TEXT_AMBIGUOUS' });
  });
});

describe('create_task base branch contract', () => {
  it('forwards a subtask parent without overriding the server branch default', async () => {
    const handlers = new Map<string, (params: any) => Promise<any>>();
    const server = { tool: vi.fn((name, _description, _schema, handler) => handlers.set(name, handler)) };
    const client = { createTask: vi.fn(async (_id, input) => ({ id: 'child', ...input })) };
    registerTaskTools(server as any, client as any);
    const parentId = '11111111-1111-4111-8111-111111111111';
    const input = CreateTaskInput.parse({ project_id: 'project', title: 'Child', parent_task_id: parentId });
    const result = await handlers.get('create_task')!(input);
    expect(client.createTask).toHaveBeenCalledWith('project', expect.objectContaining({ parentTaskId: parentId, baseBranch: undefined }));
    expect(result.isError).toBeUndefined();
  });

  it.each(['develop', null, undefined])('forwards %s without confusing it with a task branch name', async (base_branch) => {
    const handlers = new Map<string, (params: any) => Promise<any>>();
    const server = { tool: vi.fn((name, _description, _schema, handler) => handlers.set(name, handler)) };
    const client = { createTask: vi.fn(async (_id, input) => ({ id: 'task', ...input })) };
    registerTaskTools(server as any, client as any);
    const input = CreateTaskInput.parse({ project_id: 'project', title: 'Task', base_branch });
    const result = await handlers.get('create_task')!(input);
    expect(client.createTask).toHaveBeenCalledWith('project', expect.objectContaining({ title: 'Task', baseBranch: base_branch }));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: 'task', ...(base_branch !== undefined ? { baseBranch: base_branch } : {}) });
  });
});
