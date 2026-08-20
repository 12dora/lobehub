// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { usePlatformSettingsDefaults } from './usePlatformSettingsDefaults';

const mocks = vi.hoisted(() => ({
  applyImmediate: vi.fn(),
  getDraft: vi.fn(),
  mutate: vi.fn(),
  permissions: [] as string[],
  swr: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { warning: vi.fn() },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ permissions: mocks.permissions }),
}));

vi.mock('@/enterprise/client/services/adminSettings', () => ({
  adminSettingsService: {
    applyImmediate: mocks.applyImmediate,
    getDraft: mocks.getDraft,
  },
}));

vi.mock('swr', () => ({
  default: (...args: unknown[]) => mocks.swr(...args),
}));

describe('usePlatformSettingsDefaults — default agent effort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissions = [
      PLATFORM_PERMISSIONS.SETTINGS_UPDATE,
      PLATFORM_PERMISSIONS.SETTINGS_PUBLISH,
    ];
    mocks.applyImmediate.mockResolvedValue({
      paths: ['defaultAgent.config.chatConfig.gpt5_6ReasoningEffort'],
    });
    mocks.mutate.mockResolvedValue(undefined);
    mocks.swr.mockImplementation(() => ({
      data: { publishedPolicies: {} },
      error: undefined,
      isLoading: false,
      mutate: mocks.mutate,
    }));
  });

  it('updateDefaultAgentEffort publishes the matching chatConfig leaf', async () => {
    const { result } = renderHook(() => usePlatformSettingsDefaults());

    await act(async () => {
      await result.current.updateDefaultAgentEffort({
        configKey: 'gpt5_6ReasoningEffort',
        level: 'high',
      });
    });

    expect(mocks.applyImmediate).toHaveBeenCalledWith({
      patch: { 'defaultAgent.config.chatConfig.gpt5_6ReasoningEffort': 'high' },
      reason: undefined,
    });
  });
});
