import { AgentRuntimeErrorType } from '@lobechat/types';
import debug from 'debug';
import { isRotatingRefreshOAuthProvider } from 'model-bank/modelProviders';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase } from '@/database/type';
import { digestPlatformAiCredential } from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';

import type { AiCatalogSecretManager, PlatformProviderKeyVaults } from './secretManager';

const log = debug('lobe-server:ai-catalog-shared-oauth-reauth');

/**
 * Non-secret marker leaves written when a shared platform OAuth credential is REJECTED by the
 * provider in a way only an administrator can fix.
 *
 * Why a vault leaf and not a column: the whole shared-OAuth state already lives in the
 * encrypted envelope, the CAS at the revision-pinned fingerprint is the only writer that may
 * touch it, and `platform_ai_providers.status` / `connectionTest*` mean other things
 * (publication lifecycle, admin-triggered probe) that are re-stamped on publish.
 *
 * They are DELIBERATELY not secret material: a timestamp and a stable reason code, projected
 * to the admin card so the operator sees "需要重新授权" instead of a healthy badge while every
 * member's chat 401s.
 */
export const OAUTH_GRANT_INVALID_AT_KEY = 'oauthGrantInvalidAt';
export const OAUTH_GRANT_INVALID_REASON_KEY = 'oauthGrantInvalidReason';

/**
 * Why the credential is considered dead. A closed set of stable codes — never provider prose,
 * which may echo request material and is not translatable.
 *
 * - `invalidGrant`: the renewal itself was refused terminally (invalid_grant / dead web session).
 * - `runtimeAuth`: a real execution through the shared account was rejected as unauthenticated.
 */
export const SHARED_OAUTH_INVALID_REASONS = ['invalidGrant', 'runtimeAuth'] as const;

export type SharedOAuthInvalidReason = (typeof SHARED_OAUTH_INVALID_REASONS)[number];

/** Durable state may hold anything (older writer, hand-edited vault): unknown ⇒ absent. */
export const parseSharedOAuthInvalidReason = (value: unknown): SharedOAuthInvalidReason | null =>
  typeof value === 'string' && (SHARED_OAUTH_INVALID_REASONS as readonly string[]).includes(value)
    ? (value as SharedOAuthInvalidReason)
    : null;

/**
 * A broken shared account fails EVERY member's request. Without a debounce each of those
 * failures would spend one decrypt + encrypt + CAS write on re-stating the same fact, so the
 * marker is only re-stamped once it is this old (which also keeps the displayed timestamp
 * meaningful: "still failing as of …").
 */
export const SHARED_OAUTH_REAUTH_DEBOUNCE_MS = 10 * 60 * 1000;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Projection of the marker for readers (admin status, tests). */
export const readSharedOAuthReauthMarker = (
  keyVaults: PlatformProviderKeyVaults,
): { invalidAt: string | null; invalidReason: SharedOAuthInvalidReason | null } => {
  const invalidAt = asString(keyVaults[OAUTH_GRANT_INVALID_AT_KEY]);
  return {
    invalidAt: invalidAt ?? null,
    // A reason without a timestamp is not a marker: the pair is written and cleared as a unit.
    invalidReason: invalidAt
      ? parseSharedOAuthInvalidReason(keyVaults[OAUTH_GRANT_INVALID_REASON_KEY])
      : null,
  };
};

/** Both leaves are removed as a UNIT — a lone reason would outlive the failure it names. */
export const clearSharedOAuthReauthMarker = (vault: PlatformProviderKeyVaults): void => {
  delete vault[OAUTH_GRANT_INVALID_AT_KEY];
  delete vault[OAUTH_GRANT_INVALID_REASON_KEY];
};

const isMarkerFresh = (vault: PlatformProviderKeyVaults, now: number): boolean => {
  const stamped = Number(asString(vault[OAUTH_GRANT_INVALID_AT_KEY]));
  if (!Number.isFinite(stamped) || stamped <= 0) return false;
  return now - stamped < SHARED_OAUTH_REAUTH_DEBOUNCE_MS;
};

/**
 * Which runtime error types mean "this credential is no longer accepted". Everything else —
 * Cloudflare challenges, rate limits, upstream 5xx, network blips — is transient and must
 * never make the admin card cry wolf about a connection that is merely having a bad minute.
 */
const TERMINAL_AUTH_ERROR_TYPES: ReadonlySet<unknown> = new Set([
  AgentRuntimeErrorType.OAuthAuthorizationExpired,
  AgentRuntimeErrorType.InvalidProviderAPIKey,
]);

export const classifyExecutionAuthFailure = (
  errorType: unknown,
): SharedOAuthInvalidReason | null =>
  TERMINAL_AUTH_ERROR_TYPES.has(errorType) ? 'runtimeAuth' : null;

export interface MarkSharedOAuthGrantInvalidParams {
  /** Ciphertext the caller decrypted `keyVaults` from — the CAS baseline. */
  ciphertext: string;
  db: LobeChatDatabase;
  /** Revision-pinned fingerprint; the marker write must NEVER change it. */
  fingerprint: string;
  keyVaults: PlatformProviderKeyVaults;
  now?: number;
  /** platform_ai_providers.id (revision resourceId), not the providerKey. */
  providerRowId: string;
  reason: SharedOAuthInvalidReason;
  secrets: AiCatalogSecretManager;
}

/**
 * Stamp the reauth marker onto a shared OAuth vault, in place, at the stable fingerprint.
 *
 * Invariants (all of them load-bearing — this runs next to token rotation):
 * - the tokens and every other leaf are carried through untouched; this NEVER clears the vault;
 * - the fingerprint is unchanged (published revisions pin it), so the write goes through the
 *   same `casProviderSecretCiphertext` rotation seam;
 * - a lost CAS is re-baselined and retried, because the KEK rewrap worker rewrites the SAME
 *   plaintext under a new ciphertext and losing to it must not drop the observation;
 * - but a re-read whose ACCESS TOKEN differs is a newer connection (an admin reconnect, another
 *   instance's rotation) — marking it would report a live credential as dead, so we stop;
 * - best-effort throughout: this is an observation on an error path and never becomes an error
 *   of its own. Returns whether the marker was written.
 */
export const markSharedOAuthGrantInvalid = async (
  params: MarkSharedOAuthGrantInvalidParams,
): Promise<boolean> => {
  const now = params.now ?? Date.now();
  try {
    const repository = new PlatformAiCatalogRepository(params.db);
    let ciphertext = params.ciphertext;
    let vault = params.keyVaults;
    const observedAccessToken = asString(vault.oauthAccessToken);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (isMarkerFresh(vault, now)) return false;

      const merged: PlatformProviderKeyVaults = {
        ...vault,
        [OAUTH_GRANT_INVALID_AT_KEY]: String(now),
        [OAUTH_GRANT_INVALID_REASON_KEY]: params.reason,
      };
      const sealed = await params.secrets.encryptVaultForRotation(merged);
      const updated = await repository.casProviderSecretCiphertext({
        ciphertext: sealed.ciphertext,
        expectedCiphertext: ciphertext,
        fingerprint: params.fingerprint,
        keyId: sealed.keyId,
        providerId: params.providerRowId,
      });
      if (updated) return true;

      const version = await repository.getProviderSecretVersion(
        params.providerRowId,
        params.fingerprint,
      );
      // The secret version is gone (an admin cleared or replaced the credential): there is
      // nothing left to mark, and the connection the operator now has is not the failed one.
      if (!version) return false;
      ciphertext = version.ciphertext;
      vault = await params.secrets.decrypt(version.ciphertext);
      if (asString(vault.oauthAccessToken) !== observedAccessToken) return false;
    }
    return false;
  } catch (error) {
    // Stable trace only: a refresh/execution failure carries provider-controlled prose.
    log('failed to record the shared OAuth reauth marker: %s', (error as Error)?.name ?? 'error');
    return false;
  }
};

/**
 * Runtime-observed variant: only the provider KEY is known (the chat hook has no revision or
 * ciphertext at hand), so the current provider row is resolved first. Silently does nothing for
 * anything that is not a shared rotating-refresh OAuth credential — an API-key provider has no
 * "reconnect" for an administrator to perform.
 *
 * `credentialDigest` is REQUIRED and is the whole safety of this path: the failure was observed
 * on the credential the runtime was built with, which is not necessarily the one stored now. An
 * admin reconnect (or a rotation) between the request and its 401 — and every execution pinned
 * to an older revision — would otherwise mark a credential that never failed. Mismatch ⇒ no-op.
 */
export const markSharedOAuthGrantInvalidForProvider = async (params: {
  credentialDigest: string;
  db: LobeChatDatabase;
  now?: number;
  providerKey: string;
  reason: SharedOAuthInvalidReason;
  secrets: AiCatalogSecretManager;
}): Promise<boolean> => {
  if (!isRotatingRefreshOAuthProvider(params.providerKey)) return false;
  if (!params.credentialDigest) return false;
  try {
    const repository = new PlatformAiCatalogRepository(params.db);
    const provider = await repository.getProviderByKey(params.providerKey);
    if (!provider?.encryptedKeyVaults || !provider.secretFingerprint) return false;
    const keyVaults = await params.secrets.decrypt(provider.encryptedKeyVaults);
    // No stored OAuth credential ⇒ the failure came from somewhere else (BYOK fallback,
    // a provider whose vault was just cleared); there is nothing to report on.
    if (!asString(keyVaults.oauthAccessToken)) return false;
    // The stored credential is no longer the one that failed: the observation is stale and
    // saying anything about the current one would be a guess.
    if (
      digestPlatformAiCredential(asString(keyVaults.oauthAccessToken)) !== params.credentialDigest
    )
      return false;
    return await markSharedOAuthGrantInvalid({
      ciphertext: provider.encryptedKeyVaults,
      db: params.db,
      fingerprint: provider.secretFingerprint,
      keyVaults,
      ...(params.now === undefined ? {} : { now: params.now }),
      providerRowId: provider.id,
      reason: params.reason,
      secrets: params.secrets,
    });
  } catch (error) {
    log('failed to resolve the shared OAuth row to mark: %s', (error as Error)?.name ?? 'error');
    return false;
  }
};
