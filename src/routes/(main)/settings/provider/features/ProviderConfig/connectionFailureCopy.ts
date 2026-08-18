/**
 * One table for "why did talking to this provider fail", shared by every surface that reports
 * it: the connectivity checker, and the upstream model sync.
 *
 * Both read the same stable server codes, so they must not drift into two vocabularies — an
 * operator who reconnects an account because the checker said so should not be told
 * "configuration validation failed" by the sync button one click later.
 */

/**
 * Stable reasons the platform probe reports. They are actionable by the operator, so they get
 * translated copy instead of the server's terse sanitized string — which was server-authored
 * English rendered verbatim in every locale. Matched loosely (case/punctuation-insensitive) so
 * the wording can evolve server-side without silently falling back to the generic message.
 *
 * The `connection_failed_*` entries are the probe's current stable codes; the sentence forms
 * below are the pre-code messages, still returned for connection tests persisted before the
 * codes landed (`testProvider` replays the stored `sanitizedMessage` for a superseded attempt).
 *
 * Keys are in the `setting` namespace.
 */
export const CHECK_MODEL_REASON_KEYS: Record<string, string> = {
  check_model_not_configured: 'llm.checker.reason.checkModelNotConfigured',
  check_model_not_enabled: 'llm.checker.reason.checkModelNotEnabled',
  connection_failed_auth: 'llm.checker.reason.connectionFailedAuth',
  connection_failed_authentication_rejected: 'llm.checker.reason.connectionFailedAuth',
  connection_failed_invalid_config: 'llm.checker.reason.connectionFailedInvalidConfig',
  connection_failed_invalid_provider_configuration:
    'llm.checker.reason.connectionFailedInvalidConfig',
  connection_failed_network: 'llm.checker.reason.connectionFailedNetwork',
  connection_failed_provider: 'llm.checker.reason.connectionFailedProvider',
  connection_failed_provider_network_unavailable: 'llm.checker.reason.connectionFailedNetwork',
  connection_failed_provider_rate_limit_reached: 'llm.checker.reason.connectionFailedRateLimit',
  connection_failed_provider_rejected_the_request: 'llm.checker.reason.connectionFailedProvider',
  connection_failed_rate_limit: 'llm.checker.reason.connectionFailedRateLimit',
  /**
   * Its own code, not a flavour of `auth`: only the persisted `sanitizedMessage` survives a
   * superseded (CAS-losing) attempt, so the reconnect guidance has to live in the code itself.
   */
  connection_failed_shared_account_expired: 'llm.checker.reason.sharedAccountExpired',
  connection_failed_the_shared_account_connection_expired_reconnect_it:
    'llm.checker.reason.sharedAccountExpired',
  /**
   * Its own code, not a flavour of `invalid_config`: nothing in the provider's settings is
   * wrong — a server-side component the transport needs (curl-impersonate) is not installed,
   * and only an administrator can fix it. Telling the user to check their configuration would
   * send them down a road with no exit.
   */
  connection_failed_transport: 'llm.checker.reason.connectionFailedTransport',
};

/**
 * Runtime codes worth their own copy regardless of category. A dead shared grant is the one
 * failure whose fix ("reconnect the account") is not implied by the category message.
 */
export const CHECK_ERROR_TYPE_KEYS: Record<string, string> = {
  OAuthAuthorizationExpired: 'llm.checker.reason.sharedAccountExpired',
};

export const normalizeReason = (message: string): string =>
  message
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');

interface ConnectionFailureSignals {
  /** Coarse bucket the server classified the failure into (`auth`, `network`, …). */
  errorCategory?: string | null;
  /** Runtime error name, when the server kept one. */
  errorType?: string | null;
  /** The stable `connection_failed_*` code, or a legacy sanitized sentence. */
  message?: string | null;
}

/**
 * The `setting` locale key describing the failure, or `undefined` when nothing on the error
 * is recognisable — callers decide what an unrecognised failure reads as, and none of them
 * may fall back to the server string itself.
 *
 * Category is the last resort on purpose: it is the coarsest signal, and only useful when a
 * server dropped the code (older payloads carry `errorCategory` without a message).
 */
export const connectionFailureReasonKey = ({
  errorCategory,
  errorType,
  message,
}: ConnectionFailureSignals): string | undefined =>
  (errorType ? CHECK_ERROR_TYPE_KEYS[errorType] : undefined) ??
  (message ? CHECK_MODEL_REASON_KEYS[normalizeReason(message)] : undefined) ??
  (errorCategory
    ? CHECK_MODEL_REASON_KEYS[`connection_failed_${normalizeReason(errorCategory)}`]
    : undefined);
