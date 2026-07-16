import type { ComposioServer, CreateComposioServerParams } from './types';

export const buildComposioCreateConnectionInput = (params: CreateComposioServerParams) => ({
  appSlug: params.appSlug,
  identifier: params.identifier,
  label: params.label,
});

export const buildComposioOwnedDeleteInput = (server: ComposioServer) => ({
  connectedAccountId: server.connectedAccountId,
  identifier: server.identifier,
});

export const buildComposioOwnedStatusInput = (server: ComposioServer) => ({
  identifier: server.identifier,
});

export const buildComposioPluginUpdateInput = (server: ComposioServer) => ({
  appSlug: server.appSlug,
  authConfigId: server.authConfigId,
  connectedAccountId: server.connectedAccountId,
  identifier: server.identifier,
  label: server.label,
  status: 'ACTIVE' as const,
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
  updatePlugin: (input: ReturnType<typeof buildComposioPluginUpdateInput>) => Promise<Result>;
}) => params.updatePlugin(buildComposioPluginUpdateInput(params.server));
