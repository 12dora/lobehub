/**
 * Enterprise business error code prefixes (M00).
 * Runtime const values live in `@/const/platform/errorCodes`.
 */
export type PlatformErrorCode = `PLATFORM_${string}`;
export type AdminErrorCode = `ADMIN_${string}`;
export type ManagedErrorCode = `MANAGED_${string}`;
export type EnterpriseErrorCode = PlatformErrorCode | AdminErrorCode | ManagedErrorCode;

/**
 * Structured enterprise error payload for tRPC `cause` / client mappers.
 * Never include secrets or stack traces in `message`.
 */
export interface EnterpriseErrorBody {
  code: EnterpriseErrorCode;
  /** Optional machine-readable details (resource id, expected revision, …). */
  details?: Record<string, string | number | boolean | null>;
  /** Stable i18n key or short English summary — not a stack trace. */
  message?: string;
}
