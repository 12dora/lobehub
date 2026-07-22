// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolExecutionService } from '../index';
import type { ToolExecutionContext } from '../types';

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  executeMcpCall: vi.fn(),
  getConnectorToolPermission: vi.fn(),
  resolveConnectorGovernance: vi.fn(),
}));

vi.mock('@/server/enterprise/services/connectorCatalog/legacyMcpTransport', () => ({
  platformSafeMcpService: { callTool: mocks.callTool },
}));
vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: { executeMcpCall: mocks.executeMcpCall, isConfigured: false },
}));
// The gate imports both the blocked-response builder and the per-user lookup
// from this module; mock the lookup, keep the builder shape stable.
vi.mock('@/libs/mcp/connectorPermissionCheck', () => ({
  buildBlockedToolResponse: (toolName: string) => ({
    content: `blocked:${toolName}`,
    state: { content: [{ text: `blocked:${toolName}`, type: 'text' }], isError: false },
    success: true,
  }),
  getConnectorToolPermission: mocks.getConnectorToolPermission,
}));
// The governance resolver is stubbed until storage lands — tests always mock it.
vi.mock('@/server/enterprise/services/connectorGovernance/resolve', () => ({
  resolveConnectorGovernance: mocks.resolveConnectorGovernance,
}));

const inactiveGovernance = {
  active: false,
  builtinToolPolicies: {},
  sharedAuthOwnerUserId: null,
};

// `lobe-web-browsing` is a real builtin registry identifier; `gmail` is not.
const builtinPayload = {
  apiName: 'search',
  arguments: '{}',
  id: 'tool-call-1',
  identifier: 'lobe-web-browsing',
  type: 'builtin' as any,
};
const nonBuiltinPayload = {
  apiName: 'send',
  arguments: '{}',
  id: 'tool-call-2',
  identifier: 'gmail',
  type: 'builtin' as any,
};

const context: ToolExecutionContext = {
  serverDB: {} as any,
  toolManifestMap: {},
  userId: 'user-1',
};

const createService = () => {
  const execute = vi.fn().mockResolvedValue({ content: 'executed', success: true });
  const service = new ToolExecutionService({
    builtinToolsExecutor: { execute } as any,
    mcpService: {} as any,
  });
  return { execute, service };
};

describe('ToolExecutionService connector governance gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectorGovernance.mockResolvedValue(inactiveGovernance);
    mocks.getConnectorToolPermission.mockResolvedValue(null);
  });

  it('honors per-user rows when governance is inactive', async () => {
    mocks.getConnectorToolPermission.mockResolvedValue('disabled');
    const { execute, service } = createService();

    const result = await service.executeTool(builtinPayload, context);

    expect(result.content).toBe('blocked:search');
    expect(mocks.getConnectorToolPermission).toHaveBeenCalledWith(
      context.serverDB,
      'user-1',
      'lobe-web-browsing',
      'search',
      undefined,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks a builtin tool the org matrix disables, without touching user rows', async () => {
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: { 'lobe-web-browsing': { search: 'disabled' } },
      sharedAuthOwnerUserId: null,
    });
    // Per-user rows say auto — they must be ignored (and never consulted).
    mocks.getConnectorToolPermission.mockResolvedValue('auto');
    const { execute, service } = createService();

    const result = await service.executeTool(builtinPayload, context);

    expect(result.content).toBe('blocked:search');
    expect(mocks.getConnectorToolPermission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes a builtin tool the org matrix allows even when user rows disable it', async () => {
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: { 'lobe-web-browsing': { search: 'auto' } },
      sharedAuthOwnerUserId: null,
    });
    mocks.getConnectorToolPermission.mockResolvedValue('disabled');
    const { execute, service } = createService();

    const result = await service.executeTool(builtinPayload, context);

    expect(result.success).toBe(true);
    expect(result.content).toBe('executed');
    expect(mocks.getConnectorToolPermission).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('falls back to the manifest static default on a matrix miss (still no user rows)', async () => {
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: { 'lobe-web-browsing': { otherApi: 'disabled' } },
      sharedAuthOwnerUserId: null,
    });
    mocks.getConnectorToolPermission.mockResolvedValue('disabled');
    const { execute, service } = createService();

    const result = await service.executeTool(builtinPayload, context);

    expect(result.success).toBe(true);
    expect(mocks.getConnectorToolPermission).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the per-user path for non-builtin identifiers while governance is active', async () => {
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: { gmail: { send: 'auto' } },
      sharedAuthOwnerUserId: null,
    });
    mocks.getConnectorToolPermission.mockResolvedValue('disabled');
    const { execute, service } = createService();

    const result = await service.executeTool(nonBuiltinPayload, context);

    expect(result.content).toBe('blocked:send');
    expect(mocks.getConnectorToolPermission).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets non-builtin identifiers through when user rows allow them', async () => {
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: {},
      sharedAuthOwnerUserId: null,
    });
    mocks.getConnectorToolPermission.mockResolvedValue('auto');
    const { execute, service } = createService();

    const result = await service.executeTool(nonBuiltinPayload, context);

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
