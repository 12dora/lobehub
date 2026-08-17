/** Backoff before attempts 2, 3, 4. Short: the challenge clears on the next call, not in a minute. */
export const SESSION_RETRY_DELAYS_MS = [400, 900, 1600];
/** Up to +30 %, so a fleet of instances retrying at once does not resonate. */
export const SESSION_RETRY_JITTER = 0.3;

/** Why an attempt failed — for the debug log only. Never carries response content. */
export type SessionFailureClass =
  'challenge' | 'forbidden' | 'network' | 'rate_limit' | 'server_error';

/**
 * An attempt that failed in a way the NEXT attempt could plausibly survive. Deliberately a
 * distinct class rather than a flag: the retry loop must not swallow a terminal outcome
 * (a dead session) or an operator problem (missing transport binary) by mistake.
 *
 * The message is composed locally from the status/error class only — provider prose never
 * crosses this boundary — so it stays safe to surface and to log.
 */
export class ChatGPTWebSessionRetryableError extends Error {
  /**
   * A rotation the failed attempt had ALREADY received. next-auth invalidates the presented
   * value the moment it rotates, so a later attempt must present this one instead — retrying
   * the value the upstream just replaced would turn a transient failure into a dead session.
   */
  readonly rotatedSessionToken?: string;

  constructor(
    readonly classification: SessionFailureClass,
    message: string,
    options?: { cause?: unknown; rotatedSessionToken?: string },
  ) {
    super(message, options);
    this.name = 'ChatGPTWebSessionRetryableError';
    this.rotatedSessionToken = options?.rotatedSessionToken;
  }
}

/**
 * Statuses worth another call: the Cloudflare challenge, an explicit rate limit, the
 * "retry this request" 4xx pair, and every server-side failure. Anything else is still
 * transient for the caller (it never marks the session dead) but retrying it is pointless.
 */
export const isRetryableSessionStatus = (status: number): boolean =>
  status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;

export const classifySessionStatus = (response: Response): SessionFailureClass => {
  if (response.status === 429) return 'rate_limit';
  if (response.status >= 500) return 'server_error';
  // Cloudflare marks its own interception; a bare 403 is something else entirely.
  return response.headers.get('cf-mitigated') === 'challenge' ? 'challenge' : 'forbidden';
};

/** Backoff that gives up the moment the overall budget is spent, instead of overrunning it. */
export const sleepWithinBudget = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
