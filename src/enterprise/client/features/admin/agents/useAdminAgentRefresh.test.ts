import { describe, expect, it, vi } from 'vitest';

import { createAdminAgentRefresh } from './useAdminAgentRefresh';

const setup = () => {
  const refreshDefaultAgent = vi.fn().mockResolvedValue(undefined);
  const refreshList = vi.fn().mockResolvedValue(undefined);
  return {
    refresh: createAdminAgentRefresh({ refreshDefaultAgent, refreshList }),
    refreshDefaultAgent,
    refreshList,
  };
};

describe('createAdminAgentRefresh', () => {
  it('invalidates the table and the pinned default card together', async () => {
    const { refresh, refreshDefaultAgent, refreshList } = setup();

    await refresh.defaultAndList();

    expect(refreshList).toHaveBeenCalledOnce();
    expect(refreshDefaultAgent).toHaveBeenCalledOnce();
  });

  it('substitutes the list half with the caller write, still hitting the pinned key', async () => {
    const { refresh, refreshDefaultAgent, refreshList } = setup();
    const removeItem = vi.fn().mockResolvedValue(undefined);

    await refresh.defaultAndList(removeItem);

    // An optimistic drop / row patch replaces the plain revalidate — it does not replace the
    // pinned invalidation, which is the whole bug this helper exists to prevent.
    expect(removeItem).toHaveBeenCalledOnce();
    expect(refreshList).not.toHaveBeenCalled();
    expect(refreshDefaultAgent).toHaveBeenCalledOnce();
  });

  it('still invalidates the pinned key when the list half rejects, then rethrows', async () => {
    const { refresh, refreshDefaultAgent, refreshList } = setup();
    refreshList.mockRejectedValueOnce(new Error('offline'));

    await expect(refresh.defaultAndList()).rejects.toThrow('offline');
    // Not Promise.all: an early rejection must not cancel the pinned card's revalidation.
    expect(refreshDefaultAgent).toHaveBeenCalledOnce();
  });

  it('reports a failed pinned revalidation after the list half already landed', async () => {
    const { refresh, refreshDefaultAgent, refreshList } = setup();
    refreshDefaultAgent.mockRejectedValueOnce(new Error('pointer read failed'));

    await expect(refresh.defaultAndList()).rejects.toThrow('pointer read failed');
    expect(refreshList).toHaveBeenCalledOnce();
  });

  it('leaves the pinned key untouched for a write that cannot move the pointer', async () => {
    const { refresh, refreshDefaultAgent, refreshList } = setup();

    await refresh.listOnly();
    const updateItem = vi.fn().mockResolvedValue(undefined);
    await refresh.listOnly(updateItem);

    expect(refreshList).toHaveBeenCalledOnce();
    expect(updateItem).toHaveBeenCalledOnce();
    expect(refreshDefaultAgent).not.toHaveBeenCalled();
  });

  it('invalidates the pinned card alone when only the pointer read is stale', async () => {
    const { refresh, refreshDefaultAgent, refreshList } = setup();

    await refresh.defaultOnly();

    expect(refreshDefaultAgent).toHaveBeenCalledOnce();
    expect(refreshList).not.toHaveBeenCalled();
  });
});
