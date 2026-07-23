import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const mutate = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      connectors: {
        archive: { mutate: (...args: unknown[]) => mutate('archive', ...args) },
        createDraft: { mutate: (...args: unknown[]) => mutate('createDraft', ...args) },
        deleteDraft: { mutate: (...args: unknown[]) => mutate('deleteDraft', ...args) },
        discover: { mutate: (...args: unknown[]) => mutate('discover', ...args) },
        get: { query: (...args: unknown[]) => query('get', ...args) },
        getBatch: { query: (...args: unknown[]) => query('getBatch', ...args) },
        list: { query: (...args: unknown[]) => query('list', ...args) },
        publish: { mutate: (...args: unknown[]) => mutate('publish', ...args) },
        revokeAllBindings: {
          mutate: (...args: unknown[]) => mutate('revokeAllBindings', ...args),
        },
        rollback: { mutate: (...args: unknown[]) => mutate('rollback', ...args) },
        test: { mutate: (...args: unknown[]) => mutate('test', ...args) },
        updateDraft: { mutate: (...args: unknown[]) => mutate('updateDraft', ...args) },
      },
    },
  },
}));

describe('adminConnectorsService', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue({});
    mutate.mockReset().mockResolvedValue({});
  });

  it('uses query for reads and mutate for draft and revision actions', async () => {
    const { adminConnectorsService } = await import('@/enterprise/client/services/adminConnectors');
    await adminConnectorsService.list({ limit: 20 });
    await adminConnectorsService.get({ id: 'c1' });
    await adminConnectorsService.getBatch({ ids: ['c1', 'c2'] });
    await adminConnectorsService.discover({ id: 'c1', reason: 'discover' });
    await adminConnectorsService.test({ id: 'c1', reason: 'test' });
    await adminConnectorsService.rollback({
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 7,
      id: 'c1',
      reason: 'restore',
      targetRevision: 3,
    });

    expect(query).toHaveBeenCalledWith('list', { limit: 20 });
    expect(query).toHaveBeenCalledWith('get', { id: 'c1' });
    expect(query).toHaveBeenCalledWith('getBatch', { ids: ['c1', 'c2'] });
    expect(mutate).toHaveBeenCalledWith('discover', { id: 'c1', reason: 'discover' });
    expect(mutate).toHaveBeenCalledWith('test', { id: 'c1', reason: 'test' });
    expect(mutate).toHaveBeenCalledWith('rollback', {
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 7,
      id: 'c1',
      reason: 'restore',
      targetRevision: 3,
    });
  });
});
