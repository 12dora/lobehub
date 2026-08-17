import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isTabVisible, onceVisible, useIsPollGateOpen, useVisiblePoll } from './useVisiblePoll';

const setVisibility = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
};

afterEach(() => {
  setVisibility('visible');
  setOnline(true);
});

describe('useVisiblePoll', () => {
  it('polls at the table cadence while the tab is visible and online', () => {
    const { result } = renderHook(() => useVisiblePoll(30_000));

    expect(result.current).toBe(30_000);
  });

  it('stops polling entirely while the tab is hidden, and resumes when it comes back', () => {
    const { result } = renderHook(() => useVisiblePoll(30_000));

    setVisibility('hidden');
    expect(result.current).toBe(0);

    setVisibility('visible');
    expect(result.current).toBe(30_000);
  });

  it('stops polling while offline — a request that cannot leave the tab is pure cost', () => {
    const { result } = renderHook(() => useVisiblePoll(15_000));

    setOnline(false);
    expect(result.current).toBe(0);

    setOnline(true);
    expect(result.current).toBe(15_000);
  });

  it("honours the call site's own condition (job in flight, module enabled, …)", () => {
    const { rerender, result } = renderHook(({ active }) => useVisiblePoll(3000, active), {
      initialProps: { active: false },
    });

    expect(result.current).toBe(0);

    rerender({ active: true });
    expect(result.current).toBe(3000);

    // Both conditions must hold.
    setVisibility('hidden');
    expect(result.current).toBe(0);
  });

  it('reads the current visibility on mount, not only on later events', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    const { result } = renderHook(() => useIsPollGateOpen());

    expect(result.current).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useVisiblePoll(30_000));

    unmount();

    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    remove.mockRestore();
  });
});

describe('isTabVisible / onceVisible', () => {
  it('reads visibility without a subscription', () => {
    expect(isTabVisible()).toBe(true);

    setVisibility('hidden');
    expect(isTabVisible()).toBe(false);
  });

  it('fires once the next time the tab becomes visible, then unsubscribes', () => {
    setVisibility('hidden');
    const listener = vi.fn();
    onceVisible(listener);

    // Still hidden: a visibilitychange that does not make the tab visible must not fire it.
    setVisibility('hidden');
    expect(listener).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(listener).toHaveBeenCalledOnce();

    setVisibility('hidden');
    setVisibility('visible');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('can be cancelled before the tab returns', () => {
    setVisibility('hidden');
    const listener = vi.fn();
    const stop = onceVisible(listener);

    stop();
    setVisibility('visible');

    expect(listener).not.toHaveBeenCalled();
  });
});
