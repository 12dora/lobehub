import { describe, expect, it, vi } from 'vitest';

import { isAiProviderWriteLocked } from './controller';
import { commitThenScheduleRefresh } from './mutationRefresh';

describe('AI catalog committed mutation refresh', () => {
  it('resolves the mutation before a pending refresh and preserves committed state', async () => {
    let finishRefresh!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const onCommitted = vi.fn();
    const result = await commitThenScheduleRefresh({
      commit: async () => ({ id: 'committed' }),
      onCommitted,
      refresh,
    });

    expect(result).toEqual({ id: 'committed' });
    expect(onCommitted).toHaveBeenCalledWith(result);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    finishRefresh();
  });

  it('reports refresh failure separately without rejecting the committed mutation', async () => {
    const onRefreshFailed = vi.fn();
    await expect(
      commitThenScheduleRefresh({
        commit: async () => 'committed',
        onRefreshFailed,
        refresh: async () => {
          throw new Error('reload failed');
        },
      }),
    ).resolves.toBe('committed');
    await vi.waitFor(() => expect(onRefreshFailed).toHaveBeenCalledOnce());
  });

  it('does not refresh or report committed when the write fails', async () => {
    const refresh = vi.fn();
    const onCommitted = vi.fn();
    await expect(
      commitThenScheduleRefresh({
        commit: async () => {
          throw new Error('write failed');
        },
        onCommitted,
        refresh,
      }),
    ).rejects.toThrow('write failed');
    expect(onCommitted).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps Provider actions locked while the committed refresh is deferred', async () => {
    let finishRefresh!: () => void;
    const refreshFailed = false;
    let refreshPending = false;
    const action = vi.fn();
    const tryAction = () => {
      if (!isAiProviderWriteLocked({ refreshFailed, refreshPending })) action();
    };

    await commitThenScheduleRefresh({
      commit: async () => 'committed',
      refresh: () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
      onCommitted: () => {
        refreshPending = true;
      },
      onRefreshed: () => {
        refreshPending = false;
      },
    });
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
    tryAction();
    expect(action).not.toHaveBeenCalled();

    finishRefresh();
    await vi.waitFor(() => expect(refreshPending).toBe(false));
    tryAction();
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps Provider actions locked after the committed refresh is rejected', async () => {
    let refreshFailed = false;
    let refreshPending = false;
    const action = vi.fn();

    await commitThenScheduleRefresh({
      commit: async () => 'committed',
      refresh: async () => {
        throw new Error('reload failed');
      },
      onCommitted: () => {
        refreshPending = true;
      },
      onRefreshFailed: () => {
        refreshFailed = true;
        refreshPending = false;
      },
    });
    await vi.waitFor(() => expect(refreshFailed).toBe(true));
    if (!isAiProviderWriteLocked({ refreshFailed, refreshPending })) action();
    expect(action).not.toHaveBeenCalled();
  });
});
