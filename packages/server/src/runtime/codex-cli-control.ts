import { randomUUID } from 'node:crypto';
import type { ExecutionPermissionMode, RuntimePermissionRequest } from '@agent-tower/shared';
import type { CliDuplexIO } from '../utils/cli-duplex-channel.js';
import type { MsgStore } from '../output/msg-store.js';
import { CodexCliProjector } from './codex-cli-projector.js';
import type { OutputParser } from '../pipeline/agent-pipeline.js';
import { describeCliAction } from './cli-action-summary.js';
import { AgentRuntimeError } from './errors.js';

type ObjectValue = Record<string, any>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const rpcId = (v: unknown): v is string | number => identity(v) || (typeof v === 'number' && Number.isSafeInteger(v));
const key = (id: string | number) => `${typeof id}:${id}`;
const error = (code: string, message: string) => new AgentRuntimeError(code, 'permission', message, false);

export interface CodexCliStart {
  cwd: string;
  resumeThreadId?: string;
  input: Array<{ type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string }>;
}

/** Agent-specific JSONL/RPC codec. The coordinator owns public request state and authorization. */
export class CodexCliControl implements OutputParser {
  private closed = false;
  private ready = false;
  private buffer = '';
  private seq = 0;
  private threadId?: string;
  private nativeTurnId?: string;
  private turnStarting = false;
  private terminal = false;
  private readonly logs: CodexCliProjector;
  private readonly completedListeners = new Set<() => void>();
  private readonly failedListeners = new Set<() => void>();
  private readonly calls = new Map<string, { method: string; resolve(value: any): void; reject(e: unknown): void; timer: NodeJS.Timeout }>();
  private readonly pending = new Map<string, { nativeId: string | number; responding: boolean }>();
  private readonly seen = new Set<string>();
  private readonly items = new Map<string, ObjectValue>();
  private usage?: ObjectValue;
  constructor(
    private readonly io: CliDuplexIO,
    store: MsgStore,
    private readonly context: { sessionId: string; turnId: string; runtimeInstanceId: string; executionPermission: ExecutionPermissionMode; sensitiveValues?: string[] },
    private readonly callbacks: { requested(r: RuntimePermissionRequest): void; invalidated(id: string): void; failed(e: unknown): void },
  ) { this.logs = new CodexCliProjector(store); }

  onTurnCompleted(listener: () => void) { this.completedListeners.add(listener); return () => this.completedListeners.delete(listener); }
  onTurnFailed(listener: () => void) { this.failedListeners.add(listener); return () => this.failedListeners.delete(listener); }

  async start(initialInput: string, confirmed: () => void, submission?: { before(): Promise<void>; after(): Promise<void> }): Promise<void> {
    const spec: CodexCliStart = JSON.parse(initialInput);
    if (!identity(spec.cwd) || !Array.isArray(spec.input)) throw error('control_start_failed', 'Invalid Codex startup input.');
    if (this.context.executionPermission !== 'ASK' && this.context.executionPermission !== 'AUTO_SANDBOX') throw error('control_start_failed', 'Codex app-server requires an authorized interactive permission mode.');
    const reviewer = this.context.executionPermission === 'AUTO_SANDBOX' ? 'auto_review' : 'user';
    await this.request('initialize', { clientInfo: { name: 'codex_exec', title: 'Agent Tower', version: '0.161.0' } });
    await this.io.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n', () => !this.closed);
    const result = await this.request(spec.resumeThreadId ? 'thread/resume' : 'thread/start', {
      ...(spec.resumeThreadId ? { threadId: spec.resumeThreadId, excludeTurns: true } : {}),
      cwd: spec.cwd, approvalPolicy: 'on-request', approvalsReviewer: reviewer, sandbox: 'workspace-write',
    });
    if (!object(result) || result.approvalPolicy !== 'on-request' || result.approvalsReviewer !== reviewer
      || result.sandbox?.type !== 'workspaceWrite'
      || (this.context.executionPermission === 'AUTO_SANDBOX'
        && (result.sandbox.networkAccess !== false || !Array.isArray(result.sandbox.writableRoots)
          || result.sandbox.writableRoots.length !== 0))
      || !identity(result.thread?.id)
      || (spec.resumeThreadId && result.thread.id !== spec.resumeThreadId)) {
      throw error('permission_mode_unconfirmed', `Codex did not confirm on-request, ${reviewer} and the required workspace-write boundary before the task.`);
    }
    this.threadId = result.thread.id;
    this.logs.thread(result.thread.id);
    if (this.closed) throw error('control_disconnected', 'Codex execution has ended.');
    this.ready = true;
    confirmed();
    this.turnStarting = true;
    const started = await this.request('turn/start', { threadId: this.threadId, input: spec.input }, submission);
    if (!identity(started?.turn?.id) || (this.nativeTurnId && started.turn.id !== this.nativeTurnId)) throw error('control_protocol_invalid', 'Codex did not confirm the native turn identity.');
    this.nativeTurnId = started.turn.id;
    this.turnStarting = false;
  }

  processData(data: string): void {
    this.buffer += data;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
    }
    if (this.buffer.length > 8 * 1024 * 1024) { this.buffer = ''; this.fail(error('control_protocol_invalid', 'Codex output frame exceeded its limit.')); }
  }
  finish(exitCode?: number): void {
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = '';
  }
  private line(line: string): void {
    if (!line.trim()) return;
    if (line.length > 8 * 1024 * 1024) { this.fail(error('control_protocol_invalid', 'Codex output frame exceeded its limit.')); return; }
    try { this.handle(JSON.parse(line)); }
    catch { this.fail(error('control_protocol_invalid', 'Invalid Codex app-server JSONL message.')); }
  }

  handle(m: unknown): void {
    try {
      if (!object(m)) throw error('control_protocol_invalid', 'Invalid Codex app-server message.');
      if (m.method === undefined && rpcId(m.id)) {
        const call = this.calls.get(key(m.id)); if (!call) return;
        this.calls.delete(key(m.id)); clearTimeout(call.timer);
        if (m.error) {
          if (this.context.executionPermission === 'AUTO_SANDBOX' && (call.method === 'thread/start' || call.method === 'thread/resume')) {
            call.reject(error('permission_mode_unconfirmed', 'Codex rejected the AUTO_SANDBOX thread configuration (auto_review); no task was sent.'));
          } else if (this.context.executionPermission === 'AUTO_SANDBOX' && call.method === 'turn/start') {
            call.reject(error('control_request_failed', 'Codex rejected turn/start with AUTO_SANDBOX (auto_review) selected; execution stopped.'));
          } else {
            call.reject(error('control_request_failed', 'Codex rejected initialization, thread configuration or turn startup.'));
          }
        }
        else if ('result' in m) {
          // Bind the turn on the response path too, before consuming another
          // buffered notification/request in this same stdout callback.
          if (call.method === 'turn/start') {
            if (!identity(m.result?.turn?.id) || (this.nativeTurnId && this.nativeTurnId !== m.result.turn.id)) {
              call.reject(error('control_protocol_invalid', 'Codex did not confirm the native turn identity.')); return;
            }
            this.nativeTurnId = m.result.turn.id;
          }
          call.resolve(m.result);
        }
        else call.reject(error('control_protocol_invalid', 'Invalid Codex RPC response.'));
        return;
      }
      if (typeof m.method !== 'string' || !object(m.params)) throw error('control_protocol_invalid', 'Invalid Codex notification/request.');
      if (m.id !== undefined) {
        if (this.closed) return;
        this.approval(m); return;
      }
      const p = m.params;
      if (m.method === 'serverRequest/resolved') {
        if (p.threadId === this.threadId && rpcId(p.requestId)) for (const [id, item] of this.pending) if (key(item.nativeId) === key(p.requestId)) this.invalidate(id);
        return;
      }
      // Thread initialization/history and legacy codex/event notifications are not live turn output.
      if (!this.ready || p.threadId !== this.threadId) return;
      if (m.method === 'turn/started') {
        // Response and notification travel independently; either may arrive first.
        if (!identity(p.turn?.id) || (!this.turnStarting && !this.nativeTurnId) || (this.nativeTurnId && this.nativeTurnId !== p.turn.id)) throw error('control_protocol_invalid', 'Unexpected Codex turn identity.');
        this.nativeTurnId = p.turn.id; return;
      }
      if (p.turnId !== undefined && p.turnId !== this.nativeTurnId) return;
      if (m.method === 'item/started' || m.method === 'item/completed') {
        if (!identity(p.item?.id)) throw error('control_protocol_invalid', 'Invalid Codex item identity.');
        if (this.items.size >= 2048 && !this.items.has(p.item.id)) throw error('control_request_limit', 'Codex item limit exceeded.');
        // Keep only the bounded action preview; raw diffs/arguments never enter pending DTOs.
        this.items.set(p.item.id, { type: p.item.type, command: p.item.command, cwd: p.item.cwd,
          paths: Array.isArray(p.item.changes) ? p.item.changes.slice(0, 40).map((c: ObjectValue) => c.path) : [] });
        this.logs.item(p.item, m.method === 'item/completed');
      } else if (['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/plan/delta'].includes(m.method)) {
        if (identity(p.itemId) && typeof p.delta === 'string') this.logs.delta(m.method, p.itemId, p.delta);
      } else if (m.method === 'thread/tokenUsage/updated') {
        this.usage = p.tokenUsage?.last;
        this.logs.usage(this.usage);
      } else if (m.method === 'turn/plan/updated') {
        if (Array.isArray(p.plan)) this.logs.plan(p.plan);
      } else if (m.method === 'error') {
        this.logs.error(p.error?.message ?? 'Codex runtime error');
      } else if (m.method === 'turn/completed') {
        if (p.turn?.id !== this.nativeTurnId || this.terminal) return;
        this.terminal = true;
        for (const id of this.pending.keys()) this.invalidate(id);
        this.logs.usage(this.usage);
        if (p.turn.status === 'completed') for (const listener of [...this.completedListeners]) listener();
        else { this.logs.error(p.turn.error?.message ?? `Codex turn ${String(p.turn.status)}`); for (const listener of [...this.failedListeners]) listener(); }
      }
    } catch (failure) { this.fail(failure); }
  }

  private approval(m: ObjectValue): void {
    const p = m.params;
    if (!this.ready || this.terminal || !rpcId(m.id) || p.threadId !== this.threadId || p.turnId !== this.nativeTurnId || !identity(p.itemId)) throw error('control_protocol_invalid', 'Codex approval lacks the active thread/turn/item identity.');
    // Questions, plans, MCP elicitation and resource grants have different response contracts.
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(m.method)) throw error('native_interaction_unsupported', 'This Codex question, resource grant or native interaction is not supported.');
    if (p.kind != null && !['command', 'writeStdin'].includes(p.kind)) throw error('native_interaction_unsupported', 'Unknown Codex command approval kind.');
    const nativeKey = key(m.id);
    if (this.seen.has(nativeKey)) return;
    if (this.seen.size >= 1024 || this.pending.size >= 32) throw error('control_request_limit', 'Codex approval limit exceeded.');
    if (p.availableDecisions != null && (!Array.isArray(p.availableDecisions) || !p.availableDecisions.includes('accept'))) throw error('native_interaction_unsupported', 'Codex did not offer single-action approval.');
    // This verified v2 build accepts `decline` even when its suggested UI menu
    // lists `cancel` instead. Native deny/resume smoke covers that response.
    // Never send acceptForSession or a policy amendment from an Allow once button.
    if (p.grantRoot) throw error('native_interaction_unsupported', 'Persistent Codex directory grants require a separate approval flow.');
    this.seen.add(nativeKey);
    const preview = this.items.get(p.itemId);
    const isCommand = m.method === 'item/commandExecution/requestApproval';
    const details = describeCliAction({
      command: isCommand && !p.networkApprovalContext ? p.command ?? preview?.command : undefined,
      path: isCommand ? p.cwd ?? preview?.cwd : preview?.paths?.join('\n'),
      description: p.networkApprovalContext ? `Network ${p.networkApprovalContext.protocol}: ${p.networkApprovalContext.host}` : p.reason,
    }, this.context.sensitiveValues);
    const id = randomUUID(); this.pending.set(id, { nativeId: m.id, responding: false });
    this.callbacks.requested({ requestId: id, sessionId: this.context.sessionId, turnId: this.context.turnId,
      runtimeInstanceId: this.context.runtimeInstanceId, toolCallId: p.itemId,
      toolName: isCommand ? 'commandExecution' : 'fileChange', toolSummary: isCommand ? p.kind === 'writeStdin' ? 'Codex terminal input approval' : 'Codex command approval' : 'Codex file change approval', actionDetails: details,
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' }], createdAt: new Date().toISOString() });
  }

  async resolve(requestId: string, optionId: string, authorizeDelivery?: () => void): Promise<void> {
    const item = this.pending.get(requestId);
    if (this.closed || !item || item.responding) throw error('permission_not_found', 'Permission request is no longer active.');
    if (!['allow_once', 'reject_once'].includes(optionId)) throw error('permission_option_invalid', 'Permission option was not offered.');
    authorizeDelivery?.(); item.responding = true;
    try {
      await this.io.write(JSON.stringify({ id: item.nativeId, result: { decision: optionId === 'allow_once' ? 'accept' : 'decline' } }) + '\n', () => {
        authorizeDelivery?.(); return !this.closed && this.pending.get(requestId) === item;
      });
      // Native serverRequest/resolved can precede our transport write ACK.
      if (this.closed && !this.terminal) throw error('permission_not_found', 'Codex execution ended during approval delivery.');
      this.invalidate(requestId);
    } catch (failure) {
      if (!this.closed) this.fail(error('control_write_failed', 'Codex approval delivery was uncertain. Execution was stopped.'));
      throw failure;
    }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const id of this.pending.keys()) this.invalidate(id);
    for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(error('control_disconnected', 'Codex control channel ended.')); }
    this.calls.clear();
  }
  private invalidate(id: string) { if (this.pending.delete(id)) this.callbacks.invalidated(id); }
  private fail(failure: unknown) { if (this.closed) return; this.close(); this.callbacks.failed(failure); }
  private request(method: string, params: ObjectValue, submission?: { before(): Promise<void>; after(): Promise<void> }): Promise<any> {
    if (this.closed) return Promise.reject(error('control_disconnected', 'Codex control channel ended.'));
    const id = `tower-${++this.seq}`;
    let written: Promise<void> = Promise.resolve();
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(key(id)); reject(error('control_handshake_timeout', 'Codex initialization or turn startup timed out.')); }, 15_000);
      this.calls.set(key(id), { method, resolve, reject, timer });
      written = (async () => { await submission?.before(); await this.io.write(JSON.stringify({ id, method, params }) + '\n', () => !this.closed); await submission?.after(); })();
      void written.catch(failure => {
        const call = this.calls.get(key(id)); if (!call) return;
        this.calls.delete(key(id)); clearTimeout(call.timer); reject(failure);
      });
    });
    return Promise.all([response, written]).then(([result]) => result);
  }
}
