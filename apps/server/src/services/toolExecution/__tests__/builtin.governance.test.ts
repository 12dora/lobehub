// @vitest-environment node
import type { ChatToolPayload } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuiltinToolsExecutor } from '../builtin';
import type { ToolExecutionContext } from '../types';

const mocks = vi.hoisted(() => ({
  composioCtor: vi.fn(),
  executeComposioTool: vi.fn(),
  executeLobehubSkill: vi.fn(),
  marketCtor: vi.fn(),
  resolveConnectorGovernance: vi.fn(),
}));

vi.mock('../serverRuntimes', () => ({
  getServerRuntime: vi.fn(async () => ({})),
  hasServerRuntime: vi.fn().mockReturnValue(false),
}));

// Capture WHICH identity each service instance was constructed with, and
// record it on every execution so substitution is observable per call.
vi.mock('@/server/services/market', () => ({
  MarketService: mocks.marketCtor.mockImplementation((options: any) => ({
    executeLobehubSkill: (args: any) => mocks.executeLobehubSkill(options?.userInfo?.userId, args),
  })),
}));
vi.mock('@/server/services/composio', () => ({
  ComposioService: mocks.composioCtor.mockImplementation((options: any) => ({
    executeComposioTool: (args: any) => mocks.executeComposioTool(options?.userId, args),
  })),
}));
vi.mock('@/server/enterprise/services/connectorGovernance/resolve', () => ({
  resolveConnectorGovernance: mocks.resolveConnectorGovernance,
}));

const context: ToolExecutionContext = { toolManifestMap: {}, userId: 'user-1' };

const skillPayload: ChatToolPayload = {
  apiName: 'sendEmail',
  arguments: '{}',
  id: 't1',
  identifier: 'gmail',
  source: 'lobehubSkill',
  type: 'builtin' as any,
} as any;

const composioPayload: ChatToolPayload = {
  apiName: 'GMAIL_SEND',
  arguments: '{}',
  id: 't2',
  identifier: 'gmail',
  source: 'composio',
  type: 'builtin' as any,
} as any;

describe('BuiltinToolsExecutor shared OAuth identity substitution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeLobehubSkill.mockResolvedValue({ content: 'ok', success: true });
    mocks.executeComposioTool.mockResolvedValue({ content: 'ok', success: true });
  });

  it('executes with the invoking user identity when governance is inactive', async () => {
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: false,
      builtinToolPolicies: {},
      sharedAuthOwnerUserId: null,
    });
    const executor = new BuiltinToolsExecutor({} as any, 'user-1');

    await executor.execute(skillPayload, context);
    await executor.execute(composioPayload, context);

    expect(mocks.executeLobehubSkill).toHaveBeenCalledWith('user-1', expect.anything());
    expect(mocks.executeComposioTool).toHaveBeenCalledWith('user-1', expect.anything());
    // Only the constructor-time per-user services exist.
    expect(mocks.marketCtor).toHaveBeenCalledTimes(1);
    expect(mocks.composioCtor).toHaveBeenCalledTimes(1);
  });

  it('substitutes the shared auth owner identity when governance designates one', async () => {
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: {},
      sharedAuthOwnerUserId: 'owner-1',
    });
    const executor = new BuiltinToolsExecutor({} as any, 'user-1');

    await executor.execute(skillPayload, context);
    await executor.execute(composioPayload, context);

    expect(mocks.executeLobehubSkill).toHaveBeenCalledWith('owner-1', expect.anything());
    expect(mocks.executeComposioTool).toHaveBeenCalledWith('owner-1', expect.anything());
    // Owner-identity services are constructed once and memoized across calls:
    // ctor call 1 = per-user (constructor), call 2 = shared owner.
    expect(mocks.marketCtor).toHaveBeenCalledTimes(2);
    expect(mocks.marketCtor).toHaveBeenLastCalledWith({ userInfo: { userId: 'owner-1' } });
    expect(mocks.composioCtor).toHaveBeenCalledTimes(2);
    expect(mocks.composioCtor).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'owner-1' }),
    );
  });

  it('reuses the per-user services when the shared owner IS the invoking user', async () => {
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: true,
      builtinToolPolicies: {},
      sharedAuthOwnerUserId: 'user-1',
    });
    const executor = new BuiltinToolsExecutor({} as any, 'user-1');

    await executor.execute(skillPayload, context);

    expect(mocks.executeLobehubSkill).toHaveBeenCalledWith('user-1', expect.anything());
    expect(mocks.marketCtor).toHaveBeenCalledTimes(1);
    expect(mocks.composioCtor).toHaveBeenCalledTimes(1);
  });

  it('ignores a designated owner while governance is inactive', async () => {
    // sharedAuthOwnerUserId is contractually null when inactive, but the
    // runtime must not trust that: only `active` unlocks substitution.
    mocks.resolveConnectorGovernance.mockResolvedValue({
      active: false,
      builtinToolPolicies: {},
      sharedAuthOwnerUserId: 'owner-1',
    });
    const executor = new BuiltinToolsExecutor({} as any, 'user-1');

    await executor.execute(skillPayload, context);

    expect(mocks.executeLobehubSkill).toHaveBeenCalledWith('user-1', expect.anything());
    expect(mocks.marketCtor).toHaveBeenCalledTimes(1);
  });
});
