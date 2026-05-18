import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { ServiceError } from '../errors.js';
import { TeamRunService } from '../services/team-run.service.js';

const capabilitiesSchema = z.object({
  readRoom: z.boolean(),
  postRoomMessage: z.boolean(),
  mentionMembers: z.boolean(),
  stopMemberWork: z.boolean(),
  markReadyForReview: z.boolean(),
  readFiles: z.boolean(),
  writeFiles: z.boolean(),
  runCommands: z.boolean(),
  readDiff: z.boolean(),
  mergeWorkspace: z.boolean(),
});

const structuredMentionSchema = z.object({
  memberId: z.string().min(1),
  label: z.string().optional(),
  ifBusy: z.enum(['queue', 'cancel_current_and_start']).optional(),
  cancelQueued: z.boolean().optional(),
});

const teamMemberSnapshotSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()),
  providerId: z.string().min(1),
  rolePrompt: z.string().min(1),
  capabilities: capabilitiesSchema,
  workspacePolicy: z.enum(['none', 'shared', 'dedicated']),
  triggerPolicy: z.enum(['MENTION_ONLY', 'USER_MESSAGES']),
  avatar: z.string().nullable().optional(),
});

const createMemberPresetSchema = teamMemberSnapshotSchema;
const updateMemberPresetSchema = teamMemberSnapshotSchema.partial();

const teamTemplateMemberSchema = z.object({
  memberPresetId: z.string().min(1),
  position: z.number().int().min(0).optional(),
});

const createTeamTemplateSchema = z.object({
  name: z.string().min(1),
  memberPresetIds: z.array(z.string().min(1)).optional(),
  members: z.array(teamTemplateMemberSchema).optional(),
});

const updateTeamTemplateSchema = createTeamTemplateSchema.partial();

const createTeamRunMemberSchema = teamMemberSnapshotSchema;

const createTeamRunSchema = z.object({
  mode: z.enum(['CONFIRM', 'AUTO']),
  teamTemplateId: z.string().min(1).optional(),
  memberPresetIds: z.array(z.string().min(1)).optional(),
  members: z.array(createTeamRunMemberSchema).optional(),
});

const roomMessageSchema = z.object({
  content: z.string().min(1),
  mentions: z.array(structuredMentionSchema).optional(),
  attachmentIds: z.array(z.string().min(1)).optional(),
  artifactRefs: z.array(z.string().min(1)).optional(),
  senderType: z.enum(['user', 'agent', 'system']).default('user'),
  senderId: z.string().nullable().optional(),
  senderInvocationId: z.string().nullable().optional(),
  kind: z.enum(['chat', 'work_request', 'work_started', 'artifact', 'review', 'decision', 'system']).optional(),
});

function handleError(error: unknown, reply: any) {
  if (error instanceof ZodError) {
    reply.code(400);
    return {
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: error.errors.map((item) => ({
        field: item.path.join('.'),
        message: item.message,
      })),
    };
  }

  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return { error: error.message, code: error.code };
  }

  console.error('[team-runs] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

export async function teamRunRoutes(app: FastifyInstance) {
  const service = new TeamRunService();

  app.get('/member-presets', async (_request, reply) => {
    try {
      return await service.listMemberPresets();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/member-presets/:id', async (request, reply) => {
    try {
      return await service.getMemberPresetById(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post('/member-presets', async (request, reply) => {
    try {
      const body = createMemberPresetSchema.parse(request.body);
      const memberPreset = await service.createMemberPreset(body);
      reply.code(201);
      return memberPreset;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.patch<{ Params: { id: string } }>('/member-presets/:id', async (request, reply) => {
    try {
      const body = updateMemberPresetSchema.parse(request.body);
      return await service.updateMemberPreset(request.params.id, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.delete<{ Params: { id: string } }>('/member-presets/:id', async (request, reply) => {
    try {
      await service.deleteMemberPreset(request.params.id);
      reply.code(204);
      return;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get('/team-templates', async (_request, reply) => {
    try {
      return await service.listTeamTemplates();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/team-templates/:id', async (request, reply) => {
    try {
      return await service.getTeamTemplateById(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post('/team-templates', async (request, reply) => {
    try {
      const body = createTeamTemplateSchema.parse(request.body);
      const teamTemplate = await service.createTeamTemplate(body);
      reply.code(201);
      return teamTemplate;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.patch<{ Params: { id: string } }>('/team-templates/:id', async (request, reply) => {
    try {
      const body = updateTeamTemplateSchema.parse(request.body);
      return await service.updateTeamTemplate(request.params.id, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.delete<{ Params: { id: string } }>('/team-templates/:id', async (request, reply) => {
    try {
      await service.deleteTeamTemplate(request.params.id);
      reply.code(204);
      return;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { taskId: string } }>('/tasks/:taskId/team-runs', async (request, reply) => {
    try {
      const body = createTeamRunSchema.parse(request.body);
      const teamRun = await service.createTeamRun(request.params.taskId, body);
      reply.code(201);
      return teamRun;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/team-run', async (request, reply) => {
    try {
      return await service.getTaskTeamRun(request.params.taskId);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/team-runs/:id', async (request, reply) => {
    try {
      return await service.getTeamRunById(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/team-runs/:id/messages', async (request, reply) => {
    try {
      const body = roomMessageSchema.parse(request.body);
      const message = await service.createRoomMessage(request.params.id, body);
      reply.code(201);
      return message;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/team-runs/:id/messages', async (request, reply) => {
    try {
      return await service.listRoomMessages(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/team-runs/:id/members', async (request, reply) => {
    try {
      return await service.listTeamMembers(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/team-runs/:id/work-requests', async (request, reply) => {
    try {
      return await service.listWorkRequests(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/team-runs/:id/invocations', async (request, reply) => {
    try {
      return await service.listAgentInvocations(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
