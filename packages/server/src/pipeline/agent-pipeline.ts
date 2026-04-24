import type { IPty } from '@shitiandmw/node-pty';
import type { MsgStore } from '../output/msg-store.js';
import type { EventBus } from '../core/event-bus.js';

export interface OutputParser {
  processData(data: string): void;
  finish(exitCode?: number): void;
}

/**
 * Owns one session's PTY + parser lifecycle.
 */
export class AgentPipeline {
  private destroyed = false;
  private offData?: { dispose(): void };
  private offExit?: { dispose(): void };
  private offPatch?: () => void;
  private offSessionId?: () => void;
  constructor(
    private readonly sessionId: string,
    private readonly pty: IPty,
    private readonly parser: OutputParser | null,
    private readonly msgStore: MsgStore,
    private readonly eventBus: EventBus
  ) {
    this.offPatch = this.msgStore.onPatch((patch, seq) => {
      this.eventBus.emit('session:patch', { sessionId: this.sessionId, patch, seq });
    });
    this.offSessionId = this.msgStore.onSessionId((agentSessionId) => {
      this.eventBus.emit('session:sessionId', { sessionId: this.sessionId, agentSessionId });
    });

    this.offData = this.pty.onData((data) => {
      if (this.destroyed) return;
      this.msgStore.pushStdout(data);
      this.eventBus.emit('session:stdout', { sessionId: this.sessionId, data });
      this.parser?.processData(data);
    });

    this.offExit = this.pty.onExit(({ exitCode }) => {
      if (this.destroyed) return;
      this.parser?.finish(exitCode);
      this.msgStore.pushFinished();
      this.eventBus.emit('session:exit', { sessionId: this.sessionId, exitCode });
      // Self-cleanup: remove MsgStore listeners so stale references don't accumulate.
      // SessionManager.session:exit handler also calls destroy(), but this ensures
      // cleanup even if external code doesn't explicitly destroy the pipeline.
      this.destroy();
    });
  }

  get isAlive(): boolean {
    return !this.destroyed;
  }

  write(data: string): void {
    if (this.destroyed) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.destroyed) return;
    this.pty.resize(cols, rows);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offData?.dispose();
    this.offExit?.dispose();
    this.offPatch?.();
    this.offSessionId?.();
    this.parser?.finish();
    try {
      this.pty.kill();
    } catch {
      // ignore kill errors for already-exited processes
    }
  }
}
