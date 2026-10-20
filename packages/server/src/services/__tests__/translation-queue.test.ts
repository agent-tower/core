import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueError, TranslationQueue, type TranslationQueueDirection } from '../translation-queue.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(queue: TranslationQueue) {
  const started: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const results: Promise<string>[] = [];
  const add = (id: string, laneKey = id, direction: TranslationQueueDirection = 'SEND', signal?: AbortSignal) => {
    const gate = deferred();
    gates.set(id, gate);
    const result = queue.run({ id, laneKey, direction, signal }, async (executionSignal) => {
      started.push(id);
      signals.set(id, executionSignal);
      await gate.promise;
      return id;
    });
    // Assertions below inspect rejected jobs; register immediately to avoid an
    // unhandled rejection while other handles intentionally remain blocked.
    void result.catch(() => undefined);
    results.push(result);
    return result;
  };
  return { started, signals, gates, results, add };
}

describe('TranslationQueue', () => {
  const queues: TranslationQueue[] = [];
  const openGates: ReturnType<typeof deferred>[] = [];
  function create(maxConcurrency = 4) {
    const queue = new TranslationQueue({ maxConcurrency });
    queues.push(queue);
    const jobs = harness(queue);
    const add: typeof jobs.add = (...args) => {
      const result = jobs.add(...args);
      openGates.push(jobs.gates.get(args[0])!);
      return result;
    };
    return { queue, ...jobs, add };
  }

  afterEach(async () => {
    // Tests deliberately exercise noncooperative requests; release them before
    // waiting for shutdown, which must continue to own those request handles.
    for (const gate of openGates.splice(0)) gate.resolve();
    await Promise.all(queues.splice(0).map((queue) => queue.shutdown()));
  });

  it('bounds global inflight requests and returns each request result', async () => {
    const jobs = create(2);
    const first = jobs.add('first');
    const second = jobs.add('second');
    const third = jobs.add('third');
    await vi.waitFor(() => expect(jobs.started).toEqual(['first', 'second']));
    expect(jobs.queue.stats).toEqual({ inflight: 2, pending: 1 });

    jobs.gates.get('first')!.resolve();
    await expect(first).resolves.toBe('first');
    await vi.waitFor(() => expect(jobs.started).toEqual(['first', 'second', 'third']));
    expect(jobs.queue.stats).toEqual({ inflight: 2, pending: 0 });
    jobs.gates.get('second')!.resolve();
    jobs.gates.get('third')!.resolve();
    await expect(Promise.all([second, third])).resolves.toEqual(['second', 'third']);
    expect(jobs.queue.stats).toEqual({ inflight: 0, pending: 0 });
  });

  it('shares the per-lane limit across SEND and DISPLAY and admits other lanes', async () => {
    const jobs = create(4);
    jobs.add('a-send-1', 'a');
    jobs.add('a-display-1', 'a', 'DISPLAY');
    jobs.add('a-send-2', 'a');
    jobs.add('a-display-2', 'a', 'DISPLAY');
    jobs.add('b-send', 'b');
    jobs.add('c-display', 'c', 'DISPLAY');
    await vi.waitFor(() => expect(jobs.started).toHaveLength(4));
    expect(jobs.started).toEqual(['a-send-1', 'a-display-1', 'b-send', 'c-display']);
    expect(jobs.queue.stats).toEqual({ inflight: 4, pending: 2 });

    jobs.gates.get('b-send')!.resolve();
    jobs.gates.get('c-display')!.resolve();
    await vi.waitFor(() => expect(jobs.queue.stats.inflight).toBe(2));
    expect(jobs.started).toHaveLength(4);
    jobs.gates.get('a-send-1')!.resolve();
    await vi.waitFor(() => expect(jobs.started).toHaveLength(5));
    expect(jobs.queue.stats.inflight).toBe(2);
  });

  it('gives DISPLAY a turn during a continuous SEND backlog at concurrency one', async () => {
    const jobs = create(1);
    for (let index = 0; index < 8; index += 1) jobs.add(`s${index}`, 'send');
    jobs.add('d0', 'display', 'DISPLAY');
    jobs.add('d1', 'display', 'DISPLAY');
    await vi.waitFor(() => expect(jobs.started).toEqual(['s0']));

    for (const [id, expected] of [
      ['s0', ['s0', 's1']],
      ['s1', ['s0', 's1', 'd0']],
      ['d0', ['s0', 's1', 'd0', 's2']],
      ['s2', ['s0', 's1', 'd0', 's2', 's3']],
      ['s3', ['s0', 's1', 'd0', 's2', 's3', 'd1']],
    ] as const) {
      jobs.gates.get(id)!.resolve();
      await vi.waitFor(() => expect(jobs.started).toEqual(expected));
    }
    expect(jobs.queue.stats.pending).toBe(4);
  });

  it('rotates lanes within a class even when one lane has a long backlog', async () => {
    const jobs = create(1);
    jobs.add('blocker');
    for (const lane of ['a', 'b', 'c']) {
      jobs.add(`${lane}1`, lane);
      jobs.add(`${lane}2`, lane);
    }
    await vi.waitFor(() => expect(jobs.started).toEqual(['blocker']));
    const order = ['blocker', 'a1', 'b1', 'c1', 'a2', 'b2', 'c2'];
    for (let index = 0; index < order.length - 1; index += 1) {
      jobs.gates.get(order[index])!.resolve();
      await vi.waitFor(() => expect(jobs.started).toEqual(order.slice(0, index + 2)));
    }
  });

  it('lends unused SEND capacity to DISPLAY', async () => {
    const jobs = create(3);
    jobs.add('d1', 'one', 'DISPLAY');
    jobs.add('d2', 'two', 'DISPLAY');
    jobs.add('d3', 'three', 'DISPLAY');
    await vi.waitFor(() => expect(jobs.started).toEqual(['d1', 'd2', 'd3']));
    expect(jobs.queue.stats).toEqual({ inflight: 3, pending: 0 });
  });

  it('cancels a pending request without executing it or retaining capacity', async () => {
    const jobs = create(1);
    jobs.add('active');
    const cancelled = jobs.add('cancelled');
    const next = jobs.add('next');
    expect(jobs.queue.cancel('cancelled')).toBe(true);
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(jobs.queue.stats).toEqual({ inflight: 1, pending: 1 });
    expect(jobs.queue.cancel('cancelled')).toBe(false);

    jobs.gates.get('active')!.resolve();
    await vi.waitFor(() => expect(jobs.started).toEqual(['active', 'next']));
    jobs.gates.get('next')!.resolve();
    await expect(next).resolves.toBe('next');
  });

  it('keeps an aborted active handle charged until its noncooperative request exits', async () => {
    const jobs = create(1);
    const old = jobs.add('old');
    await vi.waitFor(() => expect(jobs.started).toEqual(['old']));
    expect(jobs.queue.cancel('old')).toBe(true);
    await expect(old).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(jobs.signals.get('old')!.aborted).toBe(true);
    const newer = jobs.add('newer');
    await expect(jobs.queue.run({ id: 'old', laneKey: 'other', direction: 'SEND' }, async () => undefined))
      .rejects.toMatchObject({ code: 'DUPLICATE_JOB' });
    expect(jobs.started).toEqual(['old']);
    expect(jobs.queue.stats).toEqual({ inflight: 1, pending: 1 });

    jobs.gates.get('old')!.resolve();
    await vi.waitFor(() => expect(jobs.started).toEqual(['old', 'newer']));
    expect(jobs.queue.stats).toEqual({ inflight: 1, pending: 0 });
    jobs.gates.get('newer')!.resolve();
    await expect(newer).resolves.toBe('newer');
    expect(jobs.queue.stats).toEqual({ inflight: 0, pending: 0 });
  });

  it('honors AbortSignal before admission, while pending and while active', async () => {
    const jobs = create(1);
    const before = new AbortController();
    before.abort();
    await expect(jobs.add('before', 'before', 'SEND', before.signal)).rejects.toBeInstanceOf(QueueError);
    const activeAbort = new AbortController();
    const pendingAbort = new AbortController();
    const active = jobs.add('active', 'active', 'SEND', activeAbort.signal);
    const pending = jobs.add('pending', 'pending', 'DISPLAY', pendingAbort.signal);
    await vi.waitFor(() => expect(jobs.started).toEqual(['active']));
    pendingAbort.abort();
    activeAbort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(active).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(jobs.signals.get('active')!.aborted).toBe(true);
    expect(jobs.queue.stats).toEqual({ inflight: 1, pending: 0 });
  });

  it('lowers concurrency without aborting requests and waits for inflight to fall below it', async () => {
    const jobs = create(3);
    for (const id of ['a', 'b', 'c', 'd']) jobs.add(id);
    await vi.waitFor(() => expect(jobs.started).toEqual(['a', 'b', 'c']));
    jobs.queue.setConcurrency(1);
    expect([...jobs.signals.values()].every((signal) => !signal.aborted)).toBe(true);
    for (const [id, count] of [['a', 2], ['b', 1]] as const) {
      jobs.gates.get(id)!.resolve();
      await vi.waitFor(() => expect(jobs.queue.stats.inflight).toBe(count));
      expect(jobs.started).toEqual(['a', 'b', 'c']);
    }
    jobs.gates.get('c')!.resolve();
    await vi.waitFor(() => expect(jobs.started).toEqual(['a', 'b', 'c', 'd']));
    expect(jobs.queue.stats.inflight).toBe(1);
  });

  it('raises concurrency and immediately admits eligible waiting lanes', async () => {
    const jobs = create(1);
    for (const id of ['a', 'b', 'c']) jobs.add(id);
    await vi.waitFor(() => expect(jobs.started).toEqual(['a']));
    jobs.queue.setConcurrency(3);
    await vi.waitFor(() => expect(jobs.started).toEqual(['a', 'b', 'c']));
    expect(jobs.queue.stats).toEqual({ inflight: 3, pending: 0 });
  });

  it('releases only a failing request slot and lets other lanes continue', async () => {
    const jobs = create(2);
    const failed = jobs.add('failed');
    jobs.add('unrelated');
    jobs.add('next');
    await vi.waitFor(() => expect(jobs.started).toEqual(['failed', 'unrelated']));
    jobs.gates.get('failed')!.reject(new Error('controlled failure'));
    await expect(failed).rejects.toThrow('controlled failure');
    await vi.waitFor(() => expect(jobs.started).toEqual(['failed', 'unrelated', 'next']));
    expect(jobs.signals.get('unrelated')!.aborted).toBe(false);
    expect(jobs.queue.stats).toEqual({ inflight: 2, pending: 0 });
  });

  it('rejects above 512 queued handles and reuses a cancelled pending slot', async () => {
    const jobs = create(1);
    jobs.add('active');
    for (let index = 0; index < 512; index += 1) jobs.add(`waiting-${index}`);
    expect(jobs.queue.stats).toEqual({ inflight: 1, pending: 512 });
    const execute = vi.fn(async () => 'unexpected');
    await expect(jobs.queue.run({ id: 'overflow', laneKey: 'overflow', direction: 'SEND' }, execute))
      .rejects.toMatchObject({ code: 'QUEUE_FULL' });
    expect(execute).not.toHaveBeenCalled();
    expect(jobs.queue.stats.pending).toBe(512);
    jobs.queue.cancel('waiting-0');
    jobs.add('replacement');
    expect(jobs.queue.stats.pending).toBe(512);
  });

  it('closes admission, aborts all handles and waits for active execution to finish on shutdown', async () => {
    const jobs = create(2);
    const first = jobs.add('first');
    const second = jobs.add('second');
    const pending = jobs.add('pending');
    await vi.waitFor(() => expect(jobs.started).toEqual(['first', 'second']));
    let stopped = false;
    const shutdown = jobs.queue.shutdown().then(() => { stopped = true; });
    await expect(Promise.all([first, second, pending])).rejects.toMatchObject({ code: 'CANCELLED' });
    expect([...jobs.signals.values()].every((signal) => signal.aborted)).toBe(true);
    expect(jobs.queue.stats).toEqual({ inflight: 2, pending: 0 });
    await expect(jobs.add('after-close')).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    expect(stopped).toBe(false);
    jobs.gates.get('first')!.resolve();
    await vi.waitFor(() => expect(jobs.queue.stats.inflight).toBe(1));
    expect(stopped).toBe(false);
    jobs.gates.get('second')!.resolve();
    await shutdown;
    await jobs.queue.shutdown();
    expect(jobs.queue.stats).toEqual({ inflight: 0, pending: 0 });
    expect(jobs.started).toEqual(['first', 'second']);
  });

  it('rejects duplicate request IDs until the original handle has exited', async () => {
    const jobs = create(1);
    const original = jobs.add('same');
    const duplicate = vi.fn(async () => 'duplicate');
    await expect(jobs.queue.run({ id: 'same', laneKey: 'new-lane', direction: 'DISPLAY' }, duplicate))
      .rejects.toMatchObject({ code: 'DUPLICATE_JOB' });
    await vi.waitFor(() => expect(jobs.started).toEqual(['same']));
    jobs.gates.get('same')!.resolve();
    await original;
    await expect(jobs.queue.run({ id: 'same', laneKey: 'new-lane', direction: 'DISPLAY' }, duplicate))
      .resolves.toBe('duplicate');
  });

  it('validates configured concurrency', () => {
    for (const value of [0, -1, 1.5, 17, Infinity, NaN]) {
      expect(() => new TranslationQueue({ maxConcurrency: value })).toThrow(RangeError);
    }
    expect(() => new TranslationQueue({ maxLaneConcurrency: 0 })).toThrow(RangeError);
    const { queue } = create();
    expect(() => queue.setConcurrency(0)).toThrow(RangeError);
    expect(queue.stats).toEqual({ inflight: 0, pending: 0 });
  });
});
