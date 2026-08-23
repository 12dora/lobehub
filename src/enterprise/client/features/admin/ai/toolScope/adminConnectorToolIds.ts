import { BUILTIN_ROW_PREFIX, PLATFORM_TOOL_PREFIX } from './adminToolScopeHelpers';

/**
 * Synthetic tool ids carry their owner in the middle segment:
 * `admin-builtin:<identifier>:<toolName>` / `platform:<connectorId>:<toolKey>`.
 * The trailing name may itself contain ':', so only the first two segments split.
 */
export const splitPrefixedToolId = (toolId: string): { name: string; owner: string } => {
  const [, owner, ...nameParts] = toolId.split(':');
  return { name: nameParts.join(':'), owner };
};

export interface ConnectorToolIdGroups {
  /** builtin identifier → tool names editing the org governance matrix. */
  builtinByIdentifier: Map<string, string[]>;
  /** platform connector id → tool keys editing that connector document. */
  platformByConnector: Map<string, string[]>;
}

/**
 * Group a bulk selection by backing document so each document takes exactly one
 * write. Unparsable / foreign ids are dropped.
 */
export const groupToolIdsByTarget = (toolIds: string[]): ConnectorToolIdGroups => {
  const builtinByIdentifier = new Map<string, string[]>();
  const platformByConnector = new Map<string, string[]>();

  for (const toolId of toolIds) {
    if (toolId.startsWith(BUILTIN_ROW_PREFIX)) {
      const { name: toolName, owner: identifier } = splitPrefixedToolId(toolId);
      if (!identifier || !toolName) continue;
      builtinByIdentifier.set(identifier, [
        ...(builtinByIdentifier.get(identifier) ?? []),
        toolName,
      ]);
      continue;
    }
    if (!toolId.startsWith(PLATFORM_TOOL_PREFIX)) continue;
    const { name: toolKey, owner: connectorId } = splitPrefixedToolId(toolId);
    if (!connectorId || !toolKey) continue;
    platformByConnector.set(connectorId, [
      ...(platformByConnector.get(connectorId) ?? []),
      toolKey,
    ]);
  }

  return { builtinByIdentifier, platformByConnector };
};
