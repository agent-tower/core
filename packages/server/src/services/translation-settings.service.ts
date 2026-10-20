import type { PrismaClient, TranslationSettings as SettingsRecord } from '@prisma/client';
import { z } from 'zod';
import type {
  TranslationPublicSettings,
  TranslationSanitizedConfigSnapshot,
  TranslationSettingsDraft,
  TranslationSettingsUpdate,
} from '@agent-tower/shared';
import { ServiceError, ValidationError } from '../errors.js';
import { normalizeTranslationApiBaseUrl } from './translation-client.js';
import { validateTranslationTemplate } from './translation-protection.js';

const secretWriteSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().max(16_384) }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
]);

export const translationSettingsDraftSchema = z.object({
  enabled: z.boolean(),
  apiBaseUrl: z.string().max(2048),
  model: z.string().max(256),
  sendTargetLanguage: z.string().max(64),
  displayTargetLanguage: z.string().max(64),
  promptTemplate: z.string().max(32_768),
  maxConcurrency: z.number().int().min(1).max(16),
  apiKey: secretWriteSchema,
}).strict();

export const translationSettingsUpdateSchema = translationSettingsDraftSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
}).strict();

/** Only execution code receives this type; never return it from HTTP or persist it on attempts. */
export interface TranslationExecutionConfig extends TranslationSanitizedConfigSnapshot {
  apiKey: string | null;
}

export type TranslationSettingsChangeListener = (
  settings: Readonly<TranslationPublicSettings>,
  previous: Readonly<TranslationPublicSettings>,
) => void;

function toPublic(row: SettingsRecord): TranslationPublicSettings {
  return {
    id: row.id,
    enabled: row.enabled,
    revision: row.revision,
    enableEpoch: row.enableEpoch,
    apiBaseUrl: row.apiBaseUrl,
    model: row.model,
    credentialRevision: row.credentialRevision,
    keyConfigured: Boolean(row.apiKey),
    sendTargetLanguage: row.sendTargetLanguage,
    displayTargetLanguage: row.displayTargetLanguage,
    promptTemplate: row.promptTemplate,
    maxConcurrency: row.maxConcurrency,
  };
}

function toExecution(row: SettingsRecord): TranslationExecutionConfig {
  const { keyConfigured: _, ...snapshot } = toPublic(row);
  return { ...snapshot, apiKey: row.apiKey };
}

function checkedApiBaseUrl(input: string): string {
  try {
    return normalizeTranslationApiBaseUrl(input);
  } catch {
    throw new ValidationError('Translation API base URL must be http(s), without credentials, query or fragment');
  }
}

function applyDraft(row: SettingsRecord, draft: TranslationSettingsDraft): SettingsRecord {
  const apiKey = draft.apiKey.action === 'replace'
    ? draft.apiKey.value
    : draft.apiKey.action === 'clear' ? null : row.apiKey;
  return {
    ...row,
    enabled: draft.enabled,
    // Empty disabled drafts are allowed; any supplied URL must be safe for ordinary reads.
    apiBaseUrl: draft.apiBaseUrl.trim() ? checkedApiBaseUrl(draft.apiBaseUrl) : '',
    model: draft.model.trim(),
    sendTargetLanguage: draft.sendTargetLanguage.trim(),
    displayTargetLanguage: draft.displayTargetLanguage.trim(),
    promptTemplate: draft.promptTemplate,
    maxConcurrency: draft.maxConcurrency,
    apiKey,
    credentialRevision: row.credentialRevision + Number(apiKey !== row.apiKey),
  };
}

function validateExecution(config: TranslationExecutionConfig): void {
  checkedApiBaseUrl(config.apiBaseUrl);
  if (!config.model) throw new ValidationError('Translation model is required');
  if (!config.sendTargetLanguage || !config.displayTargetLanguage) {
    throw new ValidationError('Both translation target languages are required');
  }
  if (config.apiKey === null) {
    throw new ValidationError('Configure a translation credential, or explicitly replace it with an empty value for a service without credentials');
  }
  try {
    validateTranslationTemplate(config.promptTemplate);
  } catch {
    throw new ValidationError('Translation template must contain {{target_language}} and {{text}}, with valid variable syntax');
  }
}

/** Config authority is the database. Subscribers are synchronous admission/cancellation signals. */
export class TranslationSettingsService {
  private readonly listeners = new Set<TranslationSettingsChangeListener>();

  constructor(private readonly db: PrismaClient) {}

  private getRow(): Promise<SettingsRecord> {
    return this.db.translationSettings.upsert({
      where: { id: 'singleton' }, create: { id: 'singleton' }, update: {},
    });
  }

  async getPublic(): Promise<TranslationPublicSettings> {
    return toPublic(await this.getRow());
  }

  async getExecutionConfig(): Promise<TranslationExecutionConfig> {
    const row = await this.getRow();
    const config = toExecution(row);
    if (config.enabled) validateExecution(config);
    return config;
  }

  /** Validates and resolves a draft, including keep against the current persisted credential. */
  async resolveDraft(input: TranslationSettingsDraft): Promise<TranslationExecutionConfig> {
    const draft = translationSettingsDraftSchema.parse(input);
    const config = toExecution(applyDraft(await this.getRow(), draft));
    validateExecution(config);
    return config;
  }

  async save(input: TranslationSettingsUpdate): Promise<TranslationPublicSettings> {
    const { expectedRevision, ...draft } = translationSettingsUpdateSchema.parse(input);
    await this.getRow();
    const { previous, next } = await this.db.$transaction(async tx => {
      const row = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      if (row.revision !== expectedRevision) {
        throw new ServiceError('Translation settings changed; reload before saving', 'TRANSLATION_SETTINGS_CONFLICT', 409);
      }
      const desired = applyDraft(row, draft);
      if (desired.enabled) validateExecution(toExecution(desired));
      const changed = await tx.translationSettings.updateMany({
        where: { id: 'singleton', revision: expectedRevision },
        data: {
          enabled: desired.enabled,
          apiBaseUrl: desired.apiBaseUrl,
          model: desired.model,
          sendTargetLanguage: desired.sendTargetLanguage,
          displayTargetLanguage: desired.displayTargetLanguage,
          promptTemplate: desired.promptTemplate,
          maxConcurrency: desired.maxConcurrency,
          apiKey: desired.apiKey,
          credentialRevision: desired.credentialRevision,
          revision: { increment: 1 },
          enableEpoch: { increment: Number(row.enabled && !desired.enabled) },
        },
      });
      if (changed.count !== 1) {
        throw new ServiceError('Translation settings changed; reload before saving', 'TRANSLATION_SETTINGS_CONFLICT', 409);
      }
      if (row.enabled && !desired.enabled) {
        // Preserve already committed effective text even if the delivery worker has not copied it yet.
        const completed = await tx.translationSource.findMany({ where: { sourceKind: 'USER_DELIVERY', delivery: { origin: { in: ['TASK_INITIAL', 'TASK_FOLLOWUP', 'CONVERSATION'] }, sessionId: { not: null }, state: 'WAITING_TRANSLATION' }, deliveryId: { not: null }, jobState: { in: ['SUCCESS', 'NOT_REQUIRED'] }, effectiveAttemptId: { not: null }, deletedAt: null } });
        for (const source of completed) {
          const attempt = await tx.translationAttempt.findUnique({ where: { id: source.effectiveAttemptId! } });
          if (attempt?.resultText != null && attempt.sourceHash === source.sourceHash && attempt.sourceRevision === source.sourceRevision) {
            await tx.messageDelivery.updateMany({ where: { id: source.deliveryId!, state: 'WAITING_TRANSLATION', sourceHash: source.sourceHash }, data: { acceptedText: attempt.resultText, sentMode: source.jobState === 'NOT_REQUIRED' ? 'ORIGINAL' : 'TRANSLATED' } });
          }
        }
        // Same SQLite arbitration as dispatch claim: queued/accepted inputs pause, claimed bytes cannot be recalled.
        await tx.messageDelivery.updateMany({ where: { origin: { in: ['TASK_INITIAL', 'TASK_FOLLOWUP', 'CONVERSATION'] }, sessionId: { not: null }, state: { notIn: ['SENT', 'CANCELLED', 'DISPATCHING', 'DELIVERY_UNKNOWN'] } }, data: { state: 'PAUSED_DISABLED', revision: { increment: 1 }, lastError: 'DISABLED' } });
      }
      const saved = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      return { previous: toPublic(row), next: toPublic(saved) };
    });
    for (const listener of this.listeners) {
      // Saving is already committed; one faulty observer must not suppress other observers.
      try { listener(Object.freeze({ ...next }), Object.freeze({ ...previous })); } catch { /* authority remains in SQLite */ }
    }
    return next;
  }

  onChange(listener: TranslationSettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
