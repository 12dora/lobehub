export type SharedOAuthFlowState = 'idle' | 'requesting' | 'awaiting' | 'success' | 'error';

export type SharedOAuthFlowError = 'authError' | 'codeExpired' | 'denied' | 'providerStoreFailed';

/**
 * Which grant the provider's connect flow uses. `authorization_code_paste` (chatgptweb)
 * has nothing to poll for: the redirect URI belongs to the provider, so the operator signs
 * in in a browser and carries the callback URL back into this panel.
 */
export type SharedOAuthGrantFlow = 'device_code' | 'authorization_code_paste';

/**
 * Recoverable errors of a paste submit. They keep the form on screen — the operator can
 * fix the pasted value and submit again without redoing the browser sign-in.
 */
export type SharedOAuthPasteError =
  | 'invalidCallback'
  | 'stateMismatch'
  | 'exchangeFailed'
  | 'accessTokenInvalid'
  /** The paste carried both `OAI-Device-Id` and `oai-did`, and they disagree. */
  | 'deviceMismatch'
  /** The pasted web session is expired or revoked — it mints no access token. */
  | 'sessionInvalid'
  /** The credential works, but belongs to a client with no chatgpt.com web permission. */
  | 'tokenNotWeb'
  | 'authError';

/**
 * Which input produced the material of the failed submit. Kept WITH the error, because a
 * generic failure (network blip, unknown literal) carries no field of its own — without the
 * source it lands on the callback box even when the operator submitted an access token.
 */
export type SharedOAuthPasteSource = 'callback' | 'token';

/**
 * Phase of the API-key connect route. The two halves fail for different reasons — an envelope
 * the server refused is an authorization/network failure and says nothing about the key, only
 * a rejected exchange does — so the panel has to be able to tell them apart.
 */
export type SharedOAuthApiKeyPhase = 'idle' | 'requestingEnvelope' | 'exchangingKey';

export interface SharedOAuthDeviceCode {
  /** Provider accepts a manually pasted access token as a fallback credential. */
  allowAccessTokenPaste?: boolean;
  deviceCode: string;
  expiresIn: number | null;
  /** Defaults to `device_code` when the server does not declare one. */
  flow: SharedOAuthGrantFlow;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
}

/**
 * Result of the one write the flow performs. The server applies and publishes the connected
 * account unconditionally, so a `success` poll means the credentials are committed — NOT that
 * members are served: the provider's `enabled` state is preserved and takeover requires the
 * platform-managed policy. `revision` is only kept so callers can tell a create from an update.
 */
export interface SharedOAuthStoreOutcome {
  revision: number | null;
}

/** Material the operator pasted, redeemed against the envelope the flow is holding. */
export interface SharedOAuthPastePayload {
  accessToken?: string;
  callbackUrl?: string;
  deviceId?: string;
  sessionChunks?: string[];
  sessionToken?: string;
}
