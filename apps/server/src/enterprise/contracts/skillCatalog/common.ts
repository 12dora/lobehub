import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import { isStrictSemVer } from '../shared';

const rejectSensitiveText = (value: string, ctx: z.RefinementCtx) => {
  if (containsEnterpriseSecretMaterial(value)) {
    ctx.addIssue({ code: 'custom', message: 'secret material is not allowed' });
  }
};

export const boundedSafeText = (max: number) =>
  z.string().trim().min(1).max(max).superRefine(rejectSensitiveText);

export const skillKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const skillVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isStrictSemVer, 'version must be valid SemVer');

export const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const reasonSchema = boundedSafeText(2000);
/**
 * Audit reason for Skill operations the admin console no longer prompts for (create, save,
 * new version, validate, publish, archive, rollback). Recorded when a caller supplies one.
 */
export const optionalReasonSchema = reasonSchema.optional();
export const draftTokenSchema = z.string().length(64);
export const revisionSchema = z.number().int().nonnegative();
export const cursorSchema = z.string().min(1).max(1000);
export const localizedTextSchema = z.record(
  z.string().trim().min(2).max(35),
  boundedSafeText(4000),
);
export const skillContentRefSchema = z
  .string()
  .trim()
  .min(8)
  .max(520)
  .regex(/^opaque:[a-z0-9][\w./-]*$/i);
export const skillResourcePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'resource path must be a normalized relative POSIX path',
  );
