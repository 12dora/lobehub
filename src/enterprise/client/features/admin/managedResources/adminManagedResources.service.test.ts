import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const mutate = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      managedResources: {
        get: { query: (...args: unknown[]) => query('get', ...args) },
        save: { mutate: (...args: unknown[]) => mutate('save', ...args) },
      },
    },
  },
}));

describe('adminManagedResourcesService', () => {
  beforeEach(() => {
    query.mockReset();
    mutate.mockReset();
    query.mockResolvedValue({ status: 'published' });
    mutate.mockResolvedValue({ auditId: 'a1', revision: 5, runtimeTransition: 'finalized' });
  });

  it('uses the typed service boundary for get and save', async () => {
    const { adminManagedResourcesService } =
      await import('@/enterprise/client/services/adminManagedResources');
    const draft = {
      agents: { enforcementMode: 'observe' as const, managed: false },
      aiModels: { enforcementMode: 'observe' as const, managed: false },
      aiProviders: { enforcementMode: 'observe' as const, managed: false },
      connectors: { enforcementMode: 'enforced' as const, managed: true },
      skills: { enforcementMode: 'observe' as const, managed: false },
    };

    await adminManagedResourcesService.get();
    await adminManagedResourcesService.save({
      draft,
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 4,
      reason: 'manage connectors',
    });

    expect(query).toHaveBeenCalledWith('get');
    expect(mutate).toHaveBeenCalledWith('save', {
      draft,
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 4,
      reason: 'manage connectors',
    });
  });
});
