import { z } from 'zod';

import { identityRevisionSchema, instanceIdSchema, reasonSchema } from './common';

export const adminSystemAuthSnapshotStatusOutputSchema = z
  .object({
    active: z.object({
      allFreshInstancesActive: z.boolean(),
      partial: z.boolean(),
      staleInstances: z.number().int().nonnegative(),
    }),
    artifact: z.object({
      degradedCategory: z
        .string()
        .regex(/^[a-z0-9_]{1,128}$/)
        .nullable(),
      generation: z.string().nullable(),
      health: z.enum(['degraded', 'healthy']),
      identityRevision: identityRevisionSchema.nullable(),
      instanceId: instanceIdSchema,
      loadedAt: z.date(),
      source: z.enum(['break_glass', 'database', 'environment', 'lkg']),
    }),
    instances: z.array(
      z.object({
        activeIdentityRevision: identityRevisionSchema.nullable(),
        degradedCategory: z
          .string()
          .regex(/^[a-z0-9_]{1,128}$/)
          .nullable(),
        fresh: z.boolean(),
        health: z.enum(['degraded', 'healthy']),
        hostnameHash: identityRevisionSchema,
        instanceId: instanceIdSchema,
        lastHeartbeat: z.date(),
        loadedAt: z.date(),
        startedAt: z.date(),
        startupGeneration: z.string().nullable(),
        startupSource: z.enum(['break_glass', 'database', 'environment', 'lkg']),
      }),
    ),
    pendingPublished: z.array(
      z.object({
        blockedCategory: z.enum(['environment_provider_shadowed']).nullable(),
        providerId: z.string().min(1),
        providerKey: z.string().min(1),
        publishedRevision: z.number().int().positive(),
      }),
    ),
    pendingRestart: z.boolean(),
    restart: z.object({
      reason: z
        .enum([
          'edge_runtime',
          'environment_provider_shadowed',
          'no_pending_restart',
          'serverless_runtime',
          'supervisor_not_configured',
          'test_runtime',
        ])
        .nullable(),
      supported: z.boolean(),
    }),
    /**
     * Most recent accepted/signaled/failed restart request for this instance.
     * Lets the admin UI fail closed immediately when scheduling fails, instead of
     * waiting for the convergence deadline.
     */
    restartRequest: z
      .object({
        requestId: z.string().uuid(),
        resultCategory: z
          .string()
          .regex(/^[a-z0-9_]{1,128}$/)
          .nullable(),
        status: z.enum(['accepted', 'failed', 'signaled']),
      })
      .nullable(),
    /**
     * Bounded recent restart requests for this instance (newest first).
     * Concurrent restarts must not hide a failed request the admin is polling.
     */
    restartRequests: z
      .array(
        z.object({
          requestId: z.string().uuid(),
          resultCategory: z
            .string()
            .regex(/^[a-z0-9_]{1,128}$/)
            .nullable(),
          status: z.enum(['accepted', 'failed', 'signaled']),
        }),
      )
      .max(32),
    targetIdentityRevision: identityRevisionSchema.nullable(),
  })
  .strict();

export const adminSystemPrepareRestartInputSchema = z
  .object({ reason: reasonSchema, requestId: z.string().uuid() })
  .strict();
export const adminSystemPrepareRestartOutputSchema = z
  .object({
    expectedIdentityRevision: identityRevisionSchema,
    expiresAt: z.date(),
    intentToken: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().uuid(),
  })
  .strict();

export const adminSystemRequestRestartInputSchema = adminSystemPrepareRestartInputSchema
  .extend({ intentToken: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const adminSystemRequestRestartOutputSchema = z
  .object({
    accepted: z.literal(true),
    acceptedAt: z.date(),
    convergenceDeadlineAt: z.date(),
    duplicate: z.boolean(),
    expectedIdentityRevision: identityRevisionSchema,
    remainingMs: z.number().int().nonnegative().max(120_000),
    requestId: z.string().uuid(),
    serverNow: z.date(),
    status: z.enum(['accepted', 'signaled']),
  })
  .strict();

export type AdminSystemPrepareRestartInput = z.infer<typeof adminSystemPrepareRestartInputSchema>;
export type AdminSystemRequestRestartInput = z.infer<typeof adminSystemRequestRestartInputSchema>;
