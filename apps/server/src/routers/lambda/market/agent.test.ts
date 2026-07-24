// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentRouter } from './agent';

const { mockMarketSDK, mockCreateAgentVersionHeader } = vi.hoisted(() => {
  const mockCreateAgentVersionHeader = vi.fn();
  const mockMarketSDK = {
    agents: {
      createAgent: vi.fn(),
      createAgentVersion: vi.fn(async () => {
        mockCreateAgentVersionHeader(mockMarketSDK.headers['x-lobe-owner-account-id']);
        return { success: true };
      }),
      getAgentDetail: vi.fn(),
    },
    headers: {} as Record<string, string>,
  };

  return { mockCreateAgentVersionHeader, mockMarketSDK };
});

vi.mock('@/business/server/trpc-middlewares/rbacPermission', () => ({
  withScopedPermission: vi.fn(() => (opts: any) => opts.next({ ctx: opts.ctx })),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: vi.fn(() => ({
    getUserState: vi.fn(async () => ({ settings: {} })),
  })),
}));

vi.mock('@/libs/trpc/lambda/middleware', () => ({
  marketSDK: vi.fn((opts: any) =>
    opts.next({
      ctx: {
        ...opts.ctx,
        marketSDK: mockMarketSDK,
      },
    }),
  ),
  marketUserInfo: vi.fn((opts: any) =>
    opts.next({
      ctx: {
        ...opts.ctx,
        marketUserInfo: { email: 'actor@example.com', name: 'Actor', userId: 'user-1' },
      },
    }),
  ),
  serverDatabase: vi.fn((opts: any) => opts.next({ ctx: opts.ctx })),
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn(() => 'trust-token'),
}));

describe('agentRouter.publishOrCreate', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMarketSDK.headers = {};
    mockMarketSDK.agents.getAgentDetail.mockResolvedValue({
      identifier: 'existing-agent',
      name: 'Existing Agent',
      ownerId: 123,
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ accountId: 999, sub: 'user-1' }), {
        status: 200,
      }),
    );
  });

  it('uses the acting organization account for ownership checks and version uploads', async () => {
    const caller = agentRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    const result = await caller.publishOrCreate({
      actAs: 123,
      identifier: 'existing-agent',
      name: 'Existing Agent',
    });

    expect(result).toEqual({
      identifier: 'existing-agent',
      isNewAgent: false,
      success: true,
    });
    expect(mockMarketSDK.agents.createAgent).not.toHaveBeenCalled();
    expect(mockMarketSDK.agents.createAgentVersion).toHaveBeenCalledWith({
      identifier: 'existing-agent',
      name: 'Existing Agent',
    });
    expect(mockCreateAgentVersionHeader).toHaveBeenCalledWith('123');
    expect(mockMarketSDK.headers['x-lobe-owner-account-id']).toBeUndefined();
  });
});

describe('agentRouter.getOnboardingFull', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the trusted-client token and locale to Market', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(JSON.stringify({ engineering: [{ identifier: 'coder', name: 'Coder' }] }), {
        status: 200,
      }),
    );
    const caller = agentRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    const result = await caller.getOnboardingFull({ locale: 'zh-CN' });

    expect(result).toEqual({
      engineering: [{ identifier: 'coder', name: 'Coder' }],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/api/v1/agents/onboarding-full',
        searchParams: expect.any(URLSearchParams),
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'x-lobe-trust-token': 'trust-token',
        },
        method: 'GET',
      },
    );
    const requestUrl = fetchSpy.mock.calls[0][0] as URL;
    expect(requestUrl.searchParams.get('locale')).toBe('zh-CN');
  });

  it('preserves an upstream 401 as a stable unauthorized error', async () => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );
    const caller = agentRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    await expect(caller.getOnboardingFull({ locale: 'zh-CN' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'MARKET_ONBOARDING_AUTH_REQUIRED',
    });
  });
});
