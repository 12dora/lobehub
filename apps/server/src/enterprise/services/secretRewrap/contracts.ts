import { z } from 'zod';

import { PLATFORM_SECRET_ROTATION_DOMAINS } from '@/database/repositories/platformSecretRotation';
import type { PlatformJobItem } from '@/database/schemas/platform';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';

export const PLATFORM_SECRET_REWRAP_JOB_TYPE = 'platform.secret.rewrap.v1';
export const PLATFORM_SECRET_REWRAP_FAILURE_TYPE = 'platform.secret.rewrap.failure.v1';
export const PLATFORM_SECRET_REWRAP_BATCH_SIZE = 50;
export const PLATFORM_SECRET_REWRAP_EXTERNAL_GATE = 'identity_lkg_instance_convergence_required';

const addSecretIssue = (value: string, context: z.RefinementCtx) => {
  if (containsEnterpriseSecretMaterial(value)) {
    context.addIssue({ code: 'custom', message: 'secret material is not allowed' });
  }
};

const safeReasonSchema = z.string().trim().min(1).max(1000).superRefine(addSecretIssue);
const keyIdSchema = z.string().regex(/^[A-Z0-9][\w.:@+-]{0,127}$/i);
const rowIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w-]+$/);
const jobIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w-]+$/);

export const platformSecretRewrapFailureCategorySchema = z.enum([
  'ciphertext_not_readable',
  'concurrent_change',
  'historical_key_unavailable',
  'invalid_ciphertext',
]);

export type PlatformSecretRewrapFailureCategory = z.infer<
  typeof platformSecretRewrapFailureCategorySchema
>;

export const platformSecretRewrapCursorSchema = z
  .object({
    domain: z.enum(PLATFORM_SECRET_ROTATION_DOMAINS),
    lastId: rowIdSchema,
  })
  .strict();

export type PlatformSecretRewrapCursor = z.infer<typeof platformSecretRewrapCursorSchema>;

export const platformSecretRewrapJobInputSchema = z
  .object({
    control: z
      .object({
        phase: z.enum(['failed', 'scan']),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
    reason: safeReasonSchema,
    requestId: z.string().uuid(),
    schemaVersion: z.literal(1),
    targetKeyId: keyIdSchema,
  })
  .strict();

export type PlatformSecretRewrapJobInput = z.infer<typeof platformSecretRewrapJobInputSchema>;

export const platformSecretRewrapFailureInputSchema = z
  .object({
    category: platformSecretRewrapFailureCategorySchema,
    domain: z.enum(PLATFORM_SECRET_ROTATION_DOMAINS),
    parentJobId: jobIdSchema,
    parentRevision: z.number().int().nonnegative(),
    requestId: z.string().uuid(),
    rowId: rowIdSchema,
    schemaVersion: z.literal(1),
    targetKeyId: keyIdSchema,
  })
  .strict();

export type PlatformSecretRewrapFailureInput = z.infer<
  typeof platformSecretRewrapFailureInputSchema
>;

const failureCountsSchema = z
  .object({
    ciphertext_not_readable: z.number().int().nonnegative(),
    concurrent_change: z.number().int().nonnegative(),
    historical_key_unavailable: z.number().int().nonnegative(),
    invalid_ciphertext: z.number().int().nonnegative(),
  })
  .strict();

export const platformSecretRewrapResultSchema = z
  .object({
    categories: failureCountsSchema,
    examined: z.number().int().nonnegative(),
    externalArtifactGate: z.literal(PLATFORM_SECRET_REWRAP_EXTERNAL_GATE),
    failed: z.number().int().nonnegative(),
    historicalKeyRemovalReady: z.literal(false),
    noOp: z.number().int().nonnegative(),
    rotated: z.number().int().nonnegative(),
    schemaVersion: z.literal(1),
  })
  .strict();

export type PlatformSecretRewrapResult = z.infer<typeof platformSecretRewrapResultSchema>;

export const EMPTY_PLATFORM_SECRET_REWRAP_RESULT: PlatformSecretRewrapResult = {
  categories: {
    ciphertext_not_readable: 0,
    concurrent_change: 0,
    historical_key_unavailable: 0,
    invalid_ciphertext: 0,
  },
  examined: 0,
  externalArtifactGate: PLATFORM_SECRET_REWRAP_EXTERNAL_GATE,
  failed: 0,
  historicalKeyRemovalReady: false,
  noOp: 0,
  rotated: 0,
  schemaVersion: 1,
};

export const parsePlatformSecretRewrapInput = (
  job: PlatformJobItem,
): PlatformSecretRewrapJobInput => platformSecretRewrapJobInputSchema.parse(job.input);

export const parsePlatformSecretRewrapCursor = (
  cursor: PlatformJobItem['cursor'],
): PlatformSecretRewrapCursor | null => {
  if (cursor === null) return null;
  return platformSecretRewrapCursorSchema.parse(cursor);
};

export const parsePlatformSecretRewrapResult = (
  result: PlatformJobItem['resultSummary'],
): PlatformSecretRewrapResult => platformSecretRewrapResultSchema.parse(result);
