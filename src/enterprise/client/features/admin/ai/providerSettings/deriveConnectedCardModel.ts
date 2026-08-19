import { formatExpiry } from './sharedOAuthFormat';

export interface SharedOAuthConnectionStatus {
  accountEmail?: string | null;
  accountIdMasked?: string | null;
  canRefresh?: boolean;
  connected?: boolean;
  expiresAt?: string | null;
  flow?: string | null;
  lastRefreshAt?: string | null;
  renewalKind?: 'cursor_api_key' | 'oauth' | 'web_session' | null;
}

export interface DeriveConnectedCardModelInput {
  name: string;
  needsReauth: boolean;
  status?: SharedOAuthConnectionStatus;
  webSessionOnly: boolean;
}

export type ConnectedCardHealth = 'cannotRenew' | 'healthy' | 'reauth';

export type ConnectedCardModel =
  | { view: 'disconnected' }
  | {
      account: string | null;
      autoRenews: boolean;
      cannotAutoRenew: boolean;
      expiry: string | undefined;
      health: ConnectedCardHealth;
      lastRefresh: string | undefined;
      pasteFlow: boolean;
      renewalKind: SharedOAuthConnectionStatus['renewalKind'];
      view: 'account';
    };

/**
 * Discriminator for the idle/connected shared-account card.
 *
 * `name` and `webSessionOnly` are accepted so callers pass the same bag the card already
 * holds; they do not change view/health (copy and session-fix buttons stay in the view).
 */
export const deriveConnectedCardModel = ({
  needsReauth,
  status,
}: DeriveConnectedCardModelInput): ConnectedCardModel => {
  /**
   * A dead grant still HAS an account (the vault keeps it as the evidence), so the identity
   * block stays on screen while the card asks for a reconnect — replacing it with the
   * "nothing is connected yet" line would hide which account has to be re-authorized.
   */
  const showAccount = Boolean(status?.connected) || needsReauth;
  if (!showAccount) return { view: 'disconnected' };

  /** Whether a pasted credential is a route at all — a device-code provider has no box. */
  const pasteFlow = status?.flow === 'authorization_code_paste';
  /**
   * An access token pasted by hand has no renewal credential, so nothing renews it. Scoped
   * to the paste flow, so the device-code providers that shipped before it keep their
   * previous connected copy verbatim — and only a POSITIVE `false` warns, because silence
   * must never be read as "this credential will die".
   */
  const cannotAutoRenew = pasteFlow && status?.canRefresh === false;
  /**
   * The good outcome, and only on a POSITIVE reading: the connection holds a renewal
   * credential (an OAuth refresh token, a web session that mints tokens the way the web app
   * does, or an API key the server re-exchanges), so it rolls over on its own and its
   * `expiresAt` is a routine rollover date rather than a deadline.
   *
   * Not gated on the paste flow: a device-code provider that stores a renewal credential
   * (Cursor — an API key it re-exchanges, or the refresh token of its browser login) rolls
   * over exactly the same way, and `renewalKind` is the POSITIVE reading that says so. The
   * paste flow keeps its previous condition verbatim so connections stored before the label
   * existed still read as renewable, and a card that reports `canRefresh: false` (GitHub
   * Copilot style) is untouched by either half.
   */
  const autoRenews = status?.canRefresh === true && (pasteFlow || Boolean(status?.renewalKind));

  /**
   * Prefer the full sign-in email: it is the only human-readable identity of the shared
   * account, and an operator needs to recognise WHICH account is connected. `accountIdMasked`
   * is a 4-char prefix of the Codex workspace UUID — it identifies nothing to a human, so it
   * is only the fallback for connections stored before the email was captured.
   */
  const account = status?.accountEmail ?? status?.accountIdMasked ?? null;

  const health: ConnectedCardHealth = needsReauth
    ? 'reauth'
    : cannotAutoRenew
      ? 'cannotRenew'
      : 'healthy';

  return {
    account,
    autoRenews,
    cannotAutoRenew,
    expiry: formatExpiry(status?.expiresAt ?? null),
    health,
    lastRefresh: formatExpiry(status?.lastRefreshAt ?? null),
    pasteFlow,
    renewalKind: status?.renewalKind,
    view: 'account',
  };
};
