// @vitest-environment node
import { Plans } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getReferralStatus, getSubscriptionPlan } from '@/business/server/user';
import type { UserModel } from '@/database/models/user';

import { loadGetUserStateBundle } from './getUserStateBundle';

const isModuleEnabled = vi.hoisted(() => vi.fn());

vi.mock('../moduleSettings', () => ({
  isModuleEnabled,
}));

vi.mock('@/business/server/user', () => ({
  getReferralStatus: vi.fn(),
  getSubscriptionPlan: vi.fn(),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { getUserKeyVaults: vi.fn() },
}));

describe('loadGetUserStateBundle', () => {
  const state = {
    isOnboarded: true,
    preference: { telemetry: true },
    settings: { general: { fontSize: 14 } },
    userId: 'u1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    isModuleEnabled.mockResolvedValue(true);
    vi.mocked(getReferralStatus).mockResolvedValue(undefined);
    vi.mocked(getSubscriptionPlan).mockResolvedValue(Plans.Free);
  });

  it('returns the UserInitializationState fields from one model bundle call', async () => {
    const userModel = {
      getUserStateBundle: vi.fn().mockResolvedValue({
        hasExtraSession: true,
        messageCount: 5,
        state,
      }),
    } as unknown as UserModel;

    const result = await loadGetUserStateBundle({ userId: 'u1', userModel });

    expect(result).toEqual({
      hasExtraSession: true,
      messageCount: 5,
      referralStatus: undefined,
      state,
      subscriptionPlan: Plans.Free,
    });
    expect(userModel.getUserStateBundle).toHaveBeenCalledTimes(1);
    expect(getReferralStatus).toHaveBeenCalledWith('u1');
    expect(getSubscriptionPlan).toHaveBeenCalledWith('u1');
  });

  it('skips referral/subscription when market is off and still returns Free defaults', async () => {
    isModuleEnabled.mockResolvedValue(false);
    const userModel = {
      getUserStateBundle: vi.fn().mockResolvedValue({
        hasExtraSession: false,
        messageCount: 0,
        state,
      }),
    } as unknown as UserModel;

    const result = await loadGetUserStateBundle({ userId: 'u1', userModel });

    expect(result.subscriptionPlan).toBe(Plans.Free);
    expect(result.referralStatus).toBeUndefined();
    expect(getReferralStatus).not.toHaveBeenCalled();
    expect(getSubscriptionPlan).not.toHaveBeenCalled();
  });
});
