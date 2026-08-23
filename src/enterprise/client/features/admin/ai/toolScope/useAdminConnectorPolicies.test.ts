// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectorToolPermission } from '@/database/schemas';

import { useAdminConnectorPolicies } from './useAdminConnectorPolicies';

const mocks = vi.hoisted(() => ({
  connectors: {
    applyImmediate: vi.fn(),
    get: vi.fn(),
    getGovernance: vi.fn(),
    updateBuiltinToolPolicy: vi.fn(),
  },
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: mocks.connectors,
}));

const connectorDetail = () => ({
  baseRevision: 5,
  draft: {
    id: 'conn-1',
    tools: [{ toolKey: 'createIssue' }],
  },
  draftToken: 'c'.repeat(64),
});

const renderPolicies = () =>
  renderHook(() =>
    useAdminConnectorPolicies({
      capabilities: {
        canCreateConnector: true,
        canCreateSkill: true,
        canDeleteConnector: true,
        canDeleteSkill: true,
        canUpdateConnector: true,
        canUpdateSkill: true,
      },
      connectorDetailById: new Map(),
      governance: { doc: { builtinToolPolicies: {} }, revision: 2 },
      mutateGovernance: vi.fn(async () => undefined),
      notifications: {
        notifyConnectorFailure: vi.fn(),
        notifyConnectorSaved: vi.fn(),
        notifyUnlessAlreadyToasted: vi.fn(),
      },
      retry: vi.fn(),
    } as unknown as Parameters<typeof useAdminConnectorPolicies>[0]),
  );

describe('useAdminConnectorPolicies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectors.getGovernance.mockResolvedValue({
      doc: { builtinToolPolicies: {} },
      revision: 2,
    });
    mocks.connectors.updateBuiltinToolPolicy.mockResolvedValue({ revision: 3 });
    mocks.connectors.get.mockResolvedValue(connectorDetail());
    mocks.connectors.applyImmediate.mockResolvedValue({ revision: 6 });
  });

  it.each([
    ['missing identifier and tool name', 'admin-builtin:'],
    ['missing tool name', 'admin-builtin:codeInterpreter:'],
    ['missing identifier', 'admin-builtin::createFile'],
  ])('single_tool_write_refuses_builtin_id_with_%s', async (_label, toolId) => {
    const { result } = renderPolicies();

    await act(async () => {
      await result.current.updateToolPermission(toolId, ConnectorToolPermission.disabled);
    });

    // Before the guard this persisted a matrix entry keyed by '' into the org
    // governance document — the bulk path already skipped the same ids.
    expect(mocks.connectors.updateBuiltinToolPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['missing connector id and tool key', 'platform:'],
    ['missing tool key', 'platform:conn-1:'],
    ['missing connector id', 'platform::createIssue'],
  ])('single_tool_write_refuses_platform_id_with_%s', async (_label, toolId) => {
    const { result } = renderPolicies();

    await act(async () => {
      await result.current.updateToolPermission(toolId, ConnectorToolPermission.disabled);
    });

    expect(mocks.connectors.get).not.toHaveBeenCalled();
    expect(mocks.connectors.applyImmediate).not.toHaveBeenCalled();
  });

  it('single_tool_write_still_persists_well_formed_ids', async () => {
    const { result } = renderPolicies();

    await act(async () => {
      await result.current.updateToolPermission(
        'admin-builtin:codeInterpreter:runCode',
        ConnectorToolPermission.disabled,
      );
      await result.current.updateToolPermission(
        'platform:conn-1:createIssue',
        ConnectorToolPermission.disabled,
      );
    });

    expect(mocks.connectors.updateBuiltinToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        policies: { codeInterpreter: { runCode: ConnectorToolPermission.disabled } },
      }),
    );
    expect(mocks.connectors.applyImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conn-1',
        tools: [{ toolKey: 'createIssue', platformPolicy: 'deny', requiresConfirmation: false }],
      }),
    );
  });
});
