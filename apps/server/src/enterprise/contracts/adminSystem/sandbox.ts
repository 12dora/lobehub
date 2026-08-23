import { z } from 'zod';

import { reasonSchema, requireWhenEnabled } from './common';

export const adminSystemSandboxProviderSchema = z.enum(['local', 'market', 'onlyboxes']);
export const adminSystemSandboxPullPolicySchema = z.enum(['always', 'if-missing', 'never']);
export const adminSystemSandboxNetworkSchema = z.enum(['bridge', 'none']);

const requireSandboxLocalFields = (
  value: {
    enabled: boolean;
    provider?: 'local' | 'market' | 'onlyboxes';
  } & Record<string, unknown>,
  ctx: z.RefinementCtx,
): void => {
  if (!value.enabled) return;
  if (!value.provider) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider is required when enabled',
      path: ['provider'],
    });
    return;
  }
  if (value.provider !== 'local') return;
  requireWhenEnabled(true, ctx, [
    {
      message: 'dockerSocket is required when provider is local',
      path: ['dockerSocket'],
      present: Boolean(value.dockerSocket),
    },
    {
      message: 'image is required when provider is local',
      path: ['image'],
      present: Boolean(value.image),
    },
    {
      message: 'pullPolicy is required when provider is local',
      path: ['pullPolicy'],
      present: value.pullPolicy !== undefined,
    },
    {
      message: 'network is required when provider is local',
      path: ['network'],
      present: value.network !== undefined,
    },
    {
      message: 'memoryMb is required when provider is local',
      path: ['memoryMb'],
      present: value.memoryMb !== undefined,
    },
    {
      message: 'pidsLimit is required when provider is local',
      path: ['pidsLimit'],
      present: value.pidsLimit !== undefined,
    },
    {
      message: 'cpus is required when provider is local',
      path: ['cpus'],
      present: value.cpus !== undefined,
    },
    {
      message: 'timeoutMs is required when provider is local',
      path: ['timeoutMs'],
      present: value.timeoutMs !== undefined,
    },
    {
      message: 'maxOutputBytes is required when provider is local',
      path: ['maxOutputBytes'],
      present: value.maxOutputBytes !== undefined,
    },
    {
      message: 'idleTtlSec is required when provider is local',
      path: ['idleTtlSec'],
      present: value.idleTtlSec !== undefined,
    },
    {
      message: 'maxContainers is required when provider is local',
      path: ['maxContainers'],
      present: value.maxContainers !== undefined,
    },
  ]);
};

export const adminSystemSandboxSettingsConfigSchema = z
  .object({
    cpus: z.number().positive().optional(),
    dockerHost: z.string().trim().max(512).optional(),
    dockerSocket: z.string().trim().min(1).max(512).optional(),
    enabled: z.boolean(),
    idleTtlSec: z.number().int().positive().optional(),
    image: z.string().trim().min(1).max(256).optional(),
    maxContainers: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    memoryMb: z.number().int().positive().optional(),
    network: adminSystemSandboxNetworkSchema.optional(),
    pidsLimit: z.number().int().positive().optional(),
    provider: adminSystemSandboxProviderSchema.optional(),
    pullPolicy: adminSystemSandboxPullPolicySchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine(requireSandboxLocalFields);

export const adminSystemGetSandboxSettingsOutputSchema = z
  .object({
    cpus: z.number().positive(),
    dockerHost: z.string().trim().max(512).nullable(),
    dockerSocket: z.string().trim().min(1).max(512),
    enabled: z.boolean(),
    idleTtlSec: z.number().int().positive(),
    image: z.string().trim().min(1).max(256),
    maxContainers: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
    moduleEnabled: z.boolean(),
    network: adminSystemSandboxNetworkSchema,
    pidsLimit: z.number().int().positive(),
    provider: adminSystemSandboxProviderSchema,
    pullPolicy: adminSystemSandboxPullPolicySchema,
    revision: z.number().int().nonnegative(),
    source: z.enum(['db', 'env']),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export const adminSystemUpdateSandboxSettingsInputSchema = z
  .object({
    config: adminSystemSandboxSettingsConfigSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: reasonSchema.optional(),
  })
  .strict();

export const adminSystemUpdateSandboxSettingsOutputSchema =
  adminSystemGetSandboxSettingsOutputSchema;

export type AdminSystemGetSandboxSettings = z.infer<
  typeof adminSystemGetSandboxSettingsOutputSchema
>;
export type AdminSystemGetSandboxSettingsOutput = AdminSystemGetSandboxSettings;
export type AdminSystemSandboxSettingsConfig = z.infer<
  typeof adminSystemSandboxSettingsConfigSchema
>;
export type AdminSystemUpdateSandboxSettingsInput = z.input<
  typeof adminSystemUpdateSandboxSettingsInputSchema
>;
export type AdminSystemUpdateSandboxSettingsOutput = z.infer<
  typeof adminSystemUpdateSandboxSettingsOutputSchema
>;

// ---------------------------------------------------------------------------
// Sandbox package-install ledger (admin.system.getSandboxPackageStats)
// ---------------------------------------------------------------------------

export const SANDBOX_PACKAGE_MANAGERS = ['apt', 'npm', 'pip'] as const;
export const sandboxPackageManagerSchema = z.enum(SANDBOX_PACKAGE_MANAGERS);
export type SandboxPackageManager = z.infer<typeof sandboxPackageManagerSchema>;

export const adminSystemGetSandboxPackageStatsInputSchema = z
  .object({
    /** Look-back window in days (installs older than this are ignored). */
    days: z.number().int().min(1).max(365).default(30),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const adminSystemSandboxPackageStatSchema = z
  .object({
    /**
     * Lifetime install invocations (attempts, success not verified) of this package by the
     * users who touched it inside the window — the ledger keeps one counter per
     * (user, manager, package), not per event, so this is "how popular", not "how many this month".
     */
    installs: z.number().int().nonnegative(),
    lastInstalledAt: z.date(),
    manager: sandboxPackageManagerSchema,
    package: z.string().trim().min(1).max(120),
    /** Already baked into the sandbox image (Dockerfile.sandbox preinstall list). */
    preinstalled: z.boolean(),
    /** Distinct users who installed it in the window. */
    users: z.number().int().nonnegative(),
  })
  .strict();

export const adminSystemGetSandboxPackageStatsOutputSchema = z
  .object({
    generatedAt: z.date(),
    items: z.array(adminSystemSandboxPackageStatSchema).max(100),
    /** Current image preinstall list (pip package names, lowercase). */
    preinstalled: z.array(z.string()).max(200),
    /** Distinct (manager, package) pairs recorded in the window. */
    totalPackages: z.number().int().nonnegative(),
    windowDays: z.number().int().positive(),
  })
  .strict();

export type AdminSystemGetSandboxPackageStatsInput = z.input<
  typeof adminSystemGetSandboxPackageStatsInputSchema
>;
export type AdminSystemGetSandboxPackageStatsOutput = z.infer<
  typeof adminSystemGetSandboxPackageStatsOutputSchema
>;
export type AdminSystemSandboxPackageStat = z.infer<typeof adminSystemSandboxPackageStatSchema>;
