import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AgentType as SharedAgentType,
  PROVIDER_CAPABILITIES,
  RuntimeType,
  USER_VISIBLE_AGENT_TYPES,
  isUserVisibleAgentType,
  type ProviderDraftInput,
} from '@agent-tower/shared';
import {
  getProviderById,
  createProviderBackup,
  previewProviderImport,
  importProvidersFromBackup,
  createProvider,
  updateProvider,
  deleteProvider,
  canDeleteProvider,
  reloadProviders,
  getAllProvidersAvailability,
  smokeTestProviderConfiguration,
} from '../executors/index.js';
import { AgentType } from '../types/index.js';
import {
  getProviderSecretValues,
  normalizeProviderDraft,
  redactProvider,
  validateProviderBackupDrafts,
} from '../services/provider-config.service.js';
import {
  getCodexReasoningEffortOptions,
  validateCodexReasoningEffort,
} from '../services/codex-model-capabilities.service.js';
import {
  probeEffectiveProviderConnection,
  resolveEffectiveProviderConnection,
  type ProviderConnectionProbeOptions,
} from '../services/provider-effective-connection.service.js';

export interface ProviderRoutesOptions {
  connectionProbe?: ProviderConnectionProbeOptions;
}

const secretWriteSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }),
  z.object({ action: z.literal('replace'), value: z.string() }),
  z.object({ action: z.literal('clear') }),
]);

const simplifiedSchema = z.object({
  apiBaseUrl: z.string().optional(),
  apiKey: z.object({
    configured: z.boolean(),
    envKey: z.string().min(1),
  }).optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

const conflictResolutionsSchema = z.record(
  z.enum(['apiBaseUrl', 'apiKey', 'model', 'reasoningEffort']),
  z.enum(['simple', 'advanced']),
);

const createProviderSchema = z.object({
  name: z.string(),
  agentType: z.nativeEnum(AgentType).refine(isUserVisibleAgentType, 'Agent type is not available'),
  runtimeType: z.nativeEnum(RuntimeType).default(RuntimeType.CLI),
  env: z.record(secretWriteSchema).default({}),
  config: z.record(z.unknown()).default({}),
  settings: z.string().optional(),
  simplified: simplifiedSchema.optional(),
  conflictResolutions: conflictResolutionsSchema.optional(),
  isDefault: z.boolean().default(false),
});

const updateProviderSchema = z.object({
  name: z.string().optional(),
  env: z.record(secretWriteSchema).optional(),
  config: z.record(z.unknown()).optional(),
  settings: z.string().optional(),
  simplified: simplifiedSchema.optional(),
  conflictResolutions: conflictResolutionsSchema.optional(),
  isDefault: z.boolean().optional(),
});

const testProviderSchema = createProviderSchema.extend({
  providerId: z.string().min(1).optional(),
});

const capabilitiesQuerySchema = z.object({
  agentType: z.nativeEnum(SharedAgentType).optional(),
  model: z.string().optional(),
});

const backupProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  agentType: z.nativeEnum(AgentType),
  runtimeType: z.nativeEnum(RuntimeType).optional().default(RuntimeType.CLI),
  env: z.record(z.string()).default({}),
  config: z.record(z.unknown()).default({}),
  settings: z.string().optional(),
  isDefault: z.boolean().default(false),
  createdAt: z.string().optional(),
});

const providerBackupSchema = z.object({
  version: z.literal(1),
  kind: z.literal('provider-backup'),
  exportedAt: z.string().min(1),
  mode: z.literal('full'),
  providers: z.array(backupProviderSchema),
}).superRefine((backup, ctx) => {
  const seenIds = new Set<string>();
  backup.providers.forEach((provider, index) => {
    if (seenIds.has(provider.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate provider id in backup: ${provider.id}`,
        path: ['providers', index, 'id'],
      });
    }
    seenIds.add(provider.id);
  });
});

function parseBackupPayload(body: unknown) {
  const result = providerBackupSchema.safeParse(body);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? 'Invalid provider backup payload');
  return result.data;
}

function redactError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

function persistedData(provider: ReturnType<typeof normalizeProviderDraft>['provider']) {
  const { id: _id, builtIn: _builtIn, createdAt: _createdAt, ...data } = provider;
  return data;
}

function draftSecrets(input: ProviderDraftInput): string[] {
  return Object.values(input.env ?? {}).flatMap(write => write.action === 'replace' ? [write.value] : []);
}

export async function providerRoutes(app: FastifyInstance, options: ProviderRoutesOptions = {}) {
  app.get('/providers', async () => {
    const providersWithAvailability = await getAllProvidersAvailability();
    return providersWithAvailability.map(item => ({
      ...item,
      provider: redactProvider(item.provider, canDeleteProvider(item.provider)),
    }));
  });

  app.get('/providers/capabilities', async (request) => {
    const query = capabilitiesQuerySchema.parse(request.query ?? {});
    const capabilities = Object.fromEntries(
      USER_VISIBLE_AGENT_TYPES.map(agentType => [agentType, PROVIDER_CAPABILITIES[agentType]]),
    ) as typeof PROVIDER_CAPABILITIES;
    if (query.agentType === SharedAgentType.CODEX && query.model?.trim()) {
      const reasoningEffort = capabilities[SharedAgentType.CODEX].reasoningEffort;
      if (reasoningEffort) {
        const resolved = await getCodexReasoningEffortOptions(query.model);
        capabilities[SharedAgentType.CODEX] = {
          ...capabilities[SharedAgentType.CODEX],
          reasoningEffort: { ...reasoningEffort, options: resolved.options },
        };
      }
    }
    return capabilities;
  });

  app.post('/providers/test', async (request, reply) => {
    const parsed = testProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, stage: 'validation', summary: parsed.error.issues[0]?.message ?? 'Invalid draft' };
    }
    const input = parsed.data as ProviderDraftInput;
    const existing = input.providerId ? getProviderById(input.providerId) : null;
    if (input.providerId && !existing) {
      reply.code(404);
      return { ok: false, stage: 'validation', summary: 'Provider not found' };
    }
    const normalized = normalizeProviderDraft(input, existing);
    const provider = normalized.provider;
    const diagnostics = [
      ...normalized.diagnostics,
    ];
    if (!diagnostics.some(diagnostic => diagnostic.field === 'reasoningEffort')) {
      diagnostics.push(...await validateCodexReasoningEffort(provider));
    }
    if (diagnostics.length > 0) {
      return { ok: false, stage: 'validation', summary: 'Configuration validation failed', diagnostics };
    }
    const connection = resolveEffectiveProviderConnection(provider);
    if (connection.diagnostics.length > 0) {
      return {
        ok: false,
        stage: 'validation',
        summary: 'Configuration validation failed',
        diagnostics: connection.diagnostics,
      };
    }
    if (connection.protocol && connection.baseUrl) {
      const [result, availability] = await Promise.all([
        probeEffectiveProviderConnection(connection, options.connectionProbe),
        smokeTestProviderConfiguration(provider)
          .then(smokeTest => smokeTest.availability.type)
          .catch(() => undefined),
      ]);
      return availability ? { ...result, availability } : result;
    }
    try {
      const { availability } = await smokeTestProviderConfiguration(provider);
      if (availability.type === 'NOT_FOUND') {
        return {
          ok: false,
          stage: 'availability',
          summary: redactError(availability.error ?? 'CLI is not available', getProviderSecretValues(provider)),
          availability: availability.type,
        };
      }
      const result = await probeEffectiveProviderConnection(
        connection,
        options.connectionProbe,
      );
      return { ...result, availability: availability.type };
    } catch (error) {
      return {
        ok: false,
        stage: 'command',
        summary: redactError(error, getProviderSecretValues(provider)),
      };
    }
  });

  app.get('/providers/backup', async () => createProviderBackup());

  app.post('/providers/import/preview', async (request, reply) => {
    try {
      const backup = parseBackupPayload(request.body);
      const diagnostics = validateProviderBackupDrafts(backup);
      if (diagnostics.length > 0) {
        reply.code(400);
        return { message: 'Invalid provider backup', diagnostics };
      }
      const preview = previewProviderImport(backup);
      return {
        ...preview,
        items: preview.items.map(item => ({
          ...item,
          incoming: redactProvider(item.incoming),
          existing: item.existing ? redactProvider(item.existing) : item.existing,
        })),
      };
    } catch (error) {
      reply.code(400);
      return { message: redactError(error) };
    }
  });

  app.post('/providers/import', async (request, reply) => {
    try {
      const backup = parseBackupPayload(request.body);
      const diagnostics = validateProviderBackupDrafts(backup);
      if (diagnostics.length > 0) {
        reply.code(400);
        return { message: 'Invalid provider backup', diagnostics };
      }
      const result = importProvidersFromBackup(backup);
      return {
        ...result,
        providers: result.providers
          .filter(provider => isUserVisibleAgentType(provider.agentType))
          .map(provider => redactProvider(provider)),
      };
    } catch (error) {
      reply.code(400);
      return { message: redactError(error) };
    }
  });

  app.get<{ Params: { id: string } }>('/providers/:id', async (request, reply) => {
    const provider = getProviderById(request.params.id);
    if (!provider) {
      reply.code(404);
      return { error: `Provider not found: ${request.params.id}` };
    }
    return redactProvider(provider, canDeleteProvider(provider));
  });

  app.post('/providers', async (request, reply) => {
    const parsed = createProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid provider configuration', diagnostics: parsed.error.issues };
    }
    const input = parsed.data as ProviderDraftInput;
    const normalized = normalizeProviderDraft(input);
    const diagnostics = [
      ...normalized.diagnostics,
    ];
    if (!diagnostics.some(diagnostic => diagnostic.field === 'reasoningEffort')) {
      diagnostics.push(...await validateCodexReasoningEffort(normalized.provider));
    }
    if (diagnostics.length > 0) {
      reply.code(400);
      return { error: 'Invalid provider configuration', diagnostics };
    }
    try {
      const provider = createProvider(persistedData(normalized.provider));
      reply.code(201);
      return redactProvider(provider, canDeleteProvider(provider));
    } catch (error) {
      reply.code(400);
      return { error: redactError(error, draftSecrets(input)) };
    }
  });

  app.put<{ Params: { id: string } }>('/providers/:id', async (request, reply) => {
    const parsed = updateProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid provider configuration', diagnostics: parsed.error.issues };
    }
    const existing = getProviderById(request.params.id);
    if (!existing) {
      reply.code(404);
      return { error: `Provider not found: ${request.params.id}` };
    }
    const input: ProviderDraftInput = {
      ...parsed.data,
      providerId: existing.id,
      name: parsed.data.name ?? existing.name,
      agentType: existing.agentType as SharedAgentType,
    };
    const normalized = normalizeProviderDraft(input, existing);
    const diagnostics = [
      ...normalized.diagnostics,
    ];
    if (!diagnostics.some(diagnostic => diagnostic.field === 'reasoningEffort')) {
      diagnostics.push(...await validateCodexReasoningEffort(normalized.provider));
    }
    if (diagnostics.length > 0) {
      reply.code(400);
      return { error: 'Invalid provider configuration', diagnostics };
    }
    try {
      const provider = updateProvider(existing.id, persistedData(normalized.provider));
      return provider ? redactProvider(provider, canDeleteProvider(provider)) : null;
    } catch (error) {
      reply.code(400);
      return { error: redactError(error, draftSecrets(input)) };
    }
  });

  app.delete<{ Params: { id: string } }>('/providers/:id', async (request, reply) => {
    try {
      const deleted = deleteProvider(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: `Provider not found: ${request.params.id}` };
      }
      return { success: true };
    } catch (error) {
      reply.code(400);
      return { error: redactError(error) };
    }
  });

  app.post('/providers/reload', async () => ({
    success: true,
    providers: reloadProviders()
      .filter(provider => isUserVisibleAgentType(provider.agentType))
      .map(provider => redactProvider(provider)),
  }));
}
