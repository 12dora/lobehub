import { z } from 'zod';

import { reasonSchema } from './platformConnectors';

/**
 * Org connector governance contracts (`admin.connectors.getGovernance` /
 * `updateBuiltinToolPolicy` / `setSharedAuthorization`).
 * Doc shape mirrors `ConnectorGovernanceDoc` in `@lobechat/types`.
 */

const MAX_GOVERNANCE_IDENTIFIERS = 200;
const MAX_GOVERNANCE_TOOLS_PER_IDENTIFIER = 200;

export const connectorGovernancePermissionSchema = z.enum(['auto', 'needs_approval', 'disabled']);

const governanceIdentifierSchema = z.string().min(1).max(128);
const governanceToolNameSchema = z.string().min(1).max(200);

export const connectorBuiltinToolPolicyMapSchema = z
  .record(
    governanceIdentifierSchema,
    z
      .record(governanceToolNameSchema, connectorGovernancePermissionSchema)
      .refine(
        (tools) => Object.keys(tools).length <= MAX_GOVERNANCE_TOOLS_PER_IDENTIFIER,
        `at most ${MAX_GOVERNANCE_TOOLS_PER_IDENTIFIER} tools per identifier`,
      ),
  )
  .refine(
    (map) => Object.keys(map).length <= MAX_GOVERNANCE_IDENTIFIERS,
    `at most ${MAX_GOVERNANCE_IDENTIFIERS} identifiers`,
  );

const governanceOwnerUserIdSchema = z.string().trim().min(1).max(128);

export const connectorGovernanceDocSchema = z.object({
  builtinToolPolicies: connectorBuiltinToolPolicyMapSchema,
  sharedAuthorization: z.object({ ownerUserId: governanceOwnerUserIdSchema.nullable() }),
});

export const adminConnectorGovernanceGetOutputSchema = z.object({
  doc: connectorGovernanceDocSchema,
  /** Effective-enforced hint (feature flag + managed + enforced) for the UI. */
  managedActive: z.boolean(),
  revision: z.number().int().min(0),
});

export const adminConnectorGovernanceRevisionOutputSchema = z.object({
  revision: z.number().int().min(0),
});

export const adminConnectorUpdateBuiltinToolPolicyInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  policies: connectorBuiltinToolPolicyMapSchema,
  reason: reasonSchema,
});

export const adminConnectorSetSharedAuthorizationInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  /** null clears the shared identity (back to per-user authorization). */
  ownerUserId: governanceOwnerUserIdSchema.nullable(),
  reason: reasonSchema,
});
