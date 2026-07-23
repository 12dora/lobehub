/**
 * Shared Zod primitives for enterprise contracts.
 * Keep audit metadata secret-safe and SuperJSON date inputs strict.
 */
import semver from 'semver';
import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../security/redaction';

export const SECRET_SAFE_TEXT_MAX = 2000;

/**
 * Required free-text audit reason / publication reason.
 * Rejects whitespace-only and credential-shaped material.
 */
export const secretSafeAuditReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(SECRET_SAFE_TEXT_MAX)
  .refine(
    (value) => !containsEnterpriseSecretMaterial(value),
    'credential material is not allowed in audit reasons',
  );

/**
 * Optional revision / publication comment persisted in history.
 * Empty or whitespace-only comments normalize to `undefined`.
 * Non-empty comments must be secret-free.
 */
export const secretSafeOptionalCommentSchema = z
  .string()
  .trim()
  .max(SECRET_SAFE_TEXT_MAX)
  .refine(
    (value) => value.length === 0 || !containsEnterpriseSecretMaterial(value),
    'credential material is not allowed in revision comments',
  )
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

/**
 * Date for SuperJSON tRPC procedures (real `Date` instances only).
 * Rejects null, booleans, numbers, and ISO strings that `z.coerce.date()` would
 * silently convert into epoch timestamps.
 */
export const strictDateSchema = z
  .date()
  .refine((value) => !Number.isNaN(value.getTime()), 'invalid date');

/**
 * Strict SemVer 2.0 including optional build metadata (`1.2.3+build.5`).
 * Rejects `v` prefixes and leading-zero core numbers. Uses rebuild equality
 * because `semver.valid()` strips build metadata from its return value.
 */
export const isStrictSemVer = (value: string): boolean => {
  const parsed = semver.parse(value);
  if (!parsed) return false;
  const rebuilt =
    parsed.build.length > 0 ? `${parsed.version}+${parsed.build.join('.')}` : parsed.version;
  return value === rebuilt;
};
