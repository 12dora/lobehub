import type { ILobeAgentRuntimeErrorType } from '@lobechat/types';

import { AgentRuntimeErrorType } from '../../types/error';

export type ChatGPTWebErrorKind =
  | 'auth'
  | 'cloudflare'
  | 'rate_limit'
  | 'permission'
  | 'not_found'
  | 'network'
  | 'timeout'
  | 'pow'
  | 'arkose'
  | 'upstream'
  | 'content_policy'
  | 'model_cap'
  | 'transport_unavailable';

export interface ChatGPTWebErrorOptions {
  body?: unknown;
  cause?: unknown;
  /** Stable machine code a downstream classifier can match on. */
  code?: string;
  retryAfterMs?: number;
  status?: number;
}

/**
 * The only fields a diagnostic body may keep. Everything else is dropped —
 * upstream payloads carry sentinel tokens (`so_token`, `token`, `proof`), signed
 * blob URLs (`upload_url`, `download_url`) and conversation content, and an
 * `Error` is routinely serialized whole (`JSON.stringify(error)`), logged, and
 * forwarded to the client.
 */
const SAFE_BODY_FIELDS = new Set(['status', 'code', 'detail', 'type', 'message']);

const MAX_BODY_FIELD_LENGTH = 500;

/** `"…_token": "…"` / `"upload_url": "…"` inside a raw JSON body string. */
const SENSITIVE_JSON_FIELD_RE =
  /("[\w-]*(?:token|secret|password|proof|signature|authorization|cookie|url)[\w-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

const redactBodyString = (value: string): string =>
  value
    .replaceAll(SENSITIVE_JSON_FIELD_RE, '$1"<redacted>"')
    .replaceAll(/https?:\/\/\S+/gi, '<redacted url>')
    .slice(0, MAX_BODY_FIELD_LENGTH);

/**
 * Strip anything credential- or content-bearing off a value before it is
 * attached to an error. Objects keep only {@link SAFE_BODY_FIELDS} scalars;
 * strings keep at most {@link MAX_BODY_FIELD_LENGTH} redacted characters;
 * everything else is dropped entirely.
 */
export const sanitizeErrorBody = (body: unknown): unknown => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return redactBodyString(body) || undefined;
  if (typeof body === 'number' || typeof body === 'boolean') return body;
  if (typeof body !== 'object' || Array.isArray(body)) return undefined;

  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!SAFE_BODY_FIELDS.has(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
    else if (typeof value === 'string') safe[key] = redactBodyString(value);
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
};

export class ChatGPTWebError extends Error {
  readonly kind: ChatGPTWebErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly body?: unknown;
  readonly code?: string;

  constructor(kind: ChatGPTWebErrorKind, message: string, options: ChatGPTWebErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChatGPTWebError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    // sanitized HERE rather than at every call site: an error is the one object
    // that always escapes — serialized, logged, forwarded to the client
    this.body = sanitizeErrorBody(options.body);
    this.code = options.code;
  }
}

/**
 * The code the server transport (`curlImpersonateFetch`) stamps on its
 * "binary missing" error. Matched by duck typing so this package keeps no
 * dependency on `apps/server`.
 */
export const TRANSPORT_UNAVAILABLE_CODE = 'CHATGPT_WEB_TRANSPORT_UNAVAILABLE';

export const isTransportUnavailable = (error: unknown): boolean => {
  const candidate = error as { code?: unknown; name?: unknown } | undefined;
  return (
    candidate?.code === TRANSPORT_UNAVAILABLE_CODE ||
    candidate?.name === 'ChatGPTWebTransportUnavailableError'
  );
};

export const isChatGPTWebError = (error: unknown): error is ChatGPTWebError =>
  error instanceof ChatGPTWebError;

/**
 * `Retry-After: 0` is meaningful (retry immediately) — never coerce it away with
 * a falsy check.
 */
export const parseRetryAfterMs = (value: string | null | undefined): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed) * 1000;
};

const looksLikeHtml = (body: string | undefined, contentType: string | null | undefined) => {
  if (contentType && contentType.toLowerCase().includes('text/html')) return true;
  if (!body) return false;
  const head = body.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<');
};

const truncate = (value: string | undefined, max = 500) =>
  value && value.length > max ? `${value.slice(0, max)}…` : value;

export interface ClassifyResponseInput {
  bodyText?: string;
  context: string;
  headers?: Headers;
  status: number;
}

/**
 * Upstream markers that mean "this access token is dead" regardless of the HTTP
 * status — `POST /backend-api/conversation` answers 400/403 with these in the
 * body instead of a 401 (E2 §4.7).
 */
const AUTH_BODY_MARKERS = [
  'token_expired',
  'token_invalidated',
  'token_revoked',
  'authentication token has been invalidated',
  'invalidated oauth token',
];

const MODEL_CAP_BODY_MARKER = 'model_cap_exceeded';

/**
 * Scan a response body for a known error marker. Only the marker name ever
 * reaches the error message — the body itself may carry conversation content and
 * is never interpolated.
 */
export const classifyBodySignal = (
  bodyText: string | undefined,
): 'auth' | 'model_cap' | undefined => {
  if (!bodyText) return undefined;
  const lower = bodyText.toLowerCase();
  if (AUTH_BODY_MARKERS.some((marker) => lower.includes(marker))) return 'auth';
  if (lower.includes(MODEL_CAP_BODY_MARKER)) return 'model_cap';
  return undefined;
};

/**
 * Map an upstream HTTP response to a typed error. Response bodies are truncated
 * and never contain credentials (the caller must not pass token-endpoint bodies
 * in here).
 */
export const classifyResponseError = ({
  bodyText,
  context,
  headers,
  status,
}: ClassifyResponseInput): ChatGPTWebError => {
  const base = { body: truncate(bodyText), status };
  const message = `${context} failed: status=${status}`;

  // Body-signalled failures win over the status: the conversation endpoint
  // answers 400/403 for a dead token and for a model cap.
  const signal = classifyBodySignal(bodyText);
  if (signal === 'auth')
    return new ChatGPTWebError('auth', `${message} (access token no longer valid)`, base);
  if (signal === 'model_cap')
    return new ChatGPTWebError('model_cap', `${message} (model usage cap reached)`, base);

  if (status === 401) return new ChatGPTWebError('auth', `${message} (unauthorized)`, base);

  if (status === 403) {
    const mitigated = headers?.get('cf-mitigated');
    if (mitigated || looksLikeHtml(bodyText, headers?.get('content-type')))
      return new ChatGPTWebError(
        'cloudflare',
        `${message} (blocked by Cloudflare bot protection)`,
        base,
      );
    return new ChatGPTWebError('permission', `${message} (forbidden)`, base);
  }

  if (status === 429)
    return new ChatGPTWebError('rate_limit', `${message} (rate limited)`, {
      ...base,
      retryAfterMs: parseRetryAfterMs(headers?.get('retry-after')),
    });

  if (status === 404) return new ChatGPTWebError('not_found', `${message} (not found)`, base);

  return new ChatGPTWebError('upstream', message, base);
};

/**
 * Wrap a thrown fetch/abort error into the typed hierarchy.
 *
 * NOTE: a *caller* cancellation must never reach this function — the transport
 * layer re-throws the caller's own abort reason untouched so `AbortError`
 * semantics survive up the stack ({@link isCallerAbort}). Only our internal
 * deadline / idle timers land in the `timeout` kind here.
 */
export const classifyTransportError = (error: unknown, context: string): ChatGPTWebError => {
  if (isChatGPTWebError(error)) return error;

  const name = (error as { name?: string } | undefined)?.name;
  const rawMessage = error instanceof Error ? error.message : String(error);

  // The server-side curl-impersonate adapter throws when its binary is missing.
  // Duck-typed on purpose: `packages/model-runtime` must not import from
  // `apps/server`. The message is actionable and carries no secret.
  if (isTransportUnavailable(error))
    return new ChatGPTWebError('transport_unavailable', rawMessage, {
      body: { code: TRANSPORT_UNAVAILABLE_CODE },
      cause: error,
      code: TRANSPORT_UNAVAILABLE_CODE,
    });

  if (name === 'AbortError' || name === 'TimeoutError')
    return new ChatGPTWebError('timeout', `${context} aborted: ${rawMessage}`, { cause: error });

  return new ChatGPTWebError('network', `${context} network error: ${rawMessage}`, {
    cause: error,
  });
};

/**
 * The abort reason of a caller-owned signal, ready to be re-thrown as-is (a
 * `DOMException: AbortError` in every runtime we target). Returns `undefined`
 * when the signal did not fire, so the caller can fall through to its own
 * classification.
 */
export const callerAbortReason = (signal: AbortSignal | undefined): unknown => {
  if (!signal?.aborted) return undefined;
  if (signal.reason !== undefined && signal.reason !== null) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
};

export const isCallerAbort = (signal: AbortSignal | undefined): boolean => !!signal?.aborted;

const ERROR_TYPE_BY_KIND: Record<ChatGPTWebErrorKind, ILobeAgentRuntimeErrorType> = {
  arkose: AgentRuntimeErrorType.ProviderBizError,
  auth: AgentRuntimeErrorType.OAuthAuthorizationExpired,
  cloudflare: AgentRuntimeErrorType.ProviderBizError,
  content_policy: AgentRuntimeErrorType.ProviderContentPolicyViolation,
  // the upstream refuses this model for this account/plan — surface it as a
  // model problem so the UI can suggest switching to `auto`
  model_cap: AgentRuntimeErrorType.ModelNotFound,
  network: AgentRuntimeErrorType.ProviderBizError,
  not_found: AgentRuntimeErrorType.ProviderBizError,
  permission: AgentRuntimeErrorType.PermissionDenied,
  pow: AgentRuntimeErrorType.ProviderBizError,
  rate_limit: AgentRuntimeErrorType.RateLimitExceeded,
  timeout: AgentRuntimeErrorType.ProviderNetworkError,
  transport_unavailable: AgentRuntimeErrorType.ProviderBizError,
  upstream: AgentRuntimeErrorType.ProviderBizError,
};

/** Pure mapping table — no imports from the runtime layer, no cycles. */
export const toAgentRuntimeErrorType = (error: unknown): ILobeAgentRuntimeErrorType =>
  isChatGPTWebError(error)
    ? ERROR_TYPE_BY_KIND[error.kind]
    : AgentRuntimeErrorType.ProviderBizError;
