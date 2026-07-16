import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useModelProviderTargetPicker } from './useModelProviderTargetPicker';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useModelProviderTargetPicker', () => {
  it('searches the complete server-side target list and paginates with cursors', async () => {
    const loadTargets = vi.fn(async (input: { cursor?: string; query?: string }) => {
      if (input.query === 'empty') {
        return {
          items: [
            {
              displayName: 'Provider without models',
              id: 'provider-empty',
              providerKey: 'empty',
            },
          ],
          nextCursor: null,
        };
      }
      if (input.cursor === 'provider-next') {
        return {
          items: [{ displayName: 'Second Provider', id: 'provider-2', providerKey: 'second' }],
          nextCursor: null,
        };
      }
      return {
        items: [{ displayName: 'First Provider', id: 'provider-1', providerKey: 'first' }],
        nextCursor: 'provider-next',
      };
    });
    const { result } = renderHook(() =>
      useModelProviderTargetPicker({ loadTargets, onSubmit: vi.fn() }),
    );

    await waitFor(() => expect(result.current.items[0]?.id).toBe('provider-1'));
    expect(loadTargets).toHaveBeenLastCalledWith({
      cursor: undefined,
      limit: 20,
      query: undefined,
    });

    act(() => result.current.goToNextPage());
    await waitFor(() => expect(result.current.items[0]?.id).toBe('provider-2'));
    expect(loadTargets).toHaveBeenLastCalledWith({
      cursor: 'provider-next',
      limit: 20,
      query: undefined,
    });

    act(() => result.current.goToPreviousPage());
    await waitFor(() => expect(result.current.page).toBe(1));

    act(() => result.current.setQuery('  empty  '));
    await waitFor(
      () => {
        expect(result.current.items[0]?.id).toBe('provider-empty');
      },
      { timeout: 1000 },
    );
    expect(loadTargets).toHaveBeenLastCalledWith({
      cursor: undefined,
      limit: 20,
      query: 'empty',
    });
  });

  it('preserves the selected Provider and supports retry when opening the editor fails', async () => {
    const onSubmit = vi
      .fn<(providerId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('draft context unavailable'))
      .mockResolvedValueOnce();
    const loadTargets = vi.fn().mockResolvedValue({
      items: [
        {
          displayName: 'Provider without models',
          id: 'provider-empty',
          providerKey: 'empty',
        },
      ],
      nextCursor: null,
    });
    const { result } = renderHook(() => useModelProviderTargetPicker({ loadTargets, onSubmit }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.selectProvider('provider-empty'));

    await act(async () => {
      await expect(result.current.submit()).resolves.toBe(false);
    });
    expect(result.current.selectedProviderId).toBe('provider-empty');
    expect(result.current.submitFailed).toBe(true);

    await act(async () => {
      await expect(result.current.submit()).resolves.toBe(true);
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith('provider-empty');
    expect(result.current.submitFailed).toBe(false);
  });

  it('surfaces target loading failure and retries the same page', async () => {
    const loadTargets = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce({
        items: [{ displayName: 'Provider', id: 'provider-1', providerKey: 'provider' }],
        nextCursor: null,
      });
    const { result } = renderHook(() =>
      useModelProviderTargetPicker({ loadTargets, onSubmit: vi.fn() }),
    );

    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    act(() => result.current.retryLoad());
    await waitFor(() => expect(result.current.items[0]?.id).toBe('provider-1'));
    expect(result.current.loadFailed).toBe(false);
    expect(loadTargets).toHaveBeenCalledTimes(2);
  });
});
