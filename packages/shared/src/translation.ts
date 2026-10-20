/** Translation covers eligible message bodies only. Thinking and tools are never candidates. */
export type TranslationDirection = 'SEND' | 'DISPLAY';
export type TranslationScopeType = 'SESSION' | 'CONVERSATION' | 'TEAM_RUN' | 'TASK';
export type TranslationSourceKind = 'SESSION_BLOCK' | 'ROOM_MESSAGE' | 'USER_DELIVERY' | 'TASK_INPUT';
export type TranslationBlockState = 'OPEN' | 'SEALED' | 'ABORTED';
export type TranslationJobState =
  | 'OPEN' | 'PENDING' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCESS' | 'NOT_REQUIRED'
  | 'FAILED' | 'CANCELLED' | 'SUPERSEDED' | 'INTERRUPTED' | 'QUEUE_FULL' | 'PAUSED_DISABLED';
export type TranslationAttemptStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'SUPERSEDED' | 'INTERRUPTED';

export type TranslationSecretWrite =
  | { action: 'keep' }
  | { action: 'replace'; value: string }
  | { action: 'clear' };

export interface TranslationSettingsFields {
  enabled: boolean;
  apiBaseUrl: string;
  model: string;
  sendTargetLanguage: string;
  displayTargetLanguage: string;
  promptTemplate: string;
  maxConcurrency: number;
}

export interface TranslationSettingsDraft extends TranslationSettingsFields {
  /** Replace with an empty value explicitly selects a service which requires no credential. */
  apiKey: TranslationSecretWrite;
}

export interface TranslationSettingsUpdate extends TranslationSettingsDraft {
  expectedRevision: number;
}

export interface TranslationPublicSettings extends TranslationSettingsFields {
  id: string;
  revision: number;
  enableEpoch: number;
  credentialRevision: number;
  keyConfigured: boolean;
}

/** Safe to persist on an attempt. It deliberately contains no credential or key write intent. */
export type TranslationSanitizedConfigSnapshot = Omit<TranslationPublicSettings, 'keyConfigured'>;

export interface TranslationSource {
  id: string;
  scopeType: TranslationScopeType;
  scopeId: string;
  sourceKind: TranslationSourceKind;
  sourceKey: string;
  laneKey: string;
  sessionId: string | null;
  turnId: string | null;
  blockId: string | null;
  messageId: string | null;
  deliveryId: string | null;
  direction: TranslationDirection;
  originalText: string;
  sourceRevision: number;
  sourceHash: string;
  blockState: TranslationBlockState;
  jobState: TranslationJobState;
  currentAttemptVersion: number;
  effectiveAttemptId: string | null;
  generation: number;
  enableEpoch: number;
  retryChainId: string | null;
  retryCount: number;
  budgetStartedAt: string | null;
  nextRetryAt: string | null;
  deletedAt: string | null;
  overlayRevision: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationAttempt {
  id: string;
  sourceId: string;
  sourceRevision: number;
  sourceHash: string;
  attemptVersion: number;
  configRevision: number;
  credentialRevision: number;
  targetLanguage: string;
  sanitizedConfigSnapshot: TranslationSanitizedConfigSnapshot;
  protectionVersion: string;
  status: TranslationAttemptStatus;
  resultText: string | null;
  errorCode: string | null;
  generation: number;
  enableEpoch: number;
  retryIndex: number;
  nextRetryAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface TranslationDraftTestRequest {
  draft: TranslationSettingsDraft;
  text: string;
  direction: TranslationDirection;
}

export interface TranslationDraftTestResult {
  resultText: string;
}

export const DEFAULT_TRANSLATION_PROMPT_TEMPLATE = '请将以下内容翻译为 {{target_language}}，保持原意，只返回译文：\n\n{{text}}';
export const DEFAULT_TRANSLATION_MAX_CONCURRENCY = 4;

/** Original transcript facts. No translated text belongs in the log patch stream. */
export interface TextBlockLifecycle {
  turnId: string;
  runtimeGeneration: string;
  streamId: string;
  blockId: string;
  semanticType: 'assistant_message';
  sourceRevision: number;
  state: TranslationBlockState;
  sealedReason?: 'TYPE_SWITCH' | 'EXPLICIT' | 'TURN_END';
  /** Only output observed while enabled is recoverable; absent on static history. */
  translationEpoch?: number;
}

export interface SessionTranslationOverlay {
  sourceId: string;
  sessionId: string;
  turnId: string;
  blockId: string;
  sourceRevision: number;
  overlayRevision: number;
  state: TranslationJobState;
  originalText: string;
  translatedText: string | null;
  targetLanguage: string | null;
  errorCode: string | null;
}

export interface TeamRunTranslationOverlaySummary {
  sourceId: string;
  teamRunId: string;
  messageId: string;
  sourceRevision: number;
  overlayRevision: number;
  state: TranslationJobState;
  originalTextPreview: string;
  originalTextTruncated: boolean;
  translatedTextPreview: string | null;
  translatedTextTruncated: boolean;
  targetLanguage: string | null;
  errorCode: string | null;
}

/** Full text is fetched only when the owner opens an individual overlay. */
export interface TeamRunTranslationOverlay extends Omit<TeamRunTranslationOverlaySummary, 'originalTextPreview' | 'originalTextTruncated' | 'translatedTextPreview' | 'translatedTextTruncated'> {
  originalText: string;
  translatedText: string | null;
}

export const TEAM_RUN_TRANSLATION_PREVIEW_LENGTH = 2000;
export const TEAM_RUN_TRANSLATION_MAX_MESSAGE_IDS = 100;

export interface SessionTranslationInvalidatedPayload {
  sessionId: string;
  teamRunId?: never;
  messageId?: never;
  sourceId: string;
  sourceRevision: number;
  overlayRevision: number;
}

export interface TeamRunTranslationInvalidatedPayload {
  teamRunId: string;
  messageId: string;
  sessionId?: never;
  sourceId: string;
  sourceRevision: number;
  overlayRevision: number;
}

/** Invalidation only; REST remains authoritative. The Session branch stays wire compatible. */
export type TranslationInvalidatedPayload = SessionTranslationInvalidatedPayload | TeamRunTranslationInvalidatedPayload;

export type MessageDeliveryState = 'WAITING_TRANSLATION' | 'WAITING_TASK_INPUT' | 'READY' | 'WAITING_PREDECESSOR' | 'ACCEPTED' | 'DISPATCHING' | 'SENT' | 'TRANSLATION_FAILED' | 'PAUSED_DISABLED' | 'DELIVERY_FAILED' | 'DELIVERY_UNKNOWN' | 'CANCELLED';
export type MessageDeliveryAction = 'retry_translation' | 'send_original' | 'retry_delivery' | 'cancel' | 'confirm_not_sent' | 'end_unknown';
interface MessageDeliveryCommon {
  id: string;
  clientSubmissionId: string;
  channelKey: string;
  sequence: number;
  originalText: string;
  attachmentIds: string[];
  state: MessageDeliveryState;
  sentMode: 'TRANSLATED' | 'ORIGINAL' | null;
  acceptedText: string | null;
  actualSentText: string | null;
  sentAt: string | null;
  acceptedDestinationId: string | null;
  lastError: string | null;
  revision: number;
  createdAt: string;
  taskInputSnapshotId?: string | null;
  dependencySummary?: { snapshotId: string; state: string; errorCode: string | null } | null;
}
export type SessionDeliveryDestination = { kind: 'SESSION'; sessionId: string };
export type ConversationDeliveryDestination = { kind: 'CONVERSATION'; conversationId: string; sessionId: string };
export type TeamRoomDeliveryDestination = { kind: 'TEAM_ROOM'; taskId: string; teamRunId: string };
export type PendingTeamRoomDeliveryDestination = { kind: 'TEAM_ROOM_PENDING'; taskId: string; plannedTeamRunId: string };
export type SessionMessageDelivery = MessageDeliveryCommon & (
  | { origin: 'TASK_INITIAL' | 'TASK_FOLLOWUP'; destination: SessionDeliveryDestination; sessionId: string; conversationId: null }
  | { origin: 'CONVERSATION'; destination: ConversationDeliveryDestination; sessionId: string; conversationId: string }
);
export type TeamMessageDelivery = MessageDeliveryCommon & { sessionId?: never; conversationId?: never } & (
  | { origin: 'TEAM_USER'; destination: TeamRoomDeliveryDestination }
  | { origin: 'TEAM_INITIAL'; destination: PendingTeamRoomDeliveryDestination }
  | { origin: 'TEAM_INITIAL'; destination: TeamRoomDeliveryDestination }
);
export type MessageDelivery = SessionMessageDelivery | TeamMessageDelivery;
export function isSessionMessageDelivery(delivery: MessageDelivery): delivery is SessionMessageDelivery {
  return delivery.origin === 'TASK_INITIAL' || delivery.origin === 'TASK_FOLLOWUP' || delivery.origin === 'CONVERSATION';
}
/** HTTP 202 is durable acceptance; SENT confirms publication, never member execution. */
type SubmissionFor<D extends MessageDelivery> = D extends MessageDelivery ? { operationId: string; state: MessageDeliveryState; destination: D['destination']; delivery: D } & (
  D extends SessionMessageDelivery ? { destinationId: string; sessionId: string }
  : D['destination'] extends PendingTeamRoomDeliveryDestination ? { destinationId?: never; sessionId?: never }
  : { destinationId: string; sessionId?: never }
) : never;
export type SessionMessageDeliverySubmission = SubmissionFor<SessionMessageDelivery>;
export type MessageDeliverySubmission = SubmissionFor<MessageDelivery>;
export interface MessageDeliveryPage { items: MessageDelivery[]; nextCursor: string | null }
export type MessageDeliveryInvalidatedPayload = { sessionId: string; taskId?: never; teamRunId?: never; operationId: string; deliveryRevision: number }
  | { taskId: string; teamRunId?: string; sessionId?: never; operationId: string; deliveryRevision: number };
export interface TeamTaskInputSummary {
  id: string; teamRunId: string; taskId: string; taskSourceHash: string; state: 'PENDING' | 'ACCEPTED'; revision: number;
  sentMode: 'ORIGINAL' | 'TRANSLATED' | null; acceptedAt: string | null; translationState: string | null; errorCode: string | null; consumerCount: number;
}
export interface TeamTaskInputDetail extends TeamTaskInputSummary { originalText: string; effectiveUserText: string | null }
export interface AgentTeamTaskInput {
  teamRunId: string; taskId: string; invocationId: string; snapshotId: string; taskSourceHash: string; acceptedAt: string;
  sentMode: 'ORIGINAL' | 'TRANSLATED'; effectiveUserText: string; isTruncated: boolean; fullContentAvailable: boolean;
}
