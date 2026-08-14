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

export const adminAiProviderOAuthInitiateOutputSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    /** Seconds until the device code expires; null when the provider omits it. */
    expiresIn: z.number().int().positive().nullable(),
    /** Seconds between polls (already includes any provider safety margin). */
    interval: z.number().int().positive(),
    userCode: z.string().min(1).max(200),
    verificationUri: z.string().min(1).max(2000),
    verificationUriComplete: z.string().min(1).max(2000).nullable(),
  })
  .strict();

export const adminAiProviderOAuthPollInputSchema = z
  .object({
    deviceCode: deviceCodeSchema,
    id: providerKeySchema,
    reason: adminReasonSchema,
  })
  .strict();

export const adminAiProviderOAuthPollOutputSchema = z
  .object({
    /** true only when the shared connection reached the live published catalog. */
    published: z.boolean(),
    /** Structured human-safe reason when published is false (never token material). */
    publishError: z.string().max(500).nullable(),
    /** Provider revision after a successful store; null while the flow is unfinished. */
    revision: z.number().int().nonnegative().nullable(),
    /** true when this poll stored the shared connection in the platform vault. */
    stored: z.boolean(),
    status: z.enum(['denied', 'expired', 'pending', 'slow_down', 'success']),
  })
  .strict();

export const adminAiProviderOAuthStatusInputSchema = z.object({ id: providerKeySchema }).strict();

/** Presence-only projection: no token, refresh token, or full account id ever crosses this boundary. */
export const adminAiProviderOAuthStatusOutputSchema = z
  .object({
    /** First characters of the account id plus an ellipsis, for operator recognition only. */
    accountIdMasked: z.string().max(32).nullable(),
    connected: z.boolean(),
    /** Epoch millis as a string, mirroring the vault leaf type. */
    expiresAt: z.string().max(200).nullable(),
    secretConfigured: z.boolean(),
  })
  .strict();
