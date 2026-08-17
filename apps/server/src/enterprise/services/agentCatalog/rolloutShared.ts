import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { type PlatformJobItem, platformJobs } from '@/database/schemas/platform';

import { PlatformAgentInvalidInputError } from './errors';

export const PLATFORM_AGENT_ROLLOUT_JOB_TYPE = 'platform.agent.rollout.v1';

export const platformAgentRolloutCutoffSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

const rolloutJobInputSchema = z
  .object({
    control: z
      .object({
        phase: z.enum(['failed', 'targets']),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
    snapshot: z
      .object({
        agentId: z.string().min(1).max(128),
        assignmentId: z.string().min(1).max(128),
        previousVersionChecksum: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        previousVersionId: z.string().min(1).max(128).nullable(),
        rollbackOfJobId: z.string().min(1).max(128).nullable(),
        targetCutoff: platformAgentRolloutCutoffSchema,
        targetId: z.string().min(1).max(128),
        targetType: z.enum(['global', 'global_role', 'user']),
        targetVersionChecksum: z.string().regex(/^[a-f0-9]{64}$/),
        targetVersionId: z.string().min(1).max(128),
        versionPolicy: z.enum(['latest_published', 'pinned']),
      })
      .strict(),
  })
  .strict();

export type PlatformAgentRolloutJobInput = z.infer<typeof rolloutJobInputSchema>;

const rolloutResultSchema = z
  .object({
    failed: z.number().int().nonnegative(),
    previousVersionChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    previousVersionId: z.string().min(1).max(128).nullable().optional(),
  })
  .passthrough();

export const platformAgentRolloutJobRevision = sql<number>`COALESCE((${platformJobs.input}->'control'->>'revision')::int, 0)`;

export const parsePlatformAgentRolloutInput = (
  job: PlatformJobItem,
): PlatformAgentRolloutJobInput => {
  const parsed = rolloutJobInputSchema.safeParse(job.input);
  if (!parsed.success) throw new PlatformAgentInvalidInputError();
  return parsed.data;
};

export const getPlatformAgentRolloutResult = (job: PlatformJobItem) => {
  const parsed = rolloutResultSchema.safeParse(job.resultSummary);
  return parsed.success
    ? parsed.data
    : { failed: 0, previousVersionChecksum: null, previousVersionId: null };
};

export const persistenceStatus = (
  status: 'cancelled' | 'completed' | 'dead' | 'failed' | 'pending' | 'running',
) => (status === 'completed' ? ('succeeded' as const) : status);
