/**
 * Error code unions from the runtime catalog (single source of truth).
 * Prefer `@/const/platform/errorCodes` for values; types re-export for convenience.
 */
import type { EnterpriseErrorCode } from '@/const/platform/errorCodes';

export type {
  AdminErrorCode,
  EnterpriseErrorCode,
  ManagedErrorCode,
  PlatformErrorCode,
} from '@/const/platform/errorCodes';

export type EnterpriseErrorDetailPrimitive = string | number | boolean | null;

/** Nested JSON-safe details (counts, ids, and structured lists such as dependents). */
export type EnterpriseErrorDetailValue =
  | EnterpriseErrorDetailPrimitive
  | readonly EnterpriseErrorDetailValue[]
  | { readonly [key: string]: EnterpriseErrorDetailValue };

/**
 * Structured enterprise error payload for tRPC `cause` / client mappers.
 * Never include secrets or stack traces in `message`.
 */
export interface EnterpriseErrorBody {
  code: EnterpriseErrorCode;
  /** Optional machine-readable details (resource id, expected revision, …). */
  details?: Record<string, EnterpriseErrorDetailValue>;
  /** Stable i18n key or short English summary — not a stack trace. */
  message?: string;
}
