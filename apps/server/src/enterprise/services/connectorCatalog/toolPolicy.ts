import type { z } from 'zod';

import {
  connectorEffectiveToolPolicyInputSchema,
  connectorEffectiveToolPolicyOutputSchema,
  connectorScopesSchema,
} from '../../contracts/platformConnectors';
import { PlatformConnectorContractError } from './errors';

type ConnectorEffectiveToolPolicyInput = z.infer<typeof connectorEffectiveToolPolicyInputSchema>;
type ConnectorEffectiveToolPolicyOutput = z.infer<typeof connectorEffectiveToolPolicyOutputSchema>;

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
