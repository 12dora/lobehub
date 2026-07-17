import type { z } from 'zod';

import { checksumPayload } from '@/database/models/platform';

import {
  connectorEffectiveToolPolicyInputSchema,
  connectorEffectiveToolPolicyOutputSchema,
  connectorPlatformToolPolicySchema,
  connectorRiskLevelSchema,
  connectorScopesSchema,
} from '../../contracts/platformConnectors';
import { PlatformConnectorContractError } from './errors';

type ConnectorEffectiveToolPolicyInput = z.infer<typeof connectorEffectiveToolPolicyInputSchema>;
type ConnectorEffectiveToolPolicyOutput = z.infer<typeof connectorEffectiveToolPolicyOutputSchema>;
interface ConnectorToolPolicySource {
  platformPolicy: z.infer<typeof connectorPlatformToolPolicySchema>;
  requiresConfirmation: boolean;
  riskLevel: z.infer<typeof connectorRiskLevelSchema>;
  toolKey: string;
}

/** Platform deny wins; agent allow is an intersection; users can only disable. */
export const resolveEffectiveConnectorToolPolicy = (
  input: ConnectorEffectiveToolPolicyInput,
): ConnectorEffectiveToolPolicyOutput => {
  const parsed = connectorEffectiveToolPolicyInputSchema.parse(input);
  if (parsed.platformPolicy === 'deny') return { allowed: false, deniedBy: 'platform' };
  if (!parsed.agentAllowed) return { allowed: false, deniedBy: 'agent' };
  if (!parsed.userEnabled) return { allowed: false, deniedBy: 'user' };
  return connectorEffectiveToolPolicyOutputSchema.parse({ allowed: true, deniedBy: null });
};

/** Requested scopes must be a strict subset of the administrator-published allowlist. */
export const assertConnectorScopesAllowed = (allowed: string[], requested: string[]): string[] => {
  const allowedScopes = connectorScopesSchema.parse(allowed);
  const requestedScopes = connectorScopesSchema.parse(requested);
  const allowedSet = new Set(allowedScopes);
  if (requestedScopes.some((scope) => !allowedSet.has(scope))) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED');
  }
  return requestedScopes;
};

/** Revision checksum freezes schema; this separately freezes every executable policy bit. */
export const fingerprintConnectorToolPolicy = (tools: ConnectorToolPolicySource[]): string =>
  checksumPayload(
    tools
      .map((tool) => ({
        platformPolicy: connectorPlatformToolPolicySchema.parse(tool.platformPolicy),
        requiresConfirmation: tool.requiresConfirmation,
        riskLevel: connectorRiskLevelSchema.parse(tool.riskLevel),
        toolKey: tool.toolKey,
      }))
      .sort((left, right) => left.toolKey.localeCompare(right.toolKey)),
  );

/** Platform confirmation is a floor: agent/user preferences may tighten but never relax it. */
export const resolveConnectorConfirmationPolicy = (input: {
  legacyRequiresConfirmation?: boolean;
  requiresConfirmation: boolean;
  riskLevel: z.infer<typeof connectorRiskLevelSchema>;
}): 'always' | null => {
  const riskLevel = connectorRiskLevelSchema.parse(input.riskLevel);
  return input.requiresConfirmation ||
    input.legacyRequiresConfirmation === true ||
    riskLevel === 'high' ||
    riskLevel === 'critical'
    ? 'always'
    : null;
};
