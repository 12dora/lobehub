import { z } from 'zod';

import {
  platformConvergenceDomainSchema,
  platformDomainConvergenceSchema,
} from '../platformInstanceStatus';
import { identityRevisionSchema, validateAvailability } from './common';

export const adminSystemDependencyStatusSchema = z.enum([
  'degraded',
  'disabled',
  'healthy',
  'unavailable',
  'unknown',
]);

export const adminSystemDependencyErrorCategorySchema = z.enum([
  'configuration_incomplete',
  'operation_unavailable',
  'passive_check_only',
  'timeout',
]);

const adminSystemDependencyHealthSchema = z
  .object({
    /**
     * Short operator-facing summary of what is configured (provider / engine /
     * target), e.g. "PostgreSQL", "S3 · lobe-files", "SMTP smtp.example.com:587",
     * "Vault". Never contains secrets. Rendered as the tile's first info line.
     */
    detail: z.string().trim().max(120).optional(),
    errorCategory: adminSystemDependencyErrorCategorySchema.nullable(),
    lastCheckedAt: z.date().nullable(),
    /** Round-trip of the last health check in milliseconds (absent when no live probe ran). */
    latencyMs: z.number().int().nonnegative().optional(),
    status: adminSystemDependencyStatusSchema,
    /** Server/engine version reported by the dependency, when cheaply available. */
    version: z.string().trim().max(64).optional(),
  })
  .strict();

export const adminSystemSandboxHealthSchema = adminSystemDependencyHealthSchema
  .extend({
    activeContainers: z.number().int().nonnegative(),
    daemonReachable: z.boolean(),
    imagePresent: z.boolean(),
    lastError: z.string().trim().max(500).optional(),
    maxContainers: z.number().int().positive(),
  })
  .strict();

export const adminSystemDocumentRenderHealthSchema = adminSystemDependencyHealthSchema
  .extend({
    configured: z.boolean(),
    lastError: z.string().trim().max(500).optional(),
    queuePending: z.number().int().nonnegative(),
    queueRunning: z.number().int().nonnegative(),
  })
  .strict();

export const adminSystemGetStatusOutputSchema = z
  .object({
    build: z
      .object({
        gitSha: z
          .string()
          .regex(/^[a-f0-9]{7,40}$/)
          .nullable(),
        version: z.string().trim().min(1).max(64),
      })
      .strict(),
    dependencies: z
      .object({
        database: adminSystemDependencyHealthSchema,
        documentRender: adminSystemDocumentRenderHealthSchema.optional(),
        keyManagement: adminSystemDependencyHealthSchema,
        mail: adminSystemDependencyHealthSchema,
        objectStorage: adminSystemDependencyHealthSchema,
        redis: adminSystemDependencyHealthSchema,
        sandbox: adminSystemSandboxHealthSchema.optional(),
      })
      .strict(),
    domains: z.array(platformDomainConvergenceSchema).max(8),
    featureFlags: z
      .object({
        databaseOidc: z.boolean(),
        managedAgents: z.boolean(),
        managedAi: z.boolean(),
        managedConnectors: z.boolean(),
        managedSkills: z.boolean(),
        platformAdmin: z.boolean(),
        runtimeBranding: z.boolean(),
        settingsPolicy: z.boolean(),
      })
      .strict(),
    instanceStatus: adminSystemDependencyHealthSchema,
    jobs: z
      .object({
        active: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        errorCategory: z.enum(['operation_unavailable']).nullable(),
        failed: z.number().int().nonnegative(),
        status: z.enum(['healthy', 'unavailable']),
        total: z.number().int().nonnegative(),
      })
      .strict()
      .superRefine(validateAvailability),
    oidc: z
      .object({
        activeRevision: identityRevisionSchema.nullable(),
        configured: z.boolean(),
        pendingRestart: z.boolean(),
        source: z.enum(['break_glass', 'database', 'disabled', 'environment', 'lkg', 'unknown']),
        status: adminSystemDependencyStatusSchema,
      })
      .strict(),
    recentPublishFailures: z
      .object({
        count: z.number().int().nonnegative(),
        errorCategory: z.enum(['operation_unavailable']).nullable(),
        items: z
          .array(
            z
              .object({
                category: z.enum([
                  'conflict',
                  'dependency_unavailable',
                  'operation_unavailable',
                  'unknown',
                  'validation',
                ]),
                domain: platformConvergenceDomainSchema,
                occurredAt: z.date(),
              })
              .strict(),
          )
          .max(10),
        status: z.enum(['healthy', 'unavailable']),
      })
      .strict()
      .superRefine(validateAvailability),
    snapshotAt: z.date(),
  })
  .strict();

export type AdminSystemSandboxHealth = z.infer<typeof adminSystemSandboxHealthSchema>;
export type AdminSystemDocumentRenderHealth = z.infer<typeof adminSystemDocumentRenderHealthSchema>;
