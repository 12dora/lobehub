import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const mutate = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      managedResources: {
        get: { query: (...args: unknown[]) => query('get', ...args) },
        publish: { mutate: (...args: unknown[]) => mutate('publish', ...args) },
        saveDraft: { mutate: (...args: unknown[]) => mutate('saveDraft', ...args) },
      },
    },
  },
}));

describe('adminManagedResourcesService', () => {
  beforeEach(() => {
    query.mockReset();
    mutate.mockReset();
    query.mockResolvedValue({ status: 'draft' });
    mutate.mockResolvedValue({ ok: true });
  });

  it('uses the typed service boundary for get, saveDraft, and publish', async () => {
    const { adminManagedResourcesService } = await import(
      '@/enterprise/client/services/adminManagedResources'
    );
    const draft = {
      agents: { enforcementMode: 'observe' as const, managed: false },
      aiModels: { enforcementMode: 'observe' as const, managed: false },
      aiProviders: { enforcementMode: 'observe' as const, managed: false },
      connectors: { enforcementMode: 'ui-only' as const, managed: true },
      skills: { enforcementMode: 'observe' as const, managed: false },
    };

    await adminManagedResourcesService.get();
    await adminManagedResourcesService.saveDraft({
      draft,
      expectedDraftToken: 'a'.repeat(64),
      reason: 'stage connector UI',
    });
    await adminManagedResourcesService.publish({
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 4,
      reason: 'publish connector UI',
    });

    expect(query).toHaveBeenCalledWith('get');
    expect(mutate).toHaveBeenCalledWith('saveDraft', {
      draft,
      expectedDraftToken: 'a'.repeat(64),
      reason: 'stage connector UI',
    });
    expect(mutate).toHaveBeenCalledWith('publish', {
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 4,
      reason: 'publish connector UI',
    });
  });
});
