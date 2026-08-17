import { render, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { SWRConfig, type SWRConfiguration } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useClientDataSWR, useOnlyFetchOnceSWR } from './index';

let keyCounter = 0;
const nextKey = () => `client-data-swr-${keyCounter++}`;

/** Let the first request settle so the dedupe window (not the in-flight
 *  request) is what decides whether the next subscriber refetches. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * Mounts N independent subscribers of the same SWR key inside one cache.
 * Mounting the second one *after* the first has settled is the pattern the
 * 2000ms `dedupingInterval` default exists for: on a cold chat-home load the
 * same key was requested 2–3× by components that mount a few hundred ms apart.
 */
const renderSubscribers = (useHook: () => unknown, { children }: { children?: ReactNode } = {}) => {
  const Probe = () => {
    useHook();

    return null;
  };
  const cache = new Map();
  const Tree = ({ count }: { count: number }) => (
    <SWRConfig value={{ provider: () => cache }}>
      {Array.from({ length: count }, (_, index) => (
        <Probe key={index} />
      ))}
      {children}
    </SWRConfig>
  );

  const utils = render(<Tree count={1} />);

  return { mountSecond: () => utils.rerender(<Tree count={2} />), ...utils };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useClientDataSWR deduping', () => {
  it('collapses a second subscriber mounted inside the dedupe window', async () => {
    const fetcher = vi.fn(async () => 'value');
    const cacheKey = nextKey();

    const { mountSecond } = renderSubscribers(() => useClientDataSWR(cacheKey, fetcher));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await settle();
    mountSecond();
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('revalidates again once the 2000ms window has expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const fetcher = vi.fn(async () => 'value');
    const cacheKey = nextKey();

    const { mountSecond } = renderSubscribers(() => useClientDataSWR(cacheKey, fetcher));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    vi.advanceTimersByTime(2500);
    mountSecond();

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('honours a caller-supplied dedupingInterval override', async () => {
    const fetcher = vi.fn(async () => 'value');
    const cacheKey = nextKey();
    const config: SWRConfiguration = { dedupingInterval: 0 };

    const { mountSecond } = renderSubscribers(() => useClientDataSWR(cacheKey, fetcher, config));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await settle();
    mountSecond();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('still fetches immediately when the key changes', async () => {
    const fetcher = vi.fn(async (k: string) => k);
    const first = nextKey();
    const second = nextKey();
    const cache = new Map();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache }}>{children}</SWRConfig>
    );

    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => useClientDataSWR(k, () => fetcher(k)),
      { initialProps: { k: first }, wrapper },
    );

    await waitFor(() => expect(result.current.data).toBe(first));

    rerender({ k: second });
    await waitFor(() => expect(result.current.data).toBe(second));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('leaves useOnlyFetchOnceSWR semantics untouched', async () => {
    const fetcher = vi.fn(async () => 'value');
    const cacheKey = nextKey();

    const { mountSecond } = renderSubscribers(() => useOnlyFetchOnceSWR(cacheKey, fetcher));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await settle();
    mountSecond();
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
