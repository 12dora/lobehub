// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { composioRouter } from './composio';

const mocks = vi.hoisted(() => ({
  // composio client
  authConfigsCreate: vi.fn(),
  authConfigsList: vi.fn(),
  connectedAccountsDelete: vi.fn(),
  connectedAccountsGet: vi.fn(),
  connectedAccountsLink: vi.fn(),
  connectorCreate: vi.fn(),
  connectorDelete: vi.fn(),
  connectorFindById: vi.fn(),
  connectorQueryByIdentifiers: vi.fn(),
  connectorToolDeleteToolsNotIn: vi.fn(),
  connectorToolUpsertMany: vi.fn(),
  connectorUpdate: vi.fn(),
  getRawComposioTools: vi.fn(),
  // config
  getServerComposioAuthConfigId: vi.fn(),
  // plugin model
  pluginCreate: vi.fn(),
  pluginDelete: vi.fn(),
  pluginFindById: vi.fn(),
  pluginUpdate: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));

vi.mock('@/config/composio', () => ({
  getServerComposioAuthConfigId: mocks.getServerComposioAuthConfigId,
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    create: mocks.pluginCreate,
    delete: mocks.pluginDelete,
    findById: mocks.pluginFindById,
    update: mocks.pluginUpdate,
  })),
}));

vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi.fn().mockImplementation(() => ({
    create: mocks.connectorCreate,
    delete: mocks.connectorDelete,
    findById: mocks.connectorFindById,
    queryByIdentifiers: mocks.connectorQueryByIdentifiers,
    update: mocks.connectorUpdate,
  })),
}));

vi.mock('@/database/models/connectorTool', () => ({
  ConnectorToolModel: vi.fn().mockImplementation(() => ({
    deleteToolsNotIn: mocks.connectorToolDeleteToolsNotIn,
    upsertMany: mocks.connectorToolUpsertMany,
  })),
}));

vi.mock('@/libs/composio', () => ({
  getComposioClient: () => ({
    authConfigs: { create: mocks.authConfigsCreate, list: mocks.authConfigsList },
    connectedAccounts: {
      delete: mocks.connectedAccountsDelete,
      get: mocks.connectedAccountsGet,
      link: mocks.connectedAccountsLink,
    },
    tools: { getRawComposioTools: mocks.getRawComposioTools },
  }),
}));

const caller = () => composioRouter.createCaller({ userId: 'user-1' } as any);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectorQueryByIdentifiers.mockResolvedValue([]);
  mocks.connectorFindById.mockResolvedValue(null);
  mocks.connectorCreate.mockResolvedValue({ id: 'conn-new' });
  mocks.pluginFindById.mockResolvedValue(undefined);
  mocks.connectedAccountsGet.mockResolvedValue({
    authConfig: { id: 'ac_env' },
    id: 'ca-1',
    status: 'ACTIVE' as const,
    toolkit: { slug: 'GMAIL' },
  });
});

describe('composioRouter.createConnection dual-write', () => {
  it('mirrors a pending connection into user_connectors + tools', async () => {
    mocks.getServerComposioAuthConfigId.mockReturnValue('ac_env');
    mocks.connectedAccountsLink.mockResolvedValue({ id: 'ca-1', redirectUrl: 'https://auth' });
    mocks.getRawComposioTools.mockResolvedValue({
      items: [{ description: 'send', inputParameters: { type: 'object' }, slug: 'GMAIL_SEND' }],
    });

    await caller().createConnection({ appSlug: 'GMAIL', identifier: 'gmail', label: 'Gmail' });

    // plugin write kept (backward compat)
    expect(mocks.pluginCreate).toHaveBeenCalledTimes(1);
    // connector projection created with PENDING composio metadata
    expect(mocks.connectorCreate).toHaveBeenCalledTimes(1);
    expect(mocks.connectorCreate.mock.calls[0][0]).toMatchObject({
      identifier: 'gmail',
      metadata: { composio: { connectedAccountId: 'ca-1', status: 'PENDING' } },
      status: 'disconnected',
    });
    // tools seeded
    expect(mocks.connectorToolUpsertMany).toHaveBeenCalledWith('conn-new', [
      expect.objectContaining({ toolName: 'GMAIL_SEND' }),
    ]);
    // pre-auth seed must NOT prune (tool list may be incomplete before auth)
    expect(mocks.connectorToolDeleteToolsNotIn).not.toHaveBeenCalled();
  });

  it('rejects catalog mismatches and unknown definition fields before linking', async () => {
    await expect(
      caller().createConnection({ appSlug: 'SLACK', identifier: 'gmail', label: 'Gmail' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().createConnection({
        appSlug: 'GMAIL',
        credentials: { token: 'attacker' },
        identifier: 'gmail',
        label: 'Gmail',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.connectedAccountsLink).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a non-Composio connector definition', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([
      { id: 'custom', identifier: 'gmail', sourceType: 'custom' },
    ]);

    await expect(
      caller().createConnection({ appSlug: 'GMAIL', identifier: 'gmail', label: 'Gmail' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.connectedAccountsLink).not.toHaveBeenCalled();
  });
});

describe('composioRouter.updateComposioPlugin dual-write', () => {
  const input = {
    appSlug: 'GMAIL',
    authConfigId: 'ac_env',
    connectedAccountId: 'ca-1',
    identifier: 'gmail',
    label: 'Gmail',
    status: 'ACTIVE' as const,
    tools: [{ description: 'send', inputSchema: { type: 'object' }, name: 'GMAIL_SEND' }],
  };
  const trustedBinding = {
    appSlug: 'GMAIL',
    authConfigId: 'ac_env',
    connectedAccountId: 'ca-1',
    status: 'PENDING' as const,
  };
  const trustedPlugin = {
    customParams: { composio: trustedBinding },
    identifier: 'gmail',
    source: 'composio',
  };
  const trustedConnector = {
    id: 'conn-existing',
    identifier: 'gmail',
    metadata: { composio: trustedBinding },
    sourceType: 'marketplace',
  };

  it('creates a missing connector projection from an owned legacy plugin and server tools', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([]);
    mocks.pluginFindById.mockResolvedValue(trustedPlugin);
    mocks.getRawComposioTools.mockResolvedValue({
      items: [
        {
          description: 'trusted send',
          inputParameters: { type: 'object' },
          slug: 'GMAIL_TRUSTED_SEND',
        },
      ],
    });

    const res = await caller().updateComposioPlugin(input);

    expect(res).toEqual({ savedCount: 1 });
    expect(mocks.connectorCreate).toHaveBeenCalledTimes(1);
    expect(mocks.connectorCreate.mock.calls[0][0]).toMatchObject({
      metadata: { composio: { connectedAccountId: 'ca-1', status: 'ACTIVE' } },
      status: 'connected',
    });
    expect(mocks.connectorToolUpsertMany).toHaveBeenCalledWith('conn-new', [
      expect.objectContaining({
        description: 'trusted send',
        toolName: 'GMAIL_TRUSTED_SEND',
      }),
    ]);
    // authoritative refresh prunes to exactly the provided set
    expect(mocks.connectorToolDeleteToolsNotIn).toHaveBeenCalledWith('conn-new', [
      'GMAIL_TRUSTED_SEND',
    ]);
  });

  it('updates an existing connector projection instead of duplicating it', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([trustedConnector]);
    mocks.getRawComposioTools.mockResolvedValue({
      items: [{ description: 'send', inputParameters: {}, slug: 'GMAIL_SEND' }],
    });

    await caller().updateComposioPlugin(input);

    expect(mocks.connectorCreate).not.toHaveBeenCalled();
    expect(mocks.connectorUpdate).toHaveBeenCalledWith(
      'conn-existing',
      expect.objectContaining({
        metadata: expect.objectContaining({
          composio: expect.objectContaining({ status: 'ACTIVE' }),
        }),
        status: 'connected',
      }),
    );
    expect(mocks.connectorToolUpsertMany).toHaveBeenCalledWith('conn-existing', expect.any(Array));
    expect(mocks.connectorToolDeleteToolsNotIn).toHaveBeenCalledWith('conn-existing', [
      'GMAIL_SEND',
    ]);
  });

  it('prunes all connector tools when the refreshed list is empty', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([trustedConnector]);
    mocks.getRawComposioTools.mockResolvedValue({ items: [] });

    await caller().updateComposioPlugin(input);

    // nothing to upsert, but the stale set is fully cleared
    expect(mocks.connectorToolUpsertMany).not.toHaveBeenCalled();
    expect(mocks.connectorToolDeleteToolsNotIn).toHaveBeenCalledWith('conn-existing', []);
  });

  it('rejects a forged binding and never reads tools or updates projections', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([trustedConnector]);

    await expect(
      caller().updateComposioPlugin({ ...input, connectedAccountId: 'foreign-binding' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.connectedAccountsGet).not.toHaveBeenCalled();
    expect(mocks.getRawComposioTools).not.toHaveBeenCalled();
    expect(mocks.connectorUpdate).not.toHaveBeenCalled();
  });

  it('rejects update when no owner-scoped binding projection exists', async () => {
    await expect(caller().updateComposioPlugin(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mocks.connectedAccountsGet).not.toHaveBeenCalled();
    expect(mocks.connectorCreate).not.toHaveBeenCalled();
  });

  it('ignores forged client tools and materializes only the trusted Composio response', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([trustedConnector]);
    mocks.getRawComposioTools.mockResolvedValue({
      items: [{ description: 'trusted', inputParameters: {}, slug: 'GMAIL_TRUSTED' }],
    });

    await caller().updateComposioPlugin({
      ...input,
      tools: [{ description: 'forged', inputSchema: { endpoint: 'https://evil' }, name: 'EVIL' }],
    });

    expect(mocks.connectorToolUpsertMany).toHaveBeenCalledWith('conn-existing', [
      expect.objectContaining({ description: 'trusted', toolName: 'GMAIL_TRUSTED' }),
    ]);
    expect(mocks.connectorToolDeleteToolsNotIn).toHaveBeenCalledWith('conn-existing', [
      'GMAIL_TRUSTED',
    ]);
  });
});

describe('composioRouter delete paths clean up the connector projection', () => {
  it('removeComposioPlugin deletes the connector row when present', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([{ id: 'conn-existing' }]);

    await caller().removeComposioPlugin({ identifier: 'gmail' });

    expect(mocks.pluginDelete).toHaveBeenCalledWith('gmail');
    expect(mocks.connectorDelete).toHaveBeenCalledWith('conn-existing');
  });

  it('deleteConnection deletes both plugin and connector', async () => {
    mocks.connectedAccountsDelete.mockResolvedValue(undefined);
    mocks.connectorQueryByIdentifiers.mockResolvedValue([
      {
        id: 'conn-existing',
        identifier: 'gmail',
        metadata: { composio: { connectedAccountId: 'trusted-ca-1' } },
      },
    ]);

    await caller().deleteConnection({ connectedAccountId: 'attacker-ca', identifier: 'gmail' });

    expect(mocks.connectedAccountsDelete).toHaveBeenCalledWith('trusted-ca-1');
    expect(mocks.pluginDelete).toHaveBeenCalledWith('gmail');
    expect(mocks.connectorDelete).toHaveBeenCalledWith('conn-existing');
  });

  it('rejects deleteConnection when the owned local projection is absent', async () => {
    await expect(caller().deleteConnection({ identifier: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(mocks.connectedAccountsDelete).not.toHaveBeenCalled();
    expect(mocks.pluginDelete).not.toHaveBeenCalled();
    expect(mocks.connectorDelete).not.toHaveBeenCalled();
  });

  it('does not call connector delete when no projection exists', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([]);

    await caller().removeComposioPlugin({ identifier: 'gmail' });

    expect(mocks.connectorDelete).not.toHaveBeenCalled();
  });
});
