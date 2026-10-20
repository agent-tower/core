import { afterEach, expect, it, vi } from 'vitest';
import { ConflictAdmission, ConflictAdmissionGate } from '../conflict-admission.js';

afterEach(() => vi.useRealTimers());

it('inherits the enclosing deadline even when entering a new phase', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const request = new ConflictAdmission();
  const transaction = request.budget.phase(5000);
  await vi.advanceTimersByTimeAsync(4500);
  const final = transaction.phase(2500);
  await vi.advanceTimersByTimeAsync(500);
  expect(() => final.check()).toThrowError(expect.objectContaining({ code: 'CONFLICT_ADMISSION_TIMEOUT' }));
  final.dispose(); transaction.dispose(); request.finish();
});

it('removes cancelled waiters while retaining an owned ticket until its actual release', async () => {
  const gate = new ConflictAdmissionGate(1, 1);
  const owner = new ConflictAdmission(); const waiter = new ConflictAdmission(); const extra = new ConflictAdmission();
  const release = await gate.acquire(owner.budget);
  const waiting = gate.acquire(waiter.budget);
  await expect(gate.acquire(extra.budget)).rejects.toMatchObject({ code: 'CONFLICT_ADMISSION_FULL' });
  waiter.cancel();
  await expect(waiting).rejects.toMatchObject({ code: 'CONFLICT_ADMISSION_CANCELLED' });
  owner.cancel();
  let acquired = false;
  const next = gate.acquire(extra.budget).then(releaseNext => { acquired = true; return releaseNext; });
  await Promise.resolve(); expect(acquired).toBe(false);
  release(); (await next)();
  owner.finish(); waiter.finish(); extra.finish();
});
