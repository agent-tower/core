import type {
  AgentType,
  RuntimeCapabilities,
  RuntimeErrorDto,
  RuntimePermissionRequest,
  RuntimeStateDto,
  RuntimeType,
} from '@agent-tower/shared';
import type { ExecutionEnv } from '../executors/execution-env.js';
import type { JsonPatch, MsgStore } from '../output/index.js';

export type RuntimeStreamEvent =
  | { type: 'stdout'; data: string }
  | { type: 'conversation_patch'; patch: JsonPatch; seq: number }
  | { type: 'external_session_id'; externalSessionId: string }
  | { type: 'permission_requested'; request: RuntimePermissionRequest }
  | { type: 'permission_invalidated'; requestId: string }
  | { type: 'progress' };

export type RuntimeTerminalEvent =
  | { type: 'completed'; outcome?: RuntimeTurnOutcome }
  | { type: 'failed'; error: RuntimeErrorDto };

export interface RuntimeTurnEventEnvelope {
  towerSessionId: string;
  turnId: string;
  sequence: number;
  timestamp: string;
  event: RuntimeStreamEvent | RuntimeTerminalEvent;
}

export interface RuntimeProcessStartedEvent {
  type: 'started';
  towerSessionId: string;
  runtimeInstanceId: string;
  launchClaimNumber: number;
  pid: number;
  /** Unix process-group id or the platform's equivalent tree root identity. */
  processGroupId: string;
  /** Per-launch birth/ownership marker used to reject PID reuse. */
  birthMarker: string;
  /** Per-launch token inherited by owned descendants and persisted for recovery. */
  ownershipToken: string;
}

export interface RuntimeProcessExitedEvent {
  type: 'exited';
  towerSessionId: string;
  runtimeInstanceId: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  launchClaimNumber?: number;
}

export interface RuntimeProcessTreeCleanupCompletedEvent {
  type: 'tree_cleanup_completed';
  towerSessionId: string;
  runtimeInstanceId: string;
  launchClaimNumber?: number;
}

export type RuntimeProcessEvent =
  | RuntimeProcessStartedEvent
  | RuntimeProcessExitedEvent
  | RuntimeProcessTreeCleanupCompletedEvent;

export interface RuntimeDriverEventSink {
  stream(event: RuntimeStreamEvent): void;
  process(event:
    | Omit<RuntimeProcessStartedEvent, 'towerSessionId'>
    | Omit<RuntimeProcessExitedEvent, 'towerSessionId'>
    | Omit<RuntimeProcessTreeCleanupCompletedEvent, 'towerSessionId'>
  ): Promise<void>;
}

export interface RuntimeOpenInput {
  towerSessionId: string;
  agentType: AgentType;
  runtimeType: RuntimeType;
  variant: string;
  providerId?: string | null;
  workingDir: string;
  env: ExecutionEnv;
  externalSessionId?: string | null;
  launchClaimNumber?: number;
}

/** `load` restores this transcript; `resume` only continues the agent's native context. */
export type RuntimeResumeMode = 'load' | 'resume';

export interface RuntimeRunTurnInput {
  turnId: string;
  prompt: string;
  msgStore: MsgStore;
  resumeExternalSessionId?: string | null;
  resumeMode?: RuntimeResumeMode;
  /** Local entry that must remain after any history imported by session/load. */
  historyBoundaryEntryId?: string;
  launchClaimNumber?: number;
}

export interface RuntimeTurnOutcome {
  stopReason?: string;
}

export interface DriverTurn {
  completion: Promise<RuntimeTurnOutcome>;
}

export interface DriverSession {
  readonly runtimeInstanceId: string;
  readonly capabilities: RuntimeCapabilities;
  readonly externalSessionId?: string;
  runTurn(input: RuntimeRunTurnInput, sink: RuntimeDriverEventSink): Promise<DriverTurn>;
  cancelTurn(turnId: string): Promise<void>;
  resolvePermission?(requestId: string, optionId: string): Promise<void>;
  writeInput?(data: string): void;
  resize?(cols: number, rows: number): void;
  close(): Promise<void>;
}

export interface RuntimeDriver {
  readonly type: RuntimeType;
  open(input: RuntimeOpenInput, sink: RuntimeDriverEventSink): Promise<DriverSession>;
}

export interface RuntimeRegistry {
  get(runtimeType: RuntimeType): RuntimeDriver;
}

export interface RuntimeCoordinatorHost {
  onTurnEvent(event: RuntimeTurnEventEnvelope): void;
  onRuntimeState(state: RuntimeStateDto): void;
  onProcessEvent(event: RuntimeProcessEvent): Promise<void>;
  onDriverSessionDisposeStarted?(
    towerSessionId: string,
    runtimeInstanceId: string,
    launchClaimNumber?: number,
  ): void | Promise<void>;
  onDriverSessionDisposed?(towerSessionId: string): void;
  onDriverSessionDisposedInstance?(
    towerSessionId: string,
    runtimeInstanceId: string,
    launchClaimNumber?: number,
  ): void | Promise<void>;
  onDriverSessionDisposeFailed?(
    towerSessionId: string,
    runtimeInstanceId: string,
    error: unknown,
    launchClaimNumber?: number,
  ): void | Promise<void>;
}

export interface StartRuntimeTurnInput extends RuntimeOpenInput {
  msgStore: MsgStore;
  prompt: string;
  resumeExternalSessionId?: string | null;
  resumeMode?: RuntimeResumeMode;
  historyBoundaryEntryId?: string;
}

export interface RuntimeTurnHandle {
  turnId: string;
  completion: Promise<RuntimeTurnOutcome>;
}
