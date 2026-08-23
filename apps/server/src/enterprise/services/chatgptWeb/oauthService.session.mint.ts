import { isBrowserSessionResettingError } from '@/server/enterprise/services/browserSession/types';

import type { RotatedSessionCookie } from './sessionCookie';
import { seedChatGPTWebSessionJar } from './sessionCookie';
import {
  ChatGPTWebSessionRetryableError,
  classifySessionStatus,
  isRetryableSessionStatus,
} from './sessionRetry';
import { isChatGPTWebTransportUnavailableError } from './transport';

export interface WebSessionMint {
  accessToken: string;
  email?: string;
  /** Chunk layout that still joins to `sessionToken`, when we have one. */
  sessionChunks?: string[];
  /** Epoch millis from the response's `expires`, when parseable. */
  sessionExpiresAt?: number;
  /** Rotated cookie value when the response carried one, else the presented token. */
  sessionToken: string;
}

export interface MintSessionBody {
  accessToken?: unknown;
  expires?: unknown;
  user?: { email?: unknown } | null;
}

/**
 * Carry a rotation the loop adopted into the error that leaves this method.
 *
 * The last attempt may itself have failed WITHOUT a Set-Cookie (the rotation
 * arrived on an earlier try). The loop already swapped `sessionToken` locally;
 * this makes that value visible to the refresh persist path.
 */
export const attachAdoptedSessionRotation = (
  error: ChatGPTWebSessionRetryableError,
  sessionToken: string,
  sessionChunks: readonly string[] | undefined,
): ChatGPTWebSessionRetryableError => {
  if (error.rotatedSessionToken === sessionToken) return error;
  return new ChatGPTWebSessionRetryableError(error.classification, error.message, {
    cause: error,
    ...(sessionChunks ? { rotatedSessionChunks: sessionChunks } : {}),
    rotatedSessionToken: sessionToken,
  });
};

export const rotatedRetryFields = (
  rotated: RotatedSessionCookie | undefined,
): {
  rotatedSessionChunks?: readonly string[];
  rotatedSessionToken?: string;
} =>
  rotated
    ? {
        ...(rotated.chunks ? { rotatedSessionChunks: rotated.chunks } : {}),
        rotatedSessionToken: rotated.token,
      }
    : {};

export const rethrowMintCookieJarKeyError = (error: unknown): never => {
  if (isBrowserSessionResettingError(error)) {
    throw new ChatGPTWebSessionRetryableError(
      'network',
      'ChatGPT Web session request failed: network error',
      { cause: error },
    );
  }
  throw error;
};

/**
 * The annotation is on the CONST, not just the arrow: TypeScript only treats a call as
 * never-returning — and so only keeps `response` definitely-assigned in the caller's try/catch —
 * when the callee is a name with an explicit type annotation.
 */
export const throwMintTransportFailure: (error: unknown, signal: AbortSignal) => never = (
  error,
  signal,
) => {
  // A missing transport binary is an operator problem, not a dead session — let it out.
  if (isChatGPTWebTransportUnavailableError(error)) throw error;
  if (isBrowserSessionResettingError(error)) {
    throw new ChatGPTWebSessionRetryableError(
      'network',
      'ChatGPT Web session request failed: network error',
      { cause: error },
    );
  }
  const message = `ChatGPT Web session request failed: ${error instanceof Error ? error.name : 'network error'}`;
  // The WHOLE budget is spent (caller deadline / refresh lease): another attempt would
  // be dead on arrival, and on the refresh path it would run past the lease.
  if (signal.aborted) throw new Error(message, { cause: error });
  // A per-attempt timeout or a network blip: worth one more call.
  throw new ChatGPTWebSessionRetryableError('network', message, { cause: error });
};

export const rejectMintHttpFailure = async (
  response: Response,
  onInvalidSession: () => never,
  rotated: RotatedSessionCookie | undefined,
): Promise<never> => {
  await response.body?.cancel().catch(() => undefined);
  // 401 is the only status that means "this session is gone".
  if (response.status === 401) onInvalidSession();
  const message = `ChatGPT Web session request failed: ${response.status}`;
  if (!isRetryableSessionStatus(response.status)) throw new Error(message);
  throw new ChatGPTWebSessionRetryableError(classifySessionStatus(response), message, {
    ...rotatedRetryFields(rotated),
  });
};

/**
 * A body that cannot be READ is not an answer about the session.
 *
 * Collapsing it into `{}` used to make a dropped connection, a truncated response or a
 * Cloudflare interstitial served with a 200 indistinguishable from "this session mints
 * nothing" — i.e. TERMINAL, which kills a shared credential every user depends on and
 * demands an operator reconnect for a network blip. Only a body we actually parsed can
 * answer that question; anything else is transient and gets another attempt.
 */
export const readMintSessionBody = async (
  response: Response,
  signal: AbortSignal,
  rotated: RotatedSessionCookie | undefined,
): Promise<MintSessionBody> => {
  try {
    return (await response.json()) as MintSessionBody;
  } catch (error) {
    const message = 'ChatGPT Web session response could not be read';
    // The whole budget is spent: another attempt would be dead on arrival, and on the
    // refresh path it would run past the shared lease.
    if (signal.aborted) throw new Error(message, { cause: error });
    throw new ChatGPTWebSessionRetryableError('network', message, {
      cause: error,
      // If this attempt already rotated the cookie, the presented one is gone: the retry
      // must present the rotation, not the value the upstream just invalidated.
      ...rotatedRetryFields(rotated),
    });
  }
};

export const assembleWebSessionMint = (
  body: MintSessionBody,
  onInvalidSession: () => never,
  presented: { sessionChunks?: readonly string[]; sessionToken: string },
  rotated: RotatedSessionCookie | undefined,
): WebSessionMint => {
  const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
  // An unauthenticated session answers 200 with a PARSED `{}` or warning-only banner body —
  // the session really is gone, so this one is terminal.
  if (!accessToken) onInvalidSession();

  const email =
    typeof body?.user?.email === 'string' && body.user.email.length > 0
      ? body.user.email
      : undefined;
  const expires = typeof body?.expires === 'string' ? Date.parse(body.expires) : Number.NaN;
  const sessionToken = rotated?.token ?? presented.sessionToken;
  const sessionChunks = rotated ? rotated.chunks : presented.sessionChunks;

  return {
    accessToken,
    ...(email ? { email } : {}),
    ...(sessionChunks && sessionChunks.length > 1 ? { sessionChunks: [...sessionChunks] } : {}),
    ...(Number.isFinite(expires) ? { sessionExpiresAt: expires } : {}),
    sessionToken,
  };
};

export const reseedMintSessionJar = (
  cookieJarKey: string | undefined,
  deviceId: string | undefined,
  sessionToken: string,
  sessionChunks: readonly string[] | undefined,
  jarStillWritable: () => boolean,
): void => {
  if (cookieJarKey && jarStillWritable()) {
    seedChatGPTWebSessionJar(cookieJarKey, sessionToken, sessionChunks, deviceId);
  } else if (deviceId && jarStillWritable()) {
    seedChatGPTWebSessionJar(deviceId, sessionToken, sessionChunks);
  }
};
