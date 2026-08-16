import type {
  ModerationCategory,
  ModerationClassifierKind,
} from '@/const/platform/contentModeration';

export interface ClassifierResult {
  latencyMs: number;
  raw?: unknown;
  scores: Record<ModerationCategory, number>;
}

export interface Classifier {
  classify: (text: string, signal?: AbortSignal) => Promise<ClassifierResult>;
  kind: ModerationClassifierKind;
}

/** Classifier returned garbage / a partial schema. Never treat as all-zero scores. */
export class ClassifierInvalidResponseError extends Error {
  readonly retryable = false;

  constructor(message = 'CLASSIFIER_INVALID_RESPONSE') {
    super(message);
    this.name = 'ClassifierInvalidResponseError';
  }
}

export const CLASSIFIER_ERROR_CODES = [
  'timeout',
  'unauthorized',
  'rate_limited',
  'upstream_error',
  'invalid_response',
  'not_configured',
  'aborted',
] as const;

export type ClassifierErrorCode = (typeof CLASSIFIER_ERROR_CODES)[number];

const CLASSIFIER_ERROR_CODE_SET = new Set<string>(CLASSIFIER_ERROR_CODES);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Map any classifier failure to a finite code. The code is the only thing
 * that may be persisted or logged — never `error.message`.
 *
 * Shared by production `evaluatePrompt` and the admin dry-run path.
 */
export const toClassifierErrorCode = (error: unknown): ClassifierErrorCode => {
  if (error instanceof ClassifierInvalidResponseError) return 'invalid_response';

  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'aborted';
    if (error.name === 'TimeoutError') return 'timeout';
    if (CLASSIFIER_ERROR_CODE_SET.has(error.message)) {
      return error.message as ClassifierErrorCode;
    }
  }

  if (typeof error === 'string' && CLASSIFIER_ERROR_CODE_SET.has(error)) {
    return error as ClassifierErrorCode;
  }

  const message = messageOf(error);
  const statusMatch = /MODERATIONS_API_(\d+)/.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429 || status === 529) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 400) return 'invalid_response';

  if (
    message.includes('CLASSIFIER_NOT_CONFIGURED') ||
    message.includes('NOT_CONFIGURED') ||
    message.includes('NO_KEYS') ||
    message.includes('SECRET_UNAVAILABLE') ||
    message.includes('MODEL_NOT_PUBLISHED') ||
    message.includes('RUNTIME_UNAVAILABLE') ||
    /not_configured/i.test(message)
  ) {
    return 'not_configured';
  }

  if (message.includes('ALL_KEYS_FROZEN') || /rate.?limit/i.test(message)) {
    return 'rate_limited';
  }

  if (/unauthorized|forbidden/i.test(message)) return 'unauthorized';
  if (/timeout/i.test(message)) return 'timeout';
  if (/invalid_response|JSON|parse|RUNTIME_UNSUPPORTED/i.test(message)) {
    return 'invalid_response';
  }

  return 'upstream_error';
};
