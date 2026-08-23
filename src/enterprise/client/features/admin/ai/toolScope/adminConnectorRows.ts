import type { LobeBuiltinTool } from '@lobechat/types';

import { ConnectorToolPermission } from '@/database/schemas';
import type { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { inferCrudType } from '@/libs/mcp/utils';
import type { ConnectorTool, ConnectorWithTools } from '@/store/tool/slices/connector/types';

import type { AdminConnectorGetOutput } from '../../connectors/types';
import {
  BUILTIN_ROW_PREFIX,
  PLATFORM_TOOL_PREFIX,
  policyToPermission,
} from './adminToolScopeHelpers';

type GovernanceDoc = Awaited<ReturnType<typeof adminConnectorsService.getGovernance>>['doc'];
export type BuiltinToolPolicies = GovernanceDoc['builtinToolPolicies'];

/**
 * Builtin in-process tools, synthesized from the static manifests with the
 * same crud grouping the user connector sync applies server-side.
 */
export const buildBuiltinConnectorRows = (
  builtinTools: LobeBuiltinTool[],
  builtinToolPolicies: BuiltinToolPolicies | undefined,
): ConnectorWithTools[] =>
  builtinTools
    .filter((tool) => !tool.hidden)
    .map((tool) => {
      const api = (tool.manifest?.api ?? []) as {
        description?: string;
        name: string;
        parameters?: Record<string, unknown>;
      }[];
      const identifierPolicies = builtinToolPolicies?.[tool.identifier];
      const tools: ConnectorTool[] = api.map((entry) => ({
        crudType: inferCrudType(entry.name),
        description: entry.description ?? null,
        displayName: entry.name,
        id: `${BUILTIN_ROW_PREFIX}${tool.identifier}:${entry.name}`,
        inputSchema: (entry.parameters ?? null) as Record<string, unknown> | null,
        permission: (identifierPolicies?.[entry.name] ??
          ConnectorToolPermission.auto) as ConnectorToolPermission,
        toolName: entry.name,
        userConnectorId: `${BUILTIN_ROW_PREFIX}${tool.identifier}`,
      }));
      return {
        credentials: null,
        id: `${BUILTIN_ROW_PREFIX}${tool.identifier}`,
        identifier: tool.identifier,
        isEnabled: true,
        mcpConnectionType: null,
        mcpServerUrl: null,
        metadata: null,
        name: tool.title || tool.identifier,
        sourceType: 'builtin',
        status: 'connected',
        tools,
      };
    });

/** Platform connector drafts, rendered as connector rows with their tool policies. */
export const buildPlatformConnectorRows = (
  connectorDetails: AdminConnectorGetOutput[],
): ConnectorWithTools[] =>
  connectorDetails
    .filter((detail) => detail.draft.status !== 'archived')
    .map((detail) => ({
      credentials: null,
      id: detail.draft.id,
      identifier: detail.draft.key,
      isEnabled: detail.draft.enabled ?? true,
      mcpConnectionType: 'http',
      mcpServerUrl: detail.draft.endpoint,
      metadata: detail.draft.description ? { description: detail.draft.description } : null,
      name: detail.draft.displayName,
      sourceType: 'custom',
      status: detail.published ? 'connected' : 'disconnected',
      tools: (detail.draft.tools ?? []).map((tool): ConnectorTool => ({
        crudType: inferCrudType(tool.toolKey),
        description: tool.description ?? null,
        displayName: tool.displayName ?? null,
        id: `${PLATFORM_TOOL_PREFIX}${detail.draft.id}:${tool.toolKey}`,
        inputSchema: (tool.inputSchema ?? null) as Record<string, unknown> | null,
        permission: policyToPermission(tool),
        toolName: tool.toolKey,
        userConnectorId: detail.draft.id,
      })),
    }));
