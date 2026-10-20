import { randomUUID } from 'node:crypto';
import type { RuntimePermissionRequest } from '@agent-tower/shared';
import type { CliDuplexIO } from '../utils/cli-duplex-channel.js';
import { AgentRuntimeError } from './errors.js';
import { describeCliAction } from './cli-action-summary.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
const error = (code: string, message: string) => new AgentRuntimeError(code, 'permission', message, false);

export { describeCliAction as describeClaudeAction } from './cli-action-summary.js';

/** Claude codec only: public waiting/state belongs to RuntimeCoordinator. */
export class ClaudeCliControl {
  private closed = false;
  private ready = false;
  private readonly controls = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout }>();
  private readonly pending = new Map<string, { nativeId: string; toolId: string; input: ObjectValue; responding: boolean }>();
  private readonly seen = new Set<string>();
  constructor(
    private readonly io: CliDuplexIO,
    private readonly context: { sessionId: string; turnId: string; runtimeInstanceId: string; sensitiveValues?: string[] },
    private readonly callbacks: { requested(request: RuntimePermissionRequest): void; invalidated(id: string): void; failed(error: unknown): void },
  ) {}

  async start(initialInput: string, confirmed: () => void = () => undefined, submission?: { before(): Promise<void>; after(): Promise<void> }): Promise<void> {
    await this.request({ subtype: 'initialize' });
    const mode = await this.request({ subtype: 'set_permission_mode', mode: 'default' });
    if (!object(mode) || mode.mode !== 'default') throw error('permission_mode_unconfirmed', 'Claude did not confirm default permission mode.');
    if (this.closed) throw error('permission_not_found', 'Claude execution has ended.');
    this.ready = true;
    confirmed();
    await submission?.before();
    await this.io.write(initialInput, () => !this.closed);
    await submission?.after();
  }

  handle(message: unknown): void {
    if (this.closed) return;
    try {
      if (!object(message)) throw error('control_protocol_invalid', 'Invalid Claude control message.');
      if (message.type === 'control_response') {
        const response = message.response;
        if (!object(response) || typeof response.request_id !== 'string') throw error('control_protocol_invalid', 'Invalid Claude control response.');
        const pending = this.controls.get(response.request_id);
        if (!pending) return;
        this.controls.delete(response.request_id); clearTimeout(pending.timer);
        if (response.subtype === 'success') pending.resolve(response.response);
        else pending.reject(error('control_request_failed', 'Claude rejected initialization or permission mode configuration.'));
      } else if (message.type === 'control_cancel_request') {
        if (typeof message.request_id !== 'string') throw error('control_protocol_invalid', 'Invalid Claude cancellation.');
        for (const [id, item] of this.pending) if (item.nativeId === message.request_id) this.invalidate(id);
      } else if (message.type === 'control_request') {
        const request = message.request;
        if (!this.ready || typeof message.request_id !== 'string' || !object(request)) throw error('control_protocol_invalid', 'Unexpected Claude control request.');
        if (this.seen.has(message.request_id)) return;
        if (this.seen.size >= 1024 || this.pending.size >= 32) throw error('control_request_limit', 'Claude interaction limit exceeded.');
        this.seen.add(message.request_id);
        if (request.subtype !== 'can_use_tool' || request.requires_user_interaction === true || request.requiresUserInteraction === true
          || ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'].includes(String(request.tool_name))) {
          throw error('native_interaction_unsupported', 'This Claude question, plan confirmation, or native interaction is not supported.');
        }
        if (typeof request.tool_name !== 'string' || typeof request.tool_use_id !== 'string' || !request.tool_use_id || !object(request.input)) {
          throw error('control_protocol_invalid', 'Claude approval request lacks a tool identity or valid input.');
        }
        const id = randomUUID();
        this.pending.set(id, { nativeId: message.request_id, toolId: request.tool_use_id, input: request.input, responding: false });
        this.callbacks.requested({
          requestId: id, ...{ sessionId: this.context.sessionId, turnId: this.context.turnId }, runtimeInstanceId: this.context.runtimeInstanceId,
          toolCallId: request.tool_use_id, toolName: request.tool_name.slice(0, 120), toolSummary: request.tool_name.slice(0, 120),
          actionDetails: describeCliAction(request.input, this.context.sensitiveValues),
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' }],
          createdAt: new Date().toISOString(),
        });
      } else if (String(message.type).startsWith('control_')) {
        throw error('control_protocol_invalid', 'Unknown Claude control message.');
      } else if (message.type === 'system' && message.subtype === 'init' && message.permissionMode !== undefined
        && message.permissionMode !== 'default' && message.permissionMode !== 'manual') {
        throw error('permission_mode_unconfirmed', 'Claude reported a permission mode other than default.');
      }
    } catch (failure) { this.fail(failure); }
  }

  async resolve(requestId: string, optionId: string, authorizeDelivery?: () => void): Promise<void> {
    const item = this.pending.get(requestId);
    if (this.closed || !item || item.responding) throw error('permission_not_found', 'Permission request is no longer active.');
    if (optionId !== 'allow_once' && optionId !== 'reject_once') throw error('permission_option_invalid', 'Permission option was not offered.');
    authorizeDelivery?.();
    item.responding = true;
    try {
      await this.io.write(JSON.stringify({ type: 'control_response', response: {
        subtype: 'success', request_id: item.nativeId, response: optionId === 'allow_once'
          ? { behavior: 'allow', updatedInput: item.input, toolUseID: item.toolId }
          : { behavior: 'deny', message: 'User denied this action', toolUseID: item.toolId },
      } }) + '\n', () => { authorizeDelivery?.(); return !this.closed && this.pending.get(requestId) === item; });
      if (this.closed || this.pending.get(requestId) !== item) throw error('permission_not_found', 'Permission request was cancelled during delivery.');
      this.invalidate(requestId);
    } catch (failure) {
      // Delivery may be uncertain; never replay an allow onto another process.
      if (this.pending.get(requestId) === item && !this.closed) this.fail(error('control_write_failed', 'Claude approval could not be delivered. Execution was stopped.'));
      throw failure;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pending.keys()) this.invalidate(id);
    for (const item of this.controls.values()) { clearTimeout(item.timer); item.reject(error('control_disconnected', 'Claude control channel ended.')); }
    this.controls.clear();
  }
  private invalidate(id: string): void { if (this.pending.delete(id)) this.callbacks.invalidated(id); }
  private fail(failure: unknown): void { this.close(); this.callbacks.failed(failure); }
  private request(request: ObjectValue): Promise<unknown> {
    if (this.closed) return Promise.reject(error('control_disconnected', 'Claude control channel ended.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(error('control_handshake_timeout', 'Claude initialization or permission confirmation timed out.')); }, 15_000);
      this.controls.set(id, { resolve, reject, timer });
      void this.io.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n', () => !this.closed).catch(failure => {
        const item = this.controls.get(id); if (!item) return;
        this.controls.delete(id); clearTimeout(timer); reject(failure);
      });
    });
  }
}
