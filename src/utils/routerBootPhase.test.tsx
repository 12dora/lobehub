import { act, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  BootPhaseRouteMarker,
  createRouterBootPhase,
  RouteFallback,
  RouterBootPhaseContext,
} from './routerBootPhase';

vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: ({ debugId, variant }: { debugId: string; variant?: string }) => (
    <div
      data-debug-id={debugId}
      data-testid="route-fallback"
      data-variant={variant ?? 'fullscreen'}
    />
  ),
}));

const flushMicrotasks = () => act(async () => {});

/** Resolvable module stub for a lazily-loaded route element. */
const deferredRoute = (testId: string) => {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });

  const Component = lazy(async () => {
    await gate;
    return { default: () => <div data-testid={testId} /> };
  });

  return { Component, resolve };
};

describe('createRouterBootPhase', () => {
  it('starts booting and settles once nothing is pending', async () => {
    const phase = createRouterBootPhase();
    expect(phase.isBooting()).toBe(true);

    phase.settleIfIdle();
    await flushMicrotasks();

    expect(phase.isBooting()).toBe(false);
  });

  it('does not settle while a fallback is still pending', async () => {
    const phase = createRouterBootPhase();
    const release = phase.retainFallback();

    phase.settleIfIdle();
    await flushMicrotasks();
    expect(phase.isBooting()).toBe(true);

    release();
    await flushMicrotasks();
    expect(phase.isBooting()).toBe(false);
  });

  it('stays booting when one fallback is replaced by another in the same flush', async () => {
    const phase = createRouterBootPhase();
    const releaseOuter = phase.retainFallback();

    // Layout chunk resolved: its fallback goes away while the nested leaf's
    // fallback mounts — synchronously, inside one effect flush.
    releaseOuter();
    const releaseLeaf = phase.retainFallback();

    await flushMicrotasks();
    expect(phase.isBooting()).toBe(true);

    releaseLeaf();
    await flushMicrotasks();
    expect(phase.isBooting()).toBe(false);
  });

  it('notifies subscribers exactly once when boot ends', async () => {
    const phase = createRouterBootPhase();
    const listener = vi.fn();
    phase.subscribe(listener);

    phase.settleIfIdle();
    phase.settleIfIdle();
    await flushMicrotasks();
    phase.settleIfIdle();
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(phase.isBooting()).toBe(false);
  });

  it('is per instance, so a recreated router boots again', async () => {
    const first = createRouterBootPhase();
    first.settleIfIdle();
    await flushMicrotasks();
    expect(first.isBooting()).toBe(false);

    // Router recreation (HMR, a second window, a new test): fresh boot phase.
    const second = createRouterBootPhase();
    expect(second.isBooting()).toBe(true);
  });
});

describe('RouteFallback', () => {
  it('renders the inline loader with no provider (never a stray boot splash)', () => {
    render(<RouteFallback debugId="detached" />);

    expect(screen.getByTestId('route-fallback').dataset.variant).toBe('inline');
  });

  it('keeps the boot splash for a cold nested route until the leaf commits', async () => {
    const phase = createRouterBootPhase();
    const layout = deferredRoute('layout');
    const leaf = deferredRoute('leaf');

    render(
      <RouterBootPhaseContext value={phase}>
        <Suspense fallback={<RouteFallback debugId="layout" />}>
          <BootPhaseRouteMarker>
            <layout.Component />
            <Suspense fallback={<RouteFallback debugId="leaf" />}>
              <BootPhaseRouteMarker>
                <leaf.Component />
              </BootPhaseRouteMarker>
            </Suspense>
          </BootPhaseRouteMarker>
        </Suspense>
      </RouterBootPhaseContext>,
    );

    // Only the outer boundary is on screen, and it is the boot splash.
    expect(screen.getByTestId('route-fallback').dataset.debugId).toBe('layout');
    expect(screen.getByTestId('route-fallback').dataset.variant).toBe('fullscreen');

    // Layout chunk lands; the leaf is still loading. This is the regression:
    // boot must NOT end here, so the leaf fallback is still the boot splash.
    await act(async () => {
      layout.resolve();
    });

    expect(screen.getByTestId('layout')).toBeInTheDocument();
    expect(screen.getByTestId('route-fallback').dataset.debugId).toBe('leaf');
    expect(screen.getByTestId('route-fallback').dataset.variant).toBe('fullscreen');
    expect(phase.isBooting()).toBe(true);

    // Leaf commits → boot is over.
    await act(async () => {
      leaf.resolve();
    });
    await flushMicrotasks();

    expect(screen.getByTestId('leaf')).toBeInTheDocument();
    expect(phase.isBooting()).toBe(false);
  });

  it('renders the inline loader for suspensions after boot', async () => {
    const phase = createRouterBootPhase();
    const leaf = deferredRoute('leaf');

    const { rerender } = render(
      <RouterBootPhaseContext value={phase}>
        <div />
      </RouterBootPhaseContext>,
    );

    phase.settleIfIdle();
    await flushMicrotasks();
    expect(phase.isBooting()).toBe(false);

    rerender(
      <RouterBootPhaseContext value={phase}>
        <Suspense fallback={<RouteFallback debugId="later-nav" />}>
          <BootPhaseRouteMarker>
            <leaf.Component />
          </BootPhaseRouteMarker>
        </Suspense>
      </RouterBootPhaseContext>,
    );

    expect(screen.getByTestId('route-fallback').dataset.variant).toBe('inline');

    await act(async () => {
      leaf.resolve();
    });
  });
});
