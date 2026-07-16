import type { IPty } from '@shitiandmw/node-pty';
import type { MsgStore } from '../output/msg-store.js';
import type { EventBus } from '../core/event-bus.js';
import type { EarlyPtyEvent } from '../executors/base.executor.js';
import { writeErrorLog } from '../utils/error-log.js';

export interface OutputParser {
  processData(data: string): void;
  finish(exitCode?: number): void;
  onTurnCompleted?(listener: () => void): () => void;
  onTurnFailed?(listener: () => void): () => void;
}

/**
 * Owns one session's PTY + parser lifecycle.
 */
export class AgentPipeline {
  private destroyed = false;
  private parserFinished = false;
  private offData?: { dispose(): void };
  private offExit?: { dispose(): void };
  private offPatch?: () => void;
  private offSessionId?: () => void;
  private offTurnCompleted?: () => void;
  private offTurnFailed?: () => void;
  private logicalCompletionEmitted = false;
  private logicalFailureEmitted = false;
  private storeFinished = false;
  constructor(
    private readonly sessionId: string,
    private readonly pty: IPty,
    private readonly parser: OutputParser | null,
    private readonly msgStore: MsgStore,
    private readonly eventBus: EventBus,
    earlyEvents?: EarlyPtyEvent[]
  ) {
    this.offPatch = this.msgStore.onPatch((patch, seq) => {
      this.eventBus.emit('session:patch', { sessionId: this.sessionId, patch, seq });
    });
    this.offSessionId = this.msgStore.onSessionId((agentSessionId) => {
      this.eventBus.emit('session:sessionId', { sessionId: this.sessionId, agentSessionId });
    });
    this.offTurnCompleted = this.parser?.onTurnCompleted?.(() => {
      if (this.destroyed || this.logicalCompletionEmitted || this.logicalFailureEmitted) return;
      this.logicalCompletionEmitted = true;
      this.markStoreFinished();
      this.eventBus.emit('session:turn-completed', { sessionId: this.sessionId });
    });
    this.offTurnFailed = this.parser?.onTurnFailed?.(() => {
      if (this.destroyed || this.logicalCompletionEmitted || this.logicalFailureEmitted) return;
      this.logicalFailureEmitted = true;
      this.markStoreFinished();
      this.eventBus.emit('session:turn-failed', { sessionId: this.sessionId });
    });

    this.offData = this.pty.onData((data) => this.handleData(data));
    this.offExit = this.pty.onExit(({ exitCode }) => this.handleExit(exitCode));

    // Replay PTY events that fired between executor spawn and this attach
    // (node-pty does not replay). Without this, a process that exits during
    // the DB transaction in activateSpawnedSession would never deliver its
    // exit event and the session would stay RUNNING forever.
    if (earlyEvents) {
      for (const event of earlyEvents) {
        if (this.destroyed) break;
        if (event.type === 'data') {
          this.handleData(event.data);
        } else {
          this.handleExit(event.exitCode);
        }
      }
    }
  }

  private handleData(data: string): void {
    if (this.destroyed) return;
    this.msgStore.pushStdout(data);
    this.eventBus.emit('session:stdout', { sessionId: this.sessionId, data });
    try {
      this.parser?.processData(data);
    } catch (error) {
      // Never rethrow: this callback runs inside node-pty's data event, so a
      // rethrow becomes an uncaughtException that kills the whole server and
      // freezes every other session. Raw stdout is already in MsgStore.
      writeErrorLog({
        level: 'error',
        source: 'agentPipeline.parser.processData',
        message: `Parser failed while processing session ${this.sessionId} output`,
        error,
        metadata: { sessionId: this.sessionId },
      });
    }
  }

  private handleExit(exitCode: number): void {
    if (this.destroyed) return;
    // finishParser must not prevent pushFinished/session:exit below —
    // otherwise the session would stay RUNNING forever on a parser bug.
    this.finishParser(exitCode);
    this.markStoreFinished();
    this.eventBus.emit('session:exit', { sessionId: this.sessionId, exitCode });
    // Self-cleanup: remove MsgStore listeners so stale references don't accumulate.
    // SessionManager.session:exit handler also calls destroy(), but this ensures
    // cleanup even if external code doesn't explicitly destroy the pipeline.
    this.destroy();
  }

  /**
   * Parser finish must run exactly once per pipeline: both the PTY exit path
   * and destroy() (SessionManager stop/exit handlers) reach here. A second
   * finish() would re-parse the parser's residual buffer and duplicate entries.
   */
  private finishParser(exitCode?: number): void {
    if (this.parserFinished) return;
    this.parserFinished = true;
    try {
      this.parser?.finish(exitCode);
    } catch (error) {
      writeErrorLog({
        level: 'error',
        source: 'agentPipeline.parser.finish',
        message: `Parser failed while finishing session ${this.sessionId}`,
        error,
        metadata: { sessionId: this.sessionId, exitCode },
      });
    }
  }

  private markStoreFinished(): void {
    if (this.storeFinished) return;
    this.storeFinished = true;
    this.msgStore.pushFinished();
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
    // Flush the parser's residual buffer while the patch forwarder is still
    // attached, so entries produced here (e.g. output cut off mid-line on
    // stop()) are pushed to clients instead of only appearing after a reload.
    this.finishParser();
    this.offPatch?.();
    this.offSessionId?.();
    this.offTurnCompleted?.();
    this.offTurnFailed?.();
    try {
      this.pty.kill();
    } catch {
      // ignore kill errors for already-exited processes
    }
  }
}
