import { ConnectorModel } from '@/database/models/connector';
import { ConnectorToolModel } from '@/database/models/connectorTool';
import type { LobeChatDatabase } from '@/database/type';

export const loadLegacyToolPermissionOverlay = async (params: {
  connectorKeys: string[];
  db: LobeChatDatabase;
  userId: string;
  workspaceId?: string;
}): Promise<{
  permissionsFor: (connectorKey: string) => Map<string, string>;
}> => {
  const legacyConnectors = await new ConnectorModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByIdentifiers(params.connectorKeys);
  const legacyByKey = new Map(
    legacyConnectors.map((connector) => [connector.identifier, connector]),
  );
  const legacyTools = await new ConnectorToolModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryAllByConnectorIds(legacyConnectors.map((connector) => connector.id));
  const legacyToolsByConnector = new Map<string, typeof legacyTools>();
  for (const tool of legacyTools) {
    const current = legacyToolsByConnector.get(tool.userConnectorId) ?? [];
    current.push(tool);
    legacyToolsByConnector.set(tool.userConnectorId, current);
  }

  return {
    permissionsFor: (connectorKey: string) => {
      const legacyConnector = legacyByKey.get(connectorKey);
      return new Map(
        (legacyConnector ? (legacyToolsByConnector.get(legacyConnector.id) ?? []) : []).map(
          (tool) => [tool.toolName, tool.permission],
        ),
      );
    },
  };
};

export const resolveLegacyPermission = async (params: {
  connectorKey: string;
  db: LobeChatDatabase;
  toolKey: string;
  userId: string;
  workspaceId?: string;
}) => {
  const [connector] = await new ConnectorModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByIdentifiers([params.connectorKey]);
  if (!connector) return null;
  const tools = await new ConnectorToolModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByConnector(connector.id);
  return tools.find((tool) => tool.toolName === params.toolKey)?.permission ?? null;
};
