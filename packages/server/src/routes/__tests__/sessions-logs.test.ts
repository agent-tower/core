import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessAuthService } from '../../services/access-auth.service.js';

const { findSession } = vi.hoisted(() => ({ findSession: vi.fn() }));

vi.mock('../../core/container.js', () => ({
  getMessageDeliveryService: () => ({}),
  getSessionManager: () => ({}),
}));
vi.mock('../../utils/index.js', () => ({
  prisma: { session: { findUnique: findSession }, workspace: { findUnique: vi.fn() } },
}));
vi.mock('../../executors/index.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../../services/team-scheduler.service.js', () => ({ TeamSchedulerService: class {} }));

import { sessionRoutes } from '../sessions.js';
import { sessionMsgStoreManager } from '../../output/msg-store.js';
import { LIGHT_TOOL_CONTENT_LIMIT } from '../../output/log-view.js';
import { sessionLogReader } from '../../services/session-log-reader.js';

const output = `Reading /repo/SPEC.md\n\n${'y'.repeat(LIGHT_TOOL_CONTENT_LIMIT * 2)}`;
const stored = {
  sessionId: 'agent-1',
  entries: [
    { id: 'u', timestamp: 1, entryType: 'user_message', content: 'Read the spec' },
    { id: 't', timestamp: 2, entryType: 'tool_use', content: output, metadata: { action: 'file_read', status: 'success', toolContent: [{ type: 'text', text: 'dup' }] } },
    { id: 'a', timestamp: 3, entryType: 'assistant_message', content: 'Done.' },
  ],
};

let row: { logSnapshot: string | null; updatedAt: Date } | null;

async function app() {
  const instance = Fastify();
  await instance.register(sessionRoutes, { prefix: '/api' });
  return instance;
}

describe('session log routes', () => {
  beforeEach(() => {
    vi.spyOn(AccessAuthService, 'isEnabled').mockResolvedValue(false);
    sessionLogReader.clear();
    sessionMsgStoreManager.remove('live-1');
    row = { logSnapshot: JSON.stringify(stored), updatedAt: new Date(1_000) };
    findSession.mockReset();
    findSession.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => {
      if (!row) return null;
      return Object.fromEntries(Object.keys(select).map((key) => [key, row![key as keyof typeof row]]));
    });
  });

  it('answers 404 for an unknown session', async () => {
    row = null;
    const server = await app();
    expect((await server.inject({ method: 'GET', url: '/api/sessions/missing/logs?view=light' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/api/sessions/missing/logs/entries?entries=t:1' })).statusCode).toBe(404);
  });

  it('keeps the full view as the default', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: '/api/sessions/s1/logs' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...stored, seq: 0 });
  });

  it('serves a persisted light view from cache until the snapshot changes', async () => {
    const server = await app();
    const first = await server.inject({ method: 'GET', url: '/api/sessions/s1/logs?view=light' });
    const body = first.json();

    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('application/json');
    expect(body.seq).toBe(0);
    expect(body.entries[1]).toEqual({ id: 't', timestamp: 2, entryType: 'tool_use', content: 'Reading /repo/SPEC.md', contentOmitted: output.length, metadata: { action: 'file_read', status: 'success' } });
    expect(body.entries[0]).toEqual(stored.entries[0]);

    const snapshotReads = () => findSession.mock.calls.filter(([args]) => args.select.logSnapshot).length;
    expect(snapshotReads()).toBe(1);
    await server.inject({ method: 'GET', url: '/api/sessions/s1/logs?view=light' });
    expect(snapshotReads()).toBe(1);

    row = { logSnapshot: JSON.stringify({ ...stored, entries: stored.entries.slice(0, 1) }), updatedAt: new Date(2_000) };
    const changed = await server.inject({ method: 'GET', url: '/api/sessions/s1/logs?view=light' });
    expect(changed.json().entries).toHaveLength(1);
    expect(snapshotReads()).toBe(2);
  });

  it('returns the full text of an omitted entry', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: `/api/sessions/s1/logs/entries?entries=t:${output.length},nope:3` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ entries: [{ id: 't', length: output.length, content: output }] });
  });

  it('decodes entry IDs that contain the list separators', async () => {
    const id = 'call,1:a';
    row = { logSnapshot: JSON.stringify({ ...stored, entries: [{ ...stored.entries[1], id }] }), updatedAt: new Date(1_000) };
    const server = await app();
    const response = await server.inject({ method: 'GET', url: `/api/sessions/s1/logs/entries?entries=${encodeURIComponent(`${encodeURIComponent(id)}:${output.length}`)}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ entries: [{ id, length: output.length, content: output }] });
    expect((await server.inject({ method: 'GET', url: '/api/sessions/s1/logs/entries?entries=%25E0%25A4:3' })).statusCode).toBe(400);
  });

  it('rejects empty or oversized entry lists', async () => {
    const server = await app();
    expect((await server.inject({ method: 'GET', url: '/api/sessions/s1/logs/entries' })).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, (_, index) => `e${index}:1`).join(',');
    expect((await server.inject({ method: 'GET', url: `/api/sessions/s1/logs/entries?entries=${many}` })).statusCode).toBe(400);
  });

  it('reads a live session from its MsgStore in both views', async () => {
    const store = sessionMsgStoreManager.create('live-1');
    store.pushPatch([{ op: 'add', path: '/entries/0', value: stored.entries[1] as never }]);
    const server = await app();

    const light = (await server.inject({ method: 'GET', url: '/api/sessions/live-1/logs?view=light' })).json();
    expect(light.seq).toBe(1);
    expect(light.entries[0].contentOmitted).toBe(output.length);

    const full = (await server.inject({ method: 'GET', url: `/api/sessions/live-1/logs/entries?entries=t:${output.length}` })).json();
    expect(full.entries[0].content).toBe(output);

    // The store's own document stays complete.
    expect(store.getSnapshot().entries[0].content).toBe(output);
    sessionMsgStoreManager.remove('live-1');
  });
});
