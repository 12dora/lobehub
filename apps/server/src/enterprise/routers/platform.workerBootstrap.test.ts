// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensurePlatformSecretRewrapWorkerStarted: vi.fn(),
}));

vi.mock('../jobs/secretRewrap', () => ({
  ensurePlatformSecretRewrapWorkerStarted: mocks.ensurePlatformSecretRewrapWorkerStarted,
}));

describe('platform persistent worker bootstrap', () => {
  beforeAll(async () => {
    await import('./platform');
  });

  it('registers the secret rewrap worker from the production platform bootstrap module', () => {
    expect(mocks.ensurePlatformSecretRewrapWorkerStarted).toHaveBeenCalledOnce();
  });
});
