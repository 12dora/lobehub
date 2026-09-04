// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { UserService } from './index';

const { checkTelemetryEnabled, identify, initializeServerAnalytics, track } = vi.hoisted(() => {
  const identify = vi.fn();
  const track = vi.fn();
  return {
    checkTelemetryEnabled: vi.fn(),
    identify,
    initializeServerAnalytics: vi.fn(async () => ({ identify, track })),
    track,
  };
});

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ENABLE_BUSINESS_FEATURES: false,
}));

vi.mock('@/business/server/user', () => ({
  initNewUserForBusiness: vi.fn(),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: { getUserApiKeys: vi.fn() },
}));

vi.mock('@/libs/trpc/lambda/middleware/telemetry', () => ({
  checkTelemetryEnabled,
}));

vi.mock('@/libs/analytics', () => ({
  initializeServerAnalytics,
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { getUserKeyVaults: vi.fn() },
}));

vi.mock('@/server/modules/S3', () => ({
  createFileS3: vi.fn(),
}));

describe('UserService.initUser registration analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkTelemetryEnabled.mockResolvedValue({ telemetryEnabled: false });
  });

  it('does not identify or track when telemetry is gated off', async () => {
    const service = new UserService({} as LobeChatDatabase);

    await service.initUser({
      email: 'user@example.com',
      firstName: 'Ada',
      id: 'user-1',
      lastName: 'Lovelace',
      username: 'ada',
    });

    expect(checkTelemetryEnabled).toHaveBeenCalledWith({
      serverDB: {},
      userId: 'user-1',
    });
    expect(initializeServerAnalytics).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('identifies and tracks registration when telemetry is enabled', async () => {
    checkTelemetryEnabled.mockResolvedValue({ telemetryEnabled: true });
    const service = new UserService({} as LobeChatDatabase);

    await service.initUser({
      email: 'user@example.com',
      firstName: 'Ada',
      id: 'user-1',
      lastName: 'Lovelace',
      phone: '+1000',
      username: 'ada',
    });

    expect(initializeServerAnalytics).toHaveBeenCalled();
    expect(identify).toHaveBeenCalledWith('user-1', {
      email: 'user@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+1000',
      username: 'ada',
    });
    expect(track).toHaveBeenCalledWith({
      name: 'user_register_completed',
      properties: {
        spm: 'user_service.init_user.user_created',
      },
      userId: 'user-1',
    });
  });
});
