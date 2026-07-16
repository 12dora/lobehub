import type { ComposioServer, ComposioTool, CreateComposioServerParams } from './types';

export const buildComposioCreateConnectionInput = (params: CreateComposioServerParams) => ({
  appSlug: params.appSlug,
  identifier: params.identifier,
  label: params.label,
});

export const buildComposioOwnedDeleteInput = (server: ComposioServer) => ({
  connectedAccountId: server.connectedAccountId,
  identifier: server.identifier,
});

export const buildComposioPluginUpdateInput = (server: ComposioServer, tools: ComposioTool[]) => ({
  appSlug: server.appSlug,
  authConfigId: server.authConfigId,
  connectedAccountId: server.connectedAccountId,
  identifier: server.identifier,
  label: server.label,
  status: 'ACTIVE' as const,
  tools: tools.map((tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
  })),
});

export const createOwnedComposioConnection = <Result>(params: {
  createConnection: (
    input: ReturnType<typeof buildComposioCreateConnectionInput>,
  ) => Promise<Result>;
  input: CreateComposioServerParams;
}) => params.createConnection(buildComposioCreateConnectionInput(params.input));

export const deleteOwnedComposioConnection = <Result>(params: {
  deleteConnection: (input: ReturnType<typeof buildComposioOwnedDeleteInput>) => Promise<Result>;
  server: ComposioServer;
}) => params.deleteConnection(buildComposioOwnedDeleteInput(params.server));

export const updateActiveComposioPlugin = <Result>(params: {
  server: ComposioServer;
  tools: ComposioTool[];
  updatePlugin: (input: ReturnType<typeof buildComposioPluginUpdateInput>) => Promise<Result>;
}) => params.updatePlugin(buildComposioPluginUpdateInput(params.server, params.tools));
