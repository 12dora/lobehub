import type {
  SharedOAuthFlowError,
  SharedOAuthPasteError,
  SharedOAuthPasteSource,
} from './useAdminSharedOAuthFlow';

/** Server error literal (K3) → i18n suffix used by the paste form. */
const PASTE_ERROR_MAP: Record<string, SharedOAuthPasteError | 'expired'> = {
  access_token_invalid: 'accessTokenInvalid',
  exchange_failed: 'exchangeFailed',
  expired: 'expired',
  invalid_callback: 'invalidCallback',
  session_invalid: 'sessionInvalid',
  state_mismatch: 'stateMismatch',
  token_not_web: 'tokenNotWeb',
};

/**
 * Server code for "the grant was redeemed but the credentials could not be stored". It arrives
 * on a `denied` poll, so it MUST be split out: the admin did consent, and telling them the
 * provider refused authorization sends them to the wrong fix.
 */
const PROVIDER_STORE_FAILED = 'provider_store_failed';

/** RFC 8628 §3.5: back off by 5s each time the authorization server says slow_down. */
const SLOW_DOWN_STEP_SECONDS = 5;

/**
 * A network blip must not throw away a user code that is still valid: keep polling and
 * only give up once this many consecutive ticks failed. Reset by any server answer.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

interface SharedOAuthPollPayload {
  error?: string | null;
  revision?: number | null;
  status: string;
}

export interface DecideDevicePollTickInput {
  consecutiveFailures: number;
  intervalSeconds: number;
  result?: SharedOAuthPollPayload;
  stale?: boolean;
  threw: boolean;
}

export type DevicePollTickDecision =
  | { kind: 'success'; revision: number | null }
  | { kind: 'fail'; reason: SharedOAuthFlowError }
  | { kind: 'retry'; delaySeconds: number }
  | { kind: 'staleSuccess' }
  | { kind: 'ignore' };

export interface DecidePastePollResultInput {
  result?: SharedOAuthPollPayload;
  source: SharedOAuthPasteSource;
  threw?: boolean;
}

export type PastePollResultDecision =
  | { kind: 'success'; revision: number | null }
  | { kind: 'expired' }
  | { kind: 'fieldError'; error: SharedOAuthPasteError; source: SharedOAuthPasteSource }
  | { kind: 'networkError'; source: SharedOAuthPasteSource };

export const decideDevicePollTick = ({
  consecutiveFailures,
  intervalSeconds,
  result,
  stale,
  threw,
}: DecideDevicePollTickInput): DevicePollTickDecision => {
  if (stale) {
    if (!threw && result?.status === 'success') return { kind: 'staleSuccess' };
    return { kind: 'ignore' };
  }

  if (threw) {
    if (consecutiveFailures + 1 < MAX_CONSECUTIVE_POLL_FAILURES) {
      return { kind: 'retry', delaySeconds: intervalSeconds };
    }
    return { kind: 'fail', reason: 'authError' };
  }

  switch (result?.status) {
    case 'success': {
      return { kind: 'success', revision: result.revision ?? null };
    }
    case 'denied': {
      return {
        kind: 'fail',
        reason: result.error === PROVIDER_STORE_FAILED ? 'providerStoreFailed' : 'denied',
      };
    }
    case 'error': {
      // Terminal, and NOT a poll to repeat: the grant is spent or the envelope is
      // unusable. Falling through to `default` here re-scheduled forever.
      return { kind: 'fail', reason: result.error === 'expired' ? 'codeExpired' : 'authError' };
    }
    case 'expired': {
      return { kind: 'fail', reason: 'codeExpired' };
    }
    case 'slow_down': {
      return { kind: 'retry', delaySeconds: intervalSeconds + SLOW_DOWN_STEP_SECONDS };
    }
    default: {
      return { kind: 'retry', delaySeconds: intervalSeconds };
    }
  }
};

export const decidePastePollResult = ({
  result,
  source,
  threw,
}: DecidePastePollResultInput): PastePollResultDecision => {
  if (threw) return { kind: 'networkError', source };

  if (result?.status === 'success') {
    return { kind: 'success', revision: result.revision ?? null };
  }

  const mapped =
    PASTE_ERROR_MAP[result?.error ?? ''] ??
    (result?.status === 'expired' ? 'expired' : 'authError');

  if (mapped === 'expired') return { kind: 'expired' };

  return { kind: 'fieldError', error: mapped, source };
};
