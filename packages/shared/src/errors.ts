/**
 * Typed application errors. Every layer throws these instead of bare Errors so the
 * API can map them to stable HTTP responses and the agent can explain failures safely.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'POLICY_VIOLATION'
  | 'CONFIRMATION_INVALID'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  POLICY_VIOLATION: 422,
  CONFIRMATION_INVALID: 422,
  PROVIDER_ERROR: 502,
  PROVIDER_NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.details = options.details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not allowed') {
    super('FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super('NOT_FOUND', id ? `${entity} '${id}' not found` : `${entity} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, { details });
  }
}

/** A business rule or financial guardrail refused the action. */
export class PolicyViolationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('POLICY_VIOLATION', message, { details });
  }
}

/** An external provider (PayPal, LLM, ASR, WhatsApp gateway) failed. */
export class ProviderError extends AppError {
  constructor(
    public readonly provider: string,
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super('PROVIDER_ERROR', `${provider}: ${message}`, options);
  }
}

/** A provider is required for this operation but no credentials are configured. */
export class ProviderNotConfiguredError extends AppError {
  constructor(provider: string, hint?: string) {
    super('PROVIDER_NOT_CONFIGURED', `${provider} is not configured${hint ? ` (${hint})` : ''}`);
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
