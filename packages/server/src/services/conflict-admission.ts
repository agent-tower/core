import { ServiceError } from '../errors.js';

const timeout = (admissionPhase = 'total') => Object.assign(new ServiceError('Conflict admission timed out; check the original submission before retrying', 'CONFLICT_ADMISSION_TIMEOUT', 408), { admissionPhase });

/** Internal lifetime only. HTTP disconnects do not revoke an admission. */
export class ConflictAdmission {
  private readonly controller = new AbortController();
  private readonly end = performance.now() + 35_000;
  private readonly timer = setTimeout(() => this.cancel(timeout()), 35_000);
  private complete!: () => void;
  readonly settled = new Promise<void>(resolve => { this.complete = resolve; });
  readonly budget = new ConflictAdmissionBudget(this, this.end);
  get signal() { return this.controller.signal; }
  cancel(error = new ServiceError('Conflict admission cancelled during service shutdown', 'CONFLICT_ADMISSION_CANCELLED', 409)) {
    if (!this.signal.aborted) this.controller.abort(error);
  }
  check() { if (this.signal.aborted) throw this.signal.reason; }
  finish() { clearTimeout(this.timer); this.complete(); }
}

/** Child deadlines can only shorten their enclosing deadline; awaiting work never races cleanup. */
export class ConflictAdmissionBudget {
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly admission: ConflictAdmission, private readonly end: number, timed = false, private readonly name = 'total') {
    if (timed) this.timer = setTimeout(() => admission.cancel(timeout(name)), Math.max(1, end - performance.now()));
  }
  get signal() { return this.admission.signal; }
  check() {
    if (performance.now() >= this.end) this.admission.cancel(timeout(this.name));
    this.admission.check();
  }
  remainingMs() { this.check(); return Math.max(1, Math.floor(this.end - performance.now())); }
  phase(ms: number, name = this.name) { this.check(); return new ConflictAdmissionBudget(this.admission, Math.min(this.end, performance.now() + ms), true, name); }
  dispose() { clearTimeout(this.timer); }
}

/** Bounded admission owners. A slot is returned only after its real callback/tail has settled. */
export class ConflictAdmissionGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly capacity: number, private readonly maxQueued: number) {}
  async acquire(budget: ConflictAdmissionBudget): Promise<() => void> {
    budget.check();
    if (this.active >= this.capacity) {
      if (this.queue.length >= this.maxQueued) throw new ServiceError('Too many conflict admissions; retry explicitly later', 'CONFLICT_ADMISSION_FULL', 429);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => budget.signal.removeEventListener('abort', abort);
        const enter = () => { cleanup(); resolve(); };
        const abort = () => {
          const index = this.queue.indexOf(enter);
          if (index >= 0) this.queue.splice(index, 1);
          cleanup(); reject(budget.signal.reason);
        };
        this.queue.push(enter);
        budget.signal.addEventListener('abort', abort, { once: true });
        if (budget.signal.aborted) abort();
      });
    } else this.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(); else this.active--;
    };
    try { budget.check(); return release; } catch (error) { release(); throw error; }
  }
}
