import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRANSLATION_PROMPT_TEMPLATE, type TranslationSettingsDraft } from '@agent-tower/shared';
import { synchronizeDatabaseSchema } from '../../utils/database-schema.js';
import { TranslationSettingsService } from '../translation-settings.service.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-translation-settings-'));
const databaseUrl = `file:${path.join(testDir, 'test.db')}`;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const draft: TranslationSettingsDraft = {
  enabled: true,
  apiBaseUrl: 'http://localhost:7777/v1/',
  model: 'translator',
  sendTargetLanguage: 'English',
  displayTargetLanguage: '简体中文',
  promptTemplate: DEFAULT_TRANSLATION_PROMPT_TEMPLATE,
  maxConcurrency: 4,
  apiKey: { action: 'replace', value: 'server-only-key' },
};
let service: TranslationSettingsService;

describe('TranslationSettingsService', () => {
  beforeAll(async () => {
    // Exercise the real startup schema-sync path against an existing pre-feature database.
    const schema = fs.readFileSync(path.resolve(serverRoot, '../../scripts/fixtures/team-foundation-legacy.prisma'), 'utf8');
    const legacySchema = path.join(testDir, 'legacy.prisma');
    fs.writeFileSync(legacySchema, schema.replace(/^\s+translationSources TranslationSource\[\]$/gm, '').replace(/^\s+(?:translationSourceId String\? @unique|translationSource TranslationSource\?[^\n]*|acceptedAttemptId String\?|acceptedAttempt TranslationAttempt\?[^\n]*)$/gm, '').replace(/^model Translation(?:Settings|Source|Attempt) \{[\s\S]*?^\}\s*/gm, ''));
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${legacySchema}`], {
      cwd: serverRoot, env: { ...process.env, AGENT_TOWER_DATABASE_URL: databaseUrl }, stdio: 'pipe',
    });
    await prisma.appSettings.create({ data: { id: 'singleton', locale: 'en', dataMigrationVersion: 7 } });
    await synchronizeDatabaseSchema({ dataDir: testDir, dbPath: path.join(testDir, 'test.db'), schemaPath: path.join(serverRoot, 'prisma/schema.prisma'), entryDir: path.join(serverRoot, 'src') });
  });

  it('adds default-off translation storage without rewriting existing settings or backfilling history', async () => {
    expect(await prisma.appSettings.findUnique({ where: { id: 'singleton' } })).toMatchObject({ locale: 'en', dataMigrationVersion: 7 });
    expect((await service.getPublic()).enabled).toBe(false);
    expect(await prisma.translationSource.count()).toBe(0);
    expect(await prisma.translationAttempt.count()).toBe(0);
  });
  beforeEach(async () => {
    await prisma.translationSettings.deleteMany();
    service = new TranslationSettingsService(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('persists disabled defaults without creating any translation history', async () => {
    expect(await service.getPublic()).toMatchObject({
      enabled: false, revision: 0, enableEpoch: 0, keyConfigured: false,
      sendTargetLanguage: 'English', displayTargetLanguage: '简体中文',
      promptTemplate: DEFAULT_TRANSLATION_PROMPT_TEMPLATE,
    });
    expect(await service.getPublic()).not.toHaveProperty('apiKey');
    expect(await prisma.translationSource.count()).toBe(0);
    expect(await prisma.translationAttempt.count()).toBe(0);
  });

  it('saves incomplete disabled drafts, but strictly rejects unknown node selection fields', async () => {
    const incomplete = { ...draft, enabled: false, apiBaseUrl: '', model: '', promptTemplate: '', apiKey: { action: 'clear' as const } };
    expect(await service.save({ ...incomplete, expectedRevision: 0 })).toMatchObject({ revision: 1, enabled: false });
    await expect(service.save({ ...incomplete, expectedRevision: 1, thinking: true } as never)).rejects.toThrow();
    expect((await service.getPublic()).revision).toBe(1);
  });

  it('rejects a credential-bearing URL even in a disabled draft, without persisting it for public reads', async () => {
    await expect(service.save({ ...draft, enabled: false, apiBaseUrl: 'https://account:private-password@example.com/v1', expectedRevision: 0 })).rejects.toThrow('without credentials');
    expect(JSON.stringify(await service.getPublic())).not.toContain('private-password');
  });

  it('keeps, replaces and clears credentials without exposing them through reads or change signals', async () => {
    const changed = vi.fn();
    const unsubscribe = service.onChange(changed);
    const first = await service.save({ ...draft, expectedRevision: 0 });
    expect(first).toMatchObject({ revision: 1, credentialRevision: 1, keyConfigured: true });
    expect(JSON.stringify(first)).not.toContain('server-only-key');
    expect(JSON.stringify(changed.mock.calls)).not.toContain('server-only-key');
    const kept = await service.save({ ...draft, apiKey: { action: 'keep' }, expectedRevision: 1 });
    expect(kept.credentialRevision).toBe(1);
    expect((await service.getExecutionConfig()).apiKey).toBe('server-only-key');
    const replaced = await service.save({ ...draft, apiKey: { action: 'replace', value: 'new-key' }, expectedRevision: 2 });
    expect(replaced.credentialRevision).toBe(2);
    expect((await service.getExecutionConfig()).apiKey).toBe('new-key');
    unsubscribe();
    const cleared = await service.save({ ...draft, enabled: false, apiKey: { action: 'clear' }, expectedRevision: 3 });
    expect(cleared).toMatchObject({ revision: 4, enableEpoch: 1, credentialRevision: 3, keyConfigured: false });
    expect(changed).toHaveBeenCalledTimes(3);
    expect((await service.getExecutionConfig()).apiKey).toBeNull();
  });

  it('rejects stale writers and preserves the winning configuration and credential', async () => {
    await service.save({ ...draft, expectedRevision: 0 });
    await expect(service.save({ ...draft, model: 'stale', expectedRevision: 0 })).rejects.toMatchObject({
      statusCode: 409, code: 'TRANSLATION_SETTINGS_CONFLICT',
    });
    expect(await service.getPublic()).toMatchObject({ revision: 1, model: 'translator' });
    expect((await service.getExecutionConfig()).apiKey).toBe('server-only-key');
  });

  it('accepts exactly one concurrent writer at the same revision', async () => {
    await service.getPublic();
    const results = await Promise.allSettled([
      service.save({ ...draft, model: 'writer-a', expectedRevision: 0 }),
      service.save({ ...draft, model: 'writer-b', expectedRevision: 0 }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { statusCode: 409, code: 'TRANSLATION_SETTINGS_CONFLICT' } });
    expect((await service.getPublic()).revision).toBe(1);
  });

  it('validates draft tests against the current key without saving draft fields or credentials', async () => {
    await service.save({ ...draft, expectedRevision: 0 });
    const resolved = await service.resolveDraft({
      ...draft, model: 'draft-model', apiKey: { action: 'keep' }, sendTargetLanguage: 'French',
    });
    expect(resolved).toMatchObject({ apiKey: 'server-only-key', model: 'draft-model', sendTargetLanguage: 'French' });
    await service.resolveDraft({ ...draft, apiKey: { action: 'replace', value: 'unsaved-key' } });
    expect(await service.getPublic()).toMatchObject({ revision: 1, model: 'translator', sendTargetLanguage: 'English' });
    expect((await service.getExecutionConfig()).apiKey).toBe('server-only-key');
    expect(await prisma.translationAttempt.count()).toBe(0);
  });

  it('allows explicit credential-free service and requires an explicit key decision on first enable', async () => {
    await expect(service.save({ ...draft, apiKey: { action: 'keep' }, expectedRevision: 0 })).rejects.toThrow('credential');
    await service.save({ ...draft, apiKey: { action: 'replace', value: '' }, expectedRevision: 0 });
    expect(await service.getPublic()).toMatchObject({ enabled: true, keyConfigured: false });
    expect((await service.getExecutionConfig()).apiKey).toBe('');
    await expect(service.save({ ...draft, apiKey: { action: 'clear' }, expectedRevision: 1 })).rejects.toThrow('credential');
  });

  it.each([
    { apiBaseUrl: 'ftp://example.com' },
    { apiBaseUrl: 'https:example.com' },
    { apiBaseUrl: 'https://@example.com/v1' },
    { apiBaseUrl: 'https://name:password@example.com/v1' },
    { apiBaseUrl: 'https://example.com/v1?token=private' },
    { apiBaseUrl: 'https://example.com/v1#secret' },
    { promptTemplate: '{{text}}' },
    { promptTemplate: '{{target_language}} {{text}} {{thinking}}' },
    { promptTemplate: '{{target_language}} {{text}} {{unclosed' },
    { sendTargetLanguage: ' ' },
  ])('rejects incomplete or unsafe execution settings: %j', async invalid => {
    await expect(service.save({ ...draft, ...invalid, expectedRevision: 0 })).rejects.toThrow();
    expect((await service.getPublic()).revision).toBe(0);
    await expect(service.resolveDraft({ ...draft, ...invalid, enabled: false })).rejects.toThrow();
  });

  it('changes enable epoch only when disabling; ordinary saves preserve in-flight attempt eligibility', async () => {
    const first = await service.save({ ...draft, expectedRevision: 0 });
    const edited = await service.save({ ...draft, displayTargetLanguage: 'French', expectedRevision: 1 });
    expect(edited.enableEpoch).toBe(first.enableEpoch);
    const off = await service.save({ ...draft, enabled: false, expectedRevision: 2 });
    expect(off.enableEpoch).toBe(first.enableEpoch + 1);
    const on = await service.save({ ...draft, expectedRevision: 3 });
    expect(on.enableEpoch).toBe(off.enableEpoch);
  });
});
