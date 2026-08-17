export type ChatGPTWebOAuthErrorCode =
  | 'access_token_invalid'
  | 'exchange_failed'
  | 'expired'
  | 'invalid_callback'
  /** The pasted web session is expired/revoked — chatgpt.com mints no token for it. */
  | 'session_invalid'
  | 'state_mismatch'
  /** The token works, but belongs to a client without chatgpt.com web permission. */
  | 'token_not_web';

/** Stable machine-readable outcome; the message is never shown to a client. */
export class ChatGPTWebOAuthError extends Error {
  constructor(
    readonly code: ChatGPTWebOAuthErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ChatGPTWebOAuthError';
  }
}
