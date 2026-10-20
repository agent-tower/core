export type TranslationQueueDirection = 'SEND' | 'DISPLAY';

export type QueueErrorCode = 'QUEUE_FULL' | 'QUEUE_CLOSED' | 'DUPLICATE_JOB' | 'CANCELLED';

export class QueueError extends Error {
  constructor(public readonly code: QueueErrorCode) {
    super({
      QUEUE_FULL: 'Translation request queue is full',
      QUEUE_CLOSED: 'Translation request queue is closed',
      DUPLICATE_JOB: 'Translation request is already queued or running',
      CANCELLED: 'Translation request was cancelled',
    }[code]);
    this.name = 'QueueError';
  }
}

export interface TranslationQueueOptions {
  maxConcurrency?: number;
  maxLaneConcurrency?: number;
}

export interface TranslationQueueRequest {
  id: string;
  laneKey: string;
  direction: TranslationQueueDirection;
  signal?: AbortSignal;
}

interface QueuedJob {
  id: string;
  laneKey: string;
  direction: TranslationQueueDirection;
  controller: AbortController;
  state: 'pending' | 'active';
  cancelled: boolean;
  execute: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  removeAbortListener?: () => void;
}

interface DirectionQueue {
  lanes: Map<string, QueuedJob[]>;
  laneOrder: string[];
}

const MAX_PENDING_REQUESTS = 512;
const DIRECTION_ORDER: readonly TranslationQueueDirection[] = ['SEND', 'SEND', 'DISPLAY'];

/**
 * Owns HTTP request handles, rather than persistent translation sources/attempts.
 * Source admission, retries and version checks belong to TranslationService.
 */
export class TranslationQueue {
  private maxConcurrency: number;
  private readonly maxLaneConcurrency: number;
  private readonly jobs = new Map<string, QueuedJob>();
  private readonly activeLanes = new Map<string, number>();
  private readonly queues: Record<TranslationQueueDirection, DirectionQueue> = {
    SEND: { lanes: new Map(), laneOrder: [] },
    DISPLAY: { lanes: new Map(), laneOrder: [] },
  };
  private pendingCount = 0;
  private activeCount = 0;
  private directionIndex = 0;
  private closed = false;
  private shutdownPromise?: Promise<void>;
  private completeShutdown?: () => void;

  constructor(options: TranslationQueueOptions = {}) {
    this.maxConcurrency = this.validateConcurrency(options.maxConcurrency ?? 4);
    this.maxLaneConcurrency = options.maxLaneConcurrency ?? 2;
    if (!Number.isInteger(this.maxLaneConcurrency) || this.maxLaneConcurrency < 1) {
      throw new RangeError('maxLaneConcurrency must be a positive integer');
    }
  }

  get stats(): { inflight: number; pending: number } {
    return { inflight: this.activeCount, pending: this.pendingCount };
  }

  setConcurrency(value: number): void {
    this.maxConcurrency = this.validateConcurrency(value);
    // Reducing the limit only stops admission; existing handles retain ownership.
    this.pump();
  }

  run<T>(request: TranslationQueueRequest, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new QueueError('QUEUE_CLOSED'));
    if (request.signal?.aborted) return Promise.reject(new QueueError('CANCELLED'));
    if (this.jobs.has(request.id)) return Promise.reject(new QueueError('DUPLICATE_JOB'));
    if (this.pendingCount >= MAX_PENDING_REQUESTS) return Promise.reject(new QueueError('QUEUE_FULL'));

    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        id: request.id,
        laneKey: request.laneKey,
        direction: request.direction,
        controller: new AbortController(),
        state: 'pending',
        cancelled: false,
        execute,
        resolve: (value) => resolve(value as T),
        reject,
      };
      const direction = this.queues[job.direction];
      const lane = direction.lanes.get(job.laneKey);
      if (lane) {
        lane.push(job);
      } else {
        direction.lanes.set(job.laneKey, [job]);
        direction.laneOrder.push(job.laneKey);
      }
      this.jobs.set(job.id, job);
      this.pendingCount += 1;

      if (request.signal) {
        const onAbort = () => this.cancel(job.id);
        request.signal.addEventListener('abort', onAbort, { once: true });
        job.removeAbortListener = () => request.signal?.removeEventListener('abort', onAbort);
      }
      this.pump();
    });
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.cancelled) return false;
    job.cancelled = true;
    job.removeAbortListener?.();
    job.reject(new QueueError('CANCELLED'));

    if (job.state === 'pending') {
      const direction = this.queues[job.direction];
      const lane = direction.lanes.get(job.laneKey)!;
      lane.splice(lane.indexOf(job), 1);
      if (lane.length === 0) this.removeLane(direction, job.laneKey);
      this.pendingCount -= 1;
      this.jobs.delete(id);
    }

    // Active jobs keep their slot until execute settles, even if it ignores abort.
    job.controller.abort(new QueueError('CANCELLED'));
    this.pump();
    return true;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.completeShutdown = resolve;
    });
    for (const job of [...this.jobs.values()]) this.cancel(job.id);
    if (this.activeCount === 0) this.completeShutdown?.();
    return this.shutdownPromise;
  }

  private validateConcurrency(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 16) {
      throw new RangeError('maxConcurrency must be an integer between 1 and 16');
    }
    return value;
  }

  private removeLane(direction: DirectionQueue, laneKey: string): void {
    direction.lanes.delete(laneKey);
    const index = direction.laneOrder.indexOf(laneKey);
    if (index !== -1) direction.laneOrder.splice(index, 1);
  }

  private takeFromDirection(direction: DirectionQueue): QueuedJob | undefined {
    // Rotate past blocked lanes so a busy lane cannot block another lane.
    const laneCount = direction.laneOrder.length;
    for (let index = 0; index < laneCount; index += 1) {
      const laneKey = direction.laneOrder.shift()!;
      direction.laneOrder.push(laneKey);
      if ((this.activeLanes.get(laneKey) ?? 0) >= this.maxLaneConcurrency) continue;
      const lane = direction.lanes.get(laneKey)!;
      const job = lane.shift()!;
      if (lane.length === 0) this.removeLane(direction, laneKey);
      return job;
    }
    return undefined;
  }

  private takeNext(): QueuedJob | undefined {
    for (let offset = 0; offset < DIRECTION_ORDER.length; offset += 1) {
      const index = (this.directionIndex + offset) % DIRECTION_ORDER.length;
      const job = this.takeFromDirection(this.queues[DIRECTION_ORDER[index]]);
      if (job) {
        this.directionIndex = (index + 1) % DIRECTION_ORDER.length;
        return job;
      }
    }
    return undefined;
  }

  private pump(): void {
    while (!this.closed && this.activeCount < this.maxConcurrency) {
      const job = this.takeNext();
      if (!job) break;
      job.state = 'active';
      this.pendingCount -= 1;
      this.activeCount += 1;
      this.activeLanes.set(job.laneKey, (this.activeLanes.get(job.laneKey) ?? 0) + 1);
      void this.executeJob(job);
    }
  }

  private async executeJob(job: QueuedJob): Promise<void> {
    let failed = false;
    let result: unknown;
    try {
      // Admission is synchronous; execution starts after the caller gets its handle.
      await Promise.resolve();
      if (job.controller.signal.aborted) throw new QueueError('CANCELLED');
      result = await job.execute(job.controller.signal);
    } catch (error) {
      failed = true;
      result = error;
    } finally {
      // Only this handle can release its slot. Cancel never releases it early.
      job.removeAbortListener?.();
      this.jobs.delete(job.id);
      this.activeCount -= 1;
      const laneCount = (this.activeLanes.get(job.laneKey) ?? 1) - 1;
      if (laneCount === 0) this.activeLanes.delete(job.laneKey);
      else this.activeLanes.set(job.laneKey, laneCount);
      this.pump();
      if (this.closed && this.activeCount === 0) this.completeShutdown?.();
    }
    if (!job.cancelled) {
      if (failed) job.reject(result);
      else job.resolve(result);
    }
  }
}
