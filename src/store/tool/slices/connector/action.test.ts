import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectorToolPermission } from '@/database/schemas';

import { createConnectorSlice } from './action';
import type { ConnectorWithTools } from './types';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  updateToolPermission: vi.fn(),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    connector: {
      list: { query: mocks.list },
      updateToolPermission: { mutate: mocks.updateToolPermission },
    },
  },
}));

const tool = (id: string) => ({
  crudType: 'read',
  description: null,
  displayName: id,
  id,
  inputSchema: null,
  permission: ConnectorToolPermission.auto,
  toolName: id,
  userConnectorId: 'connector-1',
});

const connector = (): ConnectorWithTools => ({
  credentials: null,
  id: 'connector-1',
  identifier: 'jira',
  isEnabled: true,
  mcpConnectionType: 'http',
  mcpServerUrl: 'https://mcp.example.com',
  metadata: null,
  name: 'Jira',
  sourceType: 'custom',
  status: 'connected',
  tools: [tool('a'), tool('b'), tool('c')],
});

const createStore = () => {
  const state = { connectors: [connector()] } as { connectors: ConnectorWithTools[] };
  const setCalls: string[] = [];
  const set = vi.fn((partial: any, _replace?: boolean, action?: string) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    Object.assign(state, next);
    if (action) setCalls.push(action);
  });
  const get = () => state as any;
  return { setCalls, slice: createConnectorSlice(set as any, get), state };
};

const permissionsOf = (state: { connectors: ConnectorWithTools[] }) =>
  Object.fromEntries(state.connectors[0].tools.map((t) => [t.id, t.permission]));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.updateToolPermission.mockResolvedValue(undefined);
});

describe('updateToolsPermission', () => {
  it('applies one optimistic patch for the whole group and mutates every tool', async () => {
    const { setCalls, slice, state } = createStore();

    await slice.updateToolsPermission(['a', 'c'], ConnectorToolPermission.disabled);

    expect(setCalls.filter((name) => name === 'updateToolsPermission/optimistic')).toHaveLength(1);
    expect(permissionsOf(state)).toEqual({
      a: ConnectorToolPermission.disabled,
      b: ConnectorToolPermission.auto,
      c: ConnectorToolPermission.disabled,
    });
    expect(mocks.updateToolPermission).toHaveBeenCalledTimes(2);
    expect(mocks.updateToolPermission).toHaveBeenCalledWith({
      permission: ConnectorToolPermission.disabled,
      toolId: 'a',
    });
    expect(mocks.updateToolPermission).toHaveBeenCalledWith({
      permission: ConnectorToolPermission.disabled,
      toolId: 'c',
    });
    // No rollback on success
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('refetches exactly once when any tool write fails', async () => {
    const { slice } = createStore();
    mocks.updateToolPermission
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'));

    await slice.updateToolsPermission(['a', 'b', 'c'], ConnectorToolPermission.needs_approval);

    expect(mocks.updateToolPermission).toHaveBeenCalledTimes(3);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty group', async () => {
    const { setCalls, slice } = createStore();

    await slice.updateToolsPermission([], ConnectorToolPermission.auto);

    expect(setCalls).toHaveLength(0);
    expect(mocks.updateToolPermission).not.toHaveBeenCalled();
  });
});
