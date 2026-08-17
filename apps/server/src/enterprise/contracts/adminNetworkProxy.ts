/**
 * Strict contracts for `admin.networkProxy.*` (design §5 / B0_INTERFACE §4).
 *
 * Procedure inputs/outputs are all `.strict()`. DTO schemas are re-exported from
 * `@/types/platform/networkProxy` so B5 and the router share one source of truth.
 */
import { z } from 'zod';

import {
  artifactStatusViewSchema,
  desiredArtifactsSchema,
  egressScopeOpSchema,
  networkProxyArtifactKindSchema,
  networkProxyConfigUpdateSchema,
  networkProxyConfigViewSchema,
  networkProxyEngineStateSchema,
  networkProxyStatusViewSchema,
  proxyNodeViewSchema,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
  subscriptionViewSchema,
} from '@/types/platform/networkProxy';

import { secretSafeAuditReasonSchema } from './shared';

export {
  artifactStatusViewSchema,
  desiredArtifactsSchema,
  egressScopeOpSchema,
  networkProxyArtifactKindSchema,
  networkProxyConfigUpdateSchema,
  networkProxyConfigViewSchema,
  networkProxyEngineStateSchema,
  networkProxyStatusViewSchema,
  proxyNodeViewSchema,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
  subscriptionViewSchema,
};

const expectedRevisionSchema = z.number().int().nonnegative();
const optionalReasonSchema = secretSafeAuditReasonSchema.optional();

/** Shared CAS settings payload returned by getSettings and every settings write. */
export const adminNetworkProxySettingsOutputSchema = z
  .object({
    config: networkProxyConfigViewSchema,
    desiredArtifacts: desiredArtifactsSchema,
    engineGeneration: z.number().int().nonnegative(),
    globalProxyActive: z.boolean(),
    revision: expectedRevisionSchema,
  })
  .strict();
export type AdminNetworkProxySettingsOutput = z.infer<typeof adminNetworkProxySettingsOutputSchema>;

/** Per-instance local kick after a committed desired-state write. */
export const adminNetworkProxyLocalOutcomeSchema = z
  .object({
    error: z.string().nullable(),
    ok: z.boolean(),
  })
  .strict();
export type AdminNetworkProxyLocalOutcome = z.infer<typeof adminNetworkProxyLocalOutcomeSchema>;

/**
 * Settings write that also kicks the answering instance (install / restart / selectNode).
 * `local` reports that instance's post-commit outcome; the DB write already succeeded.
 *
 * B5: `installArtifact` / `restartEngine` / `selectNode` return this type (not
 * `AdminNetworkProxySettingsOutput`). Inspect `local.ok` for the answering
 * instance; a false value is a per-instance failure, not a CAS rollback.
 */
export const adminNetworkProxySettingsMutationOutputSchema = adminNetworkProxySettingsOutputSchema
  .extend({ local: adminNetworkProxyLocalOutcomeSchema })
  .strict();
export type AdminNetworkProxySettingsMutationOutput = z.infer<
  typeof adminNetworkProxySettingsMutationOutputSchema
>;

export const adminNetworkProxyGetSettingsOutputSchema = adminNetworkProxySettingsOutputSchema;
export const adminNetworkProxyGetStatusOutputSchema = networkProxyStatusViewSchema;

export const adminNetworkProxyListSubscriptionsOutputSchema = z
  .object({
    items: z.array(subscriptionViewSchema),
  })
  .strict();

export const adminNetworkProxyListNodesOutputSchema = z
  .object({
    engineState: networkProxyEngineStateSchema,
    instanceId: z.string().min(1),
    nodes: z.array(proxyNodeViewSchema),
  })
  .strict();

export const adminNetworkProxyGetEngineLogsOutputSchema = z
  .object({
    instanceId: z.string().min(1),
    lines: z.array(z.string()),
  })
  .strict();

export const adminNetworkProxyGetArtifactStatusOutputSchema = artifactStatusViewSchema;

export const adminNetworkProxyUpdateSettingsInputSchema = z
  .object({
    config: networkProxyConfigUpdateSchema,
    expectedRevision: expectedRevisionSchema,
    reason: optionalReasonSchema,
  })
  .strict();

export const adminNetworkProxyUpdateScopesInputSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    ops: z.array(egressScopeOpSchema).min(1).max(500),
  })
  .strict();

export const adminNetworkProxyCreateSubscriptionInputSchema = subscriptionCreateSchema;
export const adminNetworkProxyUpdateSubscriptionInputSchema = subscriptionUpdateSchema;

export const adminNetworkProxyDeleteSubscriptionInputSchema = z
  .object({
    id: z.string().min(1),
    reason: optionalReasonSchema,
  })
  .strict();

export const adminNetworkProxyDeleteSubscriptionOutputSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export const adminNetworkProxyRefreshSubscriptionInputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export const adminNetworkProxyTestLatencyInputSchema = z
  .object({
    nodeName: z.string().min(1).max(200).optional(),
  })
  .strict();

export const adminNetworkProxyTestLatencyOutputSchema = z
  .object({
    instanceId: z.string().min(1),
    nodes: z.array(proxyNodeViewSchema),
  })
  .strict();

export const adminNetworkProxySelectNodeInputSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    nodeName: z.string().min(1).max(200),
  })
  .strict();

export const adminNetworkProxyInstallArtifactInputSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    kind: networkProxyArtifactKindSchema,
  })
  .strict();

export const adminNetworkProxyRestartEngineInputSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
  })
  .strict();

export const adminNetworkProxyTestConnectivityInputSchema = z.object({}).strict();

export const adminNetworkProxyTestConnectivityOutputSchema = z
  .object({
    egressIp: z.string().nullable(),
    error: z.string().nullable(),
    latencyMs: z.number().int().nullable(),
    ok: z.boolean(),
  })
  .strict();
