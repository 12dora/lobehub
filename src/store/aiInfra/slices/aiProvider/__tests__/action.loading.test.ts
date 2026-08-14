import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aiProviderService } from '@/services/aiProvider';

import { useAiInfraStore as useStore } from '../../../store';

vi.mock('zustand/traditional');

/**
 * Admin provider writes go through `applyImmediate` and THROW on failure (there is no
 * draft/publish fallback any more). The per-item spinner must therefore clear on the
 * rejection path too, or the enable switch spins forever behind the error toast.
 */
beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    useStore.setState({ aiProviderList: [], aiProviderLoadingIds: [] });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AiProviderAction loading lifecycle', () => {
  it('clears the toggle spinner when the write rejects', async () => {
    const { result } = renderHook(() => useStore());
    const toggleLoadingSpy = vi
      .spyOn(result.current, 'internal_toggleAiProviderLoading')
      .mockImplementation(() => {});
    vi.spyOn(result.current, 'refreshAiProviderList').mockResolvedValue(undefined);
    vi.spyOn(aiProviderService, 'toggleProviderEnabled').mockRejectedValue(
      new Error('apply failed'),
    );

    await expect(async () => {
      await act(async () => {
        await result.current.toggleProviderEnabled('openai', true);
      });
    }).rejects.toThrow('apply failed');

    expect(toggleLoadingSpy).toHaveBeenCalledWith('openai', true);
    expect(toggleLoadingSpy).toHaveBeenCalledWith('openai', false);
  });

  it('clears the toggle spinner on the success path', async () => {
    const { result } = renderHook(() => useStore());
    const toggleLoadingSpy = vi
      .spyOn(result.current, 'internal_toggleAiProviderLoading')
      .mockImplementation(() => {});
    vi.spyOn(result.current, 'refreshAiProviderList').mockResolvedValue(undefined);
    vi.spyOn(aiProviderService, 'toggleProviderEnabled').mockResolvedValue(undefined as never);

    await act(async () => {
      await result.current.toggleProviderEnabled('openai', true);
    });

    expect(toggleLoadingSpy).toHaveBeenNthCalledWith(1, 'openai', true);
    expect(toggleLoadingSpy).toHaveBeenLastCalledWith('openai', false);
  });

  it('keeps the original reorder failure when the resync also fails', async () => {
    const { result } = renderHook(() => useStore());
    const marked = new Error('order write failed');
    // Mirrors the adapter marker: the failure is already toasted, so the caller must be able
    // to recognise it and stay silent instead of stacking a second generic toast.
    Object.defineProperty(marked, Symbol.for('lobe.adminAiInfraErrorToasted'), { value: true });
    const refreshSpy = vi
      .spyOn(result.current, 'refreshAiProviderList')
      .mockRejectedValue(new Error('refresh failed'));
    vi.spyOn(aiProviderService, 'updateAiProviderOrder').mockRejectedValue(marked);

    await expect(result.current.updateAiProviderSort([{ id: 'openai', sort: 0 }])).rejects.toBe(
      marked,
    );
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces a resync failure only when the reorder writes succeeded', async () => {
    const { result } = renderHook(() => useStore());
    vi.spyOn(result.current, 'refreshAiProviderList').mockRejectedValue(
      new Error('refresh failed'),
    );
    vi.spyOn(aiProviderService, 'updateAiProviderOrder').mockResolvedValue(undefined);

    await expect(result.current.updateAiProviderSort([{ id: 'openai', sort: 0 }])).rejects.toThrow(
      'refresh failed',
    );
  });

  it('resyncs the list after a successful reorder', async () => {
    const { result } = renderHook(() => useStore());
    const refreshSpy = vi
      .spyOn(result.current, 'refreshAiProviderList')
      .mockResolvedValue(undefined);
    vi.spyOn(aiProviderService, 'updateAiProviderOrder').mockResolvedValue(undefined);

    await result.current.updateAiProviderSort([{ id: 'openai', sort: 0 }]);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the update spinner when updateAiProvider rejects', async () => {
    const { result } = renderHook(() => useStore());
    const toggleLoadingSpy = vi
      .spyOn(result.current, 'internal_toggleAiProviderLoading')
      .mockImplementation(() => {});
    vi.spyOn(result.current, 'refreshAiProviderList').mockResolvedValue(undefined);
    vi.spyOn(result.current, 'refreshAiProviderDetail').mockResolvedValue(undefined);
    vi.spyOn(aiProviderService, 'updateAiProvider').mockRejectedValue(new Error('apply failed'));

    await expect(async () => {
      await act(async () => {
        await result.current.updateAiProvider('openai', { name: 'Renamed' });
      });
    }).rejects.toThrow('apply failed');

    expect(toggleLoadingSpy).toHaveBeenCalledWith('openai', false);
  });
});
