import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsProviderModelAvailable = vi.fn();
const mockLoadModelBankModels = vi.fn();

vi.mock('model-bank', () => ({
  isProviderModelAvailable: mockIsProviderModelAvailable,
  loadModels: mockLoadModelBankModels,
  ModelProvider: { LobeHub: 'lobehub' },
}));

const { isLobeHubModelAvailable, loadModels, resetBusinessLoadModelsMemoForTest } =
  await import('@lobechat/business-model-bank/model-config');

describe('business model config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rebuilds the model bank once for the same LobeHub config version', async () => {
    resetBusinessLoadModelsMemoForTest();
    mockLoadModelBankModels.mockResolvedValue([{ id: 'lobehub-fast', providerId: 'lobehub' }]);

    const first = await loadModels();
    const second = await loadModels();

    expect(second).toBe(first);
    expect(first).toEqual([{ id: 'lobehub-fast', providerId: 'lobehub' }]);
    expect(mockLoadModelBankModels).toHaveBeenCalledTimes(1);
  });

  it('should disable LobeHub model availability by default', () => {
    const getUserEmail = vi.fn();

    expect(isLobeHubModelAvailable('image-model', 'image', { getUserEmail })).toBe(false);

    expect(mockLoadModelBankModels).not.toHaveBeenCalled();
    expect(mockIsProviderModelAvailable).not.toHaveBeenCalled();
    expect(getUserEmail).not.toHaveBeenCalled();
  });
});
