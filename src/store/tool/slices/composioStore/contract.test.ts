import { describe, expect, it, vi } from 'vitest';

import {
  buildComposioCreateConnectionInput,
  buildComposioOwnedDeleteInput,
  buildComposioPluginUpdateInput,
  createOwnedComposioConnection,
  deleteOwnedComposioConnection,
  updateActiveComposioPlugin,
} from './contract';
import { type ComposioServer, ComposioServerStatus } from './types';

const server: ComposioServer = {
  appSlug: 'gmail',
  authConfigId: 'auth-local',
  connectedAccountId: 'account-local',
  createdAt: 0,
  identifier: 'gmail',
  label: 'Gmail',
  status: ComposioServerStatus.ACTIVE,
};

describe('Composio owner OAuth client contract', () => {
  it('builds Connect without credential, tool definition, or endpoint fields', () => {
    expect(
      buildComposioCreateConnectionInput({
        appSlug: 'gmail',
        identifier: 'gmail',
        label: 'Gmail',
      }),
    ).toEqual({ appSlug: 'gmail', identifier: 'gmail', label: 'Gmail' });
  });

  it('calls the public Connect contract with the narrowed payload', async () => {
    const createConnection = vi.fn().mockResolvedValue(undefined);
    await createOwnedComposioConnection({
      createConnection,
      input: { appSlug: 'gmail', identifier: 'gmail', label: 'Gmail' },
    });
    expect(createConnection).toHaveBeenCalledWith({
      appSlug: 'gmail',
      identifier: 'gmail',
      label: 'Gmail',
    });
  });

  it('builds Reauthorize and Disconnect from the owned local binding', () => {
    expect(buildComposioOwnedDeleteInput(server)).toEqual({
      connectedAccountId: 'account-local',
      identifier: 'gmail',
    });
  });

  it('calls the owner-safe Disconnect contract with the local binding', async () => {
    const deleteConnection = vi.fn().mockResolvedValue(undefined);
    await deleteOwnedComposioConnection({ deleteConnection, server });
    expect(deleteConnection).toHaveBeenCalledWith({
      connectedAccountId: 'account-local',
      identifier: 'gmail',
    });
  });

  it('builds updateComposioPlugin only from the ACTIVE local binding and fetched tools', () => {
    expect(
      buildComposioPluginUpdateInput(server, [
        { description: 'Search mail', inputSchema: { type: 'object' }, name: 'search' },
      ]),
    ).toEqual({
      appSlug: 'gmail',
      authConfigId: 'auth-local',
      connectedAccountId: 'account-local',
      identifier: 'gmail',
      label: 'Gmail',
      status: 'ACTIVE',
      tools: [{ description: 'Search mail', inputSchema: { type: 'object' }, name: 'search' }],
    });
  });

  it('calls updateComposioPlugin after ACTIVE with the fetched tool projection', async () => {
    const updatePlugin = vi.fn().mockResolvedValue(undefined);
    await updateActiveComposioPlugin({
      server,
      tools: [{ inputSchema: { type: 'object' }, name: 'search' }],
      updatePlugin,
    });
    expect(updatePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'gmail', status: 'ACTIVE' }),
    );
  });
});
