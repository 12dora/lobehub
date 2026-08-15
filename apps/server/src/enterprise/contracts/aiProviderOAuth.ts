import { z } from 'zod';

/**
 * Contracts for the shared (platform-owned) OAuth device-flow connection of
 * rotating-refresh providers (chatgpt / supergrok). Token material is accepted
 * from the authorization server only — it is never echoed back to the client.
 */

/** Mirrors the provider-key shape used by the AI catalog contracts. */
const providerKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const adminReasonSchema = z.string().trim().min(1).max(2000);

/**
 * ChatGPT encodes its device state as a JSON envelope rather than an opaque
 * RFC 8628 device_code, so the bound is generous but still finite.
 */
const deviceCodeSchema = z.string().min(1).max(8192);

export const adminAiProviderOAuthInitiateInputSchema = z.object({ id: providerKeySchema }).strict();

/**
 * `device_code`: RFC 8628 — show a user code, poll the token endpoint.
 * `authorization_code_paste`: the operator signs in in a browser and pastes the callback
 * URL back, because the provider's redirect URI cannot point at this deployment.
 */
export const adminAiProviderOAuthFlowSchema = z.enum(['authorization_code_paste', 'device_code']);

export const adminAiProviderOAuthInitiateOutputSchema = z
  .object({
    /** Whether the provider also accepts a manually pasted access token (no auto-renew). */
    allowAccessTokenPaste: z.boolean(),
    deviceCode: deviceCodeSchema,
    /** Seconds until the device code expires; null when the provider omits it. */
    expiresIn: z.number().int().positive().nullable(),
    flow: adminAiProviderOAuthFlowSchema,
    /** Seconds between polls; 0 for the paste flow, which has nothing to poll. */
    interval: z.number().int().nonnegative(),
    /** Empty for the paste flow: the authorize URL carries the whole request. */
    userCode: z.string().max(200),
    verificationUri: z.string().min(1).max(2000),
    verificationUriComplete: z.string().min(1).max(2000).nullable(),
  })
  .strict();

export const adminAiProviderOAuthPollInputSchema = z
  .object({
    /**
     * Paste flow only. `callbackUrl` is the pasted redirect URL (or bare authorization
     * code); `accessToken` is the no-refresh fallback credential. Both are single-use
     * secrets on the wire and are never echoed back or audited.
     */
    accessToken: z.string().min(1).max(8192).optional(),
    callbackUrl: z.string().min(1).max(4096).optional(),
    deviceCode: deviceCodeSchema,
    id: providerKeySchema,
    reason: adminReasonSchema,
  })
  .strict();

/**
 * Every stable outcome code a poll may surface. A closed union rather than a free string:
 * both connect UIs (`useAdminSharedOAuthFlow`, `useOAuthDeviceFlow`) map these literals to
 * their own copy, and an unlisted one silently degrades to a generic "auth error" instead
 * of telling the operator what to fix. `ChatGPTWebOAuthErrorCode` is the paste flow's half
 * of it; `provider_store_failed` is the admin-only "grant redeemed but not stored" case.
 */
export const aiProviderOAuthPollErrorSchema = z.enum([
  'access_token_invalid',
  'exchange_failed',
  'expired',
  'invalid_callback',
  'provider_store_failed',
  'state_mismatch',
]);

export type AiProviderOAuthPollError = z.infer<typeof aiProviderOAuthPollErrorSchema>;

export const adminAiProviderOAuthPollOutputSchema = z
  .object({
    /**
     * Stable machine-readable code when the redeemed grant could not be stored
     * (`status: 'denied'`, `stored: false`). Never prose, never token material.
     */
    error: aiProviderOAuthPollErrorSchema.nullable().optional(),
    /**
     * Provider revision after a successful store; null while the flow is unfinished.
     * `stored: true` means the credentials were committed and published; the provider's
     * existing `enabled` state is preserved (a reconnect never re-enables a provider the
     * admin turned off), and members are served only under platform-managed takeover.
     */
    revision: z.number().int().nonnegative().nullable(),
    /** true when this poll stored the shared connection in the platform vault. */
    stored: z.boolean(),
    /**
     * `error` is the paste flow's terminal, user-fixable outcome (bad paste, stale
     * envelope, rejected exchange): `error` then carries the stable reason code.
     */
    status: z.enum(['denied', 'error', 'expired', 'pending', 'slow_down', 'success']),
  })
  .strict();

export const adminAiProviderOAuthDisconnectInputSchema = z
  .object({
    id: providerKeySchema,
    reason: adminReasonSchema,
  })
  .strict();

export const adminAiProviderOAuthDisconnectOutputSchema = z
  .object({
    /**
     * false only when there is no platform row for this provider at all — there was
     * nothing to withdraw, so the call is a no-op rather than a failure.
     */
    disconnected: z.boolean(),
    /** Provider revision after the withdrawal published; null on the no-op path. */
    revision: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const adminAiProviderOAuthStatusInputSchema = z.object({ id: providerKeySchema }).strict();

/**
 * Identity + presence projection: no token, refresh token, or full account id ever crosses
 * this boundary.
 *
 * `accountEmail` is the one deliberate exception to "mask everything": it is the identity of
 * the shared account this instance is about to use for every user, it is only readable with
 * AI_PROVIDER_READ, and a 4-character mask of a Codex workspace UUID tells an operator
 * nothing about *which* account is connected.
 */
export const adminAiProviderOAuthStatusOutputSchema = z
  .object({
    /**
     * Full (unmasked) identity of the connected account — OIDC `email`, else
     * `preferred_username`, so it is not validated as an email address.
     */
    accountEmail: z.string().max(320).nullable(),
    /** First characters of the account id plus an ellipsis, for operator recognition only. */
    accountIdMasked: z.string().max(32).nullable(),
    /**
     * false when the stored credential has no refresh grant (a pasted access token): it
     * will expire for good at `expiresAt` and an operator must reconnect by hand.
     */
    canRefresh: z.boolean(),
    connected: z.boolean(),
    /**
     * true when the stored grant is dead (`invalid_grant`) and an administrator must
     * reconnect. Transient refresh failures never set this — they degrade to stored values.
     */
    expired: z.boolean(),
    /** Epoch millis as a string, mirroring the vault leaf type. */
    expiresAt: z.string().max(200).nullable(),
    /** Which connect flow the panel must render for this provider. */
    flow: adminAiProviderOAuthFlowSchema,
    secretConfigured: z.boolean(),
  })
  .strict();
