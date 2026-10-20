/** Deliberately contains no provider response, URL, request body or credentials. */
export class TranslationError extends Error {
  readonly errorCode: TranslationErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    errorCode: TranslationErrorCode,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(errorCode);
    this.name = 'TranslationError';
    this.errorCode = errorCode;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type TranslationErrorCode =
  | 'INTERNAL_ERROR'
  | 'INVALID_CONFIG'
  | 'INVALID_TEMPLATE'
  | 'PAYLOAD_TOO_LARGE'
  | 'PROTECTION_FAILED'
  | 'EMPTY_RESPONSE'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'TRUNCATED_RESPONSE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'AUTH_FAILED'
  | 'MODEL_CONFIG_ERROR'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR';
