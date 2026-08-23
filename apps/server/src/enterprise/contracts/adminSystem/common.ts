import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';

export const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (value) => !containsEnterpriseSecretMaterial(value),
    'credential material is not allowed in audit reasons',
  );

export const identityRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const instanceIdSchema = z.string().regex(/^oidci_[a-f0-9]{48}$/);
export const platformJobIdSchema = z.string().regex(/^pjob_[0-9A-Za-z]{16}$/);
export const paginationCursorSchema = z.string().regex(/^[\w-]{1,512}$/);
export const paginationLimitSchema = z.number().int().min(1).max(50);
export const platformJobRevisionSchema = z.number().int().nonnegative();

export const validateAvailability = (
  value: { errorCategory: 'operation_unavailable' | null; status: 'healthy' | 'unavailable' },
  context: z.RefinementCtx,
): void => {
  if (value.status === 'healthy' && value.errorCategory) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'healthy data cannot contain an error category',
      path: ['errorCategory'],
    });
  }
  if (value.status === 'unavailable' && !value.errorCategory) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'unavailable data requires an error category',
      path: ['errorCategory'],
    });
  }
};

export const requireWhenEnabled = (
  enabled: boolean,
  ctx: z.RefinementCtx,
  fields: Array<{ message: string; path: Array<number | string>; present: boolean }>,
) => {
  if (!enabled) return;
  for (const field of fields) {
    if (field.present) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: field.message,
      path: field.path,
    });
  }
};
