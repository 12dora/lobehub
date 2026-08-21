import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DelayedFallback, { DEFAULT_FALLBACK_DELAY_MS } from './index';

describe('DelayedFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('renders nothing before the default delay elapses', async () => {
    render(
      <DelayedFallback>
        <span data-testid="loader" />
      </DelayedFallback>,
    );

    expect(screen.queryByTestId('loader')).toBeNull();

    await advance(DEFAULT_FALLBACK_DELAY_MS - 1);
    expect(screen.queryByTestId('loader')).toBeNull();
  });

  it('renders its children once the delay elapses', async () => {
    render(
      <DelayedFallback>
        <span data-testid="loader" />
      </DelayedFallback>,
    );

    await advance(DEFAULT_FALLBACK_DELAY_MS);
    expect(screen.getByTestId('loader')).toBeInTheDocument();
  });

  it('honours a custom delay', async () => {
    render(
      <DelayedFallback delayMs={1000}>
        <span data-testid="loader" />
      </DelayedFallback>,
    );

    await advance(999);
    expect(screen.queryByTestId('loader')).toBeNull();

    await advance(1);
    expect(screen.getByTestId('loader')).toBeInTheDocument();
  });

  it('renders immediately when the delay is zero or negative', () => {
    const { rerender } = render(
      <DelayedFallback delayMs={0}>
        <span data-testid="loader" />
      </DelayedFallback>,
    );
    expect(screen.getByTestId('loader')).toBeInTheDocument();

    rerender(
      <DelayedFallback delayMs={-1}>
        <span data-testid="loader" />
      </DelayedFallback>,
    );
    expect(screen.getByTestId('loader')).toBeInTheDocument();
  });

  it('clears its timer on unmount so nothing fires afterwards', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = render(
      <DelayedFallback>
        <span data-testid="loader" />
      </DelayedFallback>,
    );

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    await advance(DEFAULT_FALLBACK_DELAY_MS * 2);
    expect(screen.queryByTestId('loader')).toBeNull();
    clearTimeoutSpy.mockRestore();
  });
});
