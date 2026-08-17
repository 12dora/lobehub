import { createHash, randomBytes } from 'node:crypto';

import { ChatGPTWebOAuthError } from './oauthErrors';

/** The pasted authorization code is single-use and short-lived; so is the envelope. */
export const CHATGPT_WEB_ENVELOPE_TTL_MS = 10 * 60 * 1000;
const MAX_CALLBACK_LENGTH = 4096;

/** Client-held pending-authorization state. Never persisted, never logged. */
export interface ChatGPTWebPasteEnvelope {
  createdAt: number;
  deviceId: string;
  state: string;
  v: 1;
  verifier: string;
}

export const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/**
 * `<a>.<b>` — the shape the real client uses (E2 §1.3), where the first half identifies
 * the pending session. We hold no server-side session (the envelope does), so BOTH halves
 * are random: the value stays opaque and unguessable, and it is still recognisable to
 * OpenAI's own request logging as a well-formed state.
 */
export const createDottedState = (): string =>
  `${randomBytes(16).toString('hex')}.${base64url(randomBytes(16))}`;

export const createPkcePair = (): { challenge: string; verifier: string } => {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest());
  return { challenge, verifier };
};

/** `randomUUID()` output, which is what {@link ChatGPTWebOAuthService.initiateDeviceCode} mints. */
const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
/** RFC 7636 §4.1 code_verifier charset; ours is a 64-byte base64url string (86 chars). */
const PKCE_VERIFIER = /^[\w.~-]{43,128}$/;
/** `<a>.<b>`, both halves non-empty — the dotted shape `createDottedState` produces. */
const DOTTED_STATE = /^[\w-]+\.[\w-]+$/;
/**
 * A client clock running ahead is normal; an envelope minted in the FUTURE beyond this is
 * not something this server ever issued.
 */
const ENVELOPE_FUTURE_SKEW_MS = 60_000;

/**
 * Parse and VALIDATE the client-held envelope.
 *
 * Shape checks are not enough: the envelope comes back from the client, and every field is
 * used for something load-bearing — the verifier IS the PKCE proof, the state is the CSRF
 * binding, and the device id is persisted and then sent as `oai-device-id` on every later
 * request (an empty or foreign one silently breaks the sentinel handshake). So each field
 * is checked against exactly the shape this service generates; anything else is a
 * fabricated envelope, not a usable one.
 */
export const parsePasteEnvelope = (deviceCode: string): ChatGPTWebPasteEnvelope => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(deviceCode);
  } catch {
    throw new ChatGPTWebOAuthError('invalid_callback', 'malformed authorization envelope');
  }

  const envelope = parsed as Partial<ChatGPTWebPasteEnvelope>;
  if (
    envelope?.v !== 1 ||
    typeof envelope.verifier !== 'string' ||
    typeof envelope.state !== 'string' ||
    typeof envelope.deviceId !== 'string' ||
    typeof envelope.createdAt !== 'number' ||
    !Number.isFinite(envelope.createdAt) ||
    !PKCE_VERIFIER.test(envelope.verifier) ||
    !DOTTED_STATE.test(envelope.state) ||
    !UUID_V4.test(envelope.deviceId)
  ) {
    throw new ChatGPTWebOAuthError('invalid_callback', 'malformed authorization envelope');
  }

  // A far-future timestamp would make the TTL below unbounded — it is a malformed envelope,
  // not an expired one.
  if (envelope.createdAt - Date.now() > ENVELOPE_FUTURE_SKEW_MS) {
    throw new ChatGPTWebOAuthError('invalid_callback', 'malformed authorization envelope');
  }

  if (Date.now() - envelope.createdAt > CHATGPT_WEB_ENVELOPE_TTL_MS) {
    throw new ChatGPTWebOAuthError('expired');
  }

  return envelope as ChatGPTWebPasteEnvelope;
};

export interface ParsedCallbackInput {
  code: string;
  /** True when the user pasted the redirect URL rather than a bare code. */
  fromUrl: boolean;
  state?: string;
}

/**
 * The user may paste the whole redirect URL or just the `code` query value.
 *
 * A pasted URL ALWAYS carries the state the authorization server echoed back, so a URL
 * without one is not a CSRF-safe input — it is a hand-edited or forged callback and is
 * rejected by {@link ChatGPTWebOAuthService.exchangeCallback}. A bare code carries no
 * state by construction and is bound instead by the single-use PKCE verifier + the
 * envelope's 10-minute TTL.
 */
export const parseCallbackInput = (input: string): ParsedCallbackInput => {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_CALLBACK_LENGTH) {
    throw new ChatGPTWebOAuthError('invalid_callback');
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ChatGPTWebOAuthError('invalid_callback');
    }
    const code = url.searchParams.get('code');
    if (!code) throw new ChatGPTWebOAuthError('invalid_callback');
    const state = url.searchParams.get('state');
    return { code, fromUrl: true, ...(state ? { state } : {}) };
  }

  // A bare code never contains whitespace or a query separator.
  if (/[\s&?#]/.test(trimmed)) throw new ChatGPTWebOAuthError('invalid_callback');
  return { code: trimmed, fromUrl: false };
};
