import type { z } from 'zod';

import {
  connectorRuntimeResolutionSchema,
  connectorRuntimeResolveInputSchema,
  publishedConnectorToolSchema,
  trustedConnectorOAuthBindingSchema,
  trustedPublishedConnectorSchema,
} from '../../contracts/platformConnectors';
import { PlatformConnectorContractError } from './errors';
import { resolveEffectiveConnectorToolPolicy } from './toolPolicy';

type RuntimeResolveInput = z.input<typeof connectorRuntimeResolveInputSchema>;
type TrustedPublishedConnector = z.input<typeof trustedPublishedConnectorSchema>;
type TrustedOAuthBinding = z.input<typeof trustedConnectorOAuthBindingSchema>;

interface ResolveConnectorRuntimeOptions {
  binding?: TrustedOAuthBinding | null;
  catalog: TrustedPublishedConnector;
  input: RuntimeResolveInput;
  now?: Date;
}

/** Resolve only from a trusted Published catalog snapshot and a caller-owned binding. */
export const resolveConnectorRuntime = (options: ResolveConnectorRuntimeOptions) => {
  const input = connectorRuntimeResolveInputSchema.parse(options.input);
  const catalog = trustedPublishedConnectorSchema.parse(options.catalog);
  const now = options.now ?? new Date();

  if (
    catalog.connectorId !== input.connectorId ||
    catalog.publishedRevision !== input.expectedPublishedRevision
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }

  const tool = catalog.tools.find((candidate) => candidate.toolKey === input.toolKey);
  if (!tool || !tool.enabled) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
  }
  const policy = resolveEffectiveConnectorToolPolicy({
    agentAllowed: input.agentAllowed,
    platformPolicy: tool.platformPolicy,
    userEnabled: input.userEnabled,
  });
  if (!policy.allowed) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
  }
  const runtimeTool = publishedConnectorToolSchema.parse({
    description: tool.description,
    displayName: tool.displayName,
    inputSchema: tool.inputSchema,
    platformPolicy: tool.platformPolicy,
    requiresConfirmation: tool.requiresConfirmation,
    riskLevel: tool.riskLevel,
    sort: tool.sort,
    toolKey: tool.toolKey,
  });

  const base = {
    connectorId: catalog.connectorId,
    endpoint: catalog.endpoint,
    publishedRevision: catalog.publishedRevision,
    tool: runtimeTool,
    transport: catalog.transport,
  };
  if (catalog.credentialMode === 'none') {
    return connectorRuntimeResolutionSchema.parse({ ...base, credentialMode: 'none' });
  }
  if (catalog.credentialMode === 'shared_service_account') {
    return connectorRuntimeResolutionSchema.parse({
      ...base,
      credentialMode: 'shared_service_account',
      credentials: catalog.credentials,
    });
  }

  const binding = trustedConnectorOAuthBindingSchema.safeParse(options.binding);
  if (
    !binding.success ||
    binding.data.connectorId !== catalog.connectorId ||
    binding.data.userId !== input.userId ||
    binding.data.publishedRevision !== catalog.publishedRevision ||
    (binding.data.expiresAt !== null && binding.data.expiresAt <= now)
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
  }
  return connectorRuntimeResolutionSchema.parse({
    ...base,
    accessToken: binding.data.accessToken,
    bindingId: binding.data.bindingId,
    credentialMode: 'per_user_oauth',
    expiresAt: binding.data.expiresAt,
    scopes: binding.data.scopes,
    userId: binding.data.userId,
  });
};
