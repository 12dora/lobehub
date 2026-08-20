import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEffectiveSystemAgentConfig } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';

import { SystemAgentService } from './index';

const getUserSettings = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/user', () => ({
  UserModel: class {
    getUserSettings = getUserSettings;
    static getInfoForAIGeneration = vi.fn();
  },
}));

vi.mock('@/server/enterprise/services/settings/runtimeSettingsAdapter', () => ({
  getEffectiveSystemAgentConfig: vi.fn(),
}));

describe('SystemAgentService.getEffectiveTaskAgentItem', () => {
  const service = new SystemAgentService({} as never, 'user-1');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    getUserSettings.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the effective task item when the resolver succeeds', async () => {
    vi.mocked(getEffectiveSystemAgentConfig).mockResolvedValue({
      translation: { model: 'gpt-5.6', provider: 'openai', reasoningEffort: 'high' },
    });

    await expect(service.getEffectiveTaskAgentItem('translation')).resolves.toEqual({
      model: 'gpt-5.6',
      provider: 'openai',
      reasoningEffort: 'high',
    });
  });

  it('falls back to raw user settings when policy is off and the resolver fails', async () => {
    vi.stubEnv('ENABLE_PLATFORM_SETTINGS_POLICY', '0');
    vi.mocked(getEffectiveSystemAgentConfig).mockRejectedValue(new Error('resolver down'));
    getUserSettings.mockResolvedValue({
      systemAgent: {
        translation: { model: 'raw-model', provider: 'openai' },
      },
    });

    await expect(service.getEffectiveTaskAgentItem('translation')).resolves.toEqual({
      model: 'raw-model',
      provider: 'openai',
    });
  });

  it('propagates resolver failures when the settings policy module is on', async () => {
    vi.stubEnv('ENABLE_PLATFORM_SETTINGS_POLICY', '1');
    vi.mocked(getEffectiveSystemAgentConfig).mockRejectedValue(new Error('resolver down'));

    await expect(service.getEffectiveTaskAgentItem('translation')).rejects.toThrow('resolver down');
    expect(getUserSettings).not.toHaveBeenCalled();
  });
});
