import type { ChatGPTWebPasteKind } from '@lobechat/utils/chatgptWebPaste';

import type { SharedOAuthPasteError, SharedOAuthPasteSource } from './useAdminSharedOAuthFlow';

/** Submit errors that belong to the pasted-credential box rather than the callback box. */
const TOKEN_SOURCE_ERRORS = new Set<SharedOAuthPasteError>([
  'accessTokenInvalid',
  'deviceMismatch',
  'sessionInvalid',
  'tokenNotWeb',
]);

/**
 * Rejections whose generic copy sends the operator to the authorization page. That page is a
 * dead end for a web-session-only provider — its own server refuses the exchange — so those
 * two get a variant that names the one remedy that works here.
 */
const SESSION_ONLY_ERRORS = new Set<SharedOAuthPasteError>(['accessTokenInvalid', 'tokenNotWeb']);

export interface ResolvePasteErrorPlacementInput {
  /** The live paste itself disagrees with itself; it outranks any stale submit error. */
  deviceMismatch: boolean;
  submitError?: SharedOAuthPasteError;
  submitErrorSource?: SharedOAuthPasteSource;
  webSessionOnly?: boolean;
}

export interface PasteErrorPlacement {
  callbackError?: SharedOAuthPasteError;
  tokenError?: SharedOAuthPasteError;
  tokenErrorKey?: string;
}

/**
 * One error at a time, attached to the field that produced it: a rejected session must
 * not paint the callback box red, or the operator fixes the wrong thing.
 *
 * The SOURCE decides, not the literal: a network failure or an unmapped code becomes the
 * generic `authError`, which belongs to whichever input was submitted. Reading the
 * literal alone put every such failure on the callback box.
 */
export const resolvePasteErrorPlacement = ({
  deviceMismatch,
  submitError,
  submitErrorSource,
  webSessionOnly,
}: ResolvePasteErrorPlacementInput): PasteErrorPlacement => {
  const errorSource =
    submitErrorSource ??
    (submitError && TOKEN_SOURCE_ERRORS.has(submitError) ? 'token' : 'callback');
  const tokenError = deviceMismatch
    ? 'deviceMismatch'
    : submitError && errorSource === 'token'
      ? submitError
      : undefined;
  const callbackError = submitError && !tokenError ? submitError : undefined;
  const tokenErrorKey =
    tokenError &&
    `aiProviderSettings.sharedOAuth.paste.errors.${tokenError}${
      webSessionOnly && SESSION_ONLY_ERRORS.has(tokenError) ? 'SessionOnly' : ''
    }`;

  return { callbackError, tokenError, tokenErrorKey };
};

export type PasteDetection = 'session' | 'accessToken' | 'unknown';

/**
 * What the operator actually pasted, resolved live: a session cookie, a whole "Copy as
 * cURL" command, the JSON body of `/api/auth/session`, or a bare access token. Saying so
 * BEFORE the submit is the point — a web session renews itself and an access token does
 * not, and that difference is invisible in the raw text.
 */
export const resolvePasteDetection = (
  raw: string,
  kind: ChatGPTWebPasteKind,
): PasteDetection | undefined => {
  if (raw.trim().length === 0) return undefined;
  if (kind === 'web_session') return 'session';
  if (kind === 'access_token') return 'accessToken';
  if (kind === 'device_mismatch') return undefined;
  return 'unknown';
};
