import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Layout from './index';
import { HOME_FADE_MS } from './style';

const state = vi.hoisted(() => ({
  pathname: '/',
  reduceMotion: false as boolean | null,
}));

vi.mock('react-router', () => ({
  Outlet: () => <div data-testid="outlet" />,
  useLocation: () => ({ pathname: state.pathname }),
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => null,
}));

vi.mock('@/hooks/useIsDark', () => ({ useIsDark: () => false }));

vi.mock('motion/react', () => ({ useReducedMotion: () => state.reduceMotion }));

vi.mock('./Sidebar', () => ({ default: () => <div data-testid="home-sidebar" /> }));
vi.mock('./HomeAgentIdSync', () => ({ default: () => null }));
vi.mock('./RecentHydration', () => ({ default: () => null }));

const overlay = () => screen.getByTestId('home-overlay');

/** React's `<Activity mode="hidden">` sets `display: none !important` inline. */
const isStructurallyHidden = () => overlay().style.display === 'none';

describe('DesktopHomeLayout hide/show choreography', () => {
  beforeEach(() => {
    state.pathname = '/';
    state.reduceMotion = false;
    // `requestAnimationFrame` is not in Vitest's default `toFake` set; the entry
    // gate depends on it, so fake it explicitly to keep this deterministic.
    vi.useFakeTimers({
      toFake: [
        'Date',
        'cancelAnimationFrame',
        'clearInterval',
        'clearTimeout',
        'requestAnimationFrame',
        'setInterval',
        'setTimeout',
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const renderHome = () => {
    const utils = render(<Layout />);
    // Flush the entry rAF so the initial home paint is settled.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    return utils;
  };

  it('paints home visible and interactive on the home route', () => {
    renderHome();

    expect(isStructurallyHidden()).toBe(false);
    expect(overlay().getAttribute('aria-hidden')).not.toBe('true');
    expect(overlay().dataset.homeState).toBe('visible');
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('keeps the subtree displayed for the whole exit fade, then hides it', () => {
    const { rerender } = renderHome();

    state.pathname = '/image';
    act(() => {
      rerender(<Layout />);
    });

    // Fade in progress: React must NOT have applied `display: none` yet, or the
    // opacity transition would never run.
    expect(isStructurallyHidden()).toBe(false);
    expect(overlay().dataset.homeState).toBe('hidden');
    // …but it is already inert and hidden from assistive tech, so it cannot
    // cover or steal input from the incoming route.
    expect(overlay().getAttribute('aria-hidden')).toBe('true');
    expect(overlay().hasAttribute('inert')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(HOME_FADE_MS + 20);
    });

    expect(isStructurallyHidden()).toBe(true);
  });

  it('cancels the pending hide when the user returns home mid-fade', () => {
    const { rerender } = renderHome();

    state.pathname = '/image';
    act(() => {
      rerender(<Layout />);
    });
    act(() => {
      vi.advanceTimersByTime(HOME_FADE_MS / 2);
    });

    state.pathname = '/';
    act(() => {
      rerender(<Layout />);
    });
    act(() => {
      vi.advanceTimersByTime(HOME_FADE_MS * 2);
    });

    expect(isStructurallyHidden()).toBe(false);
    expect(overlay().dataset.homeState).toBe('visible');
    expect(overlay().getAttribute('aria-hidden')).not.toBe('true');
  });

  it('fades back in from transparent when returning home', () => {
    const { rerender } = renderHome();

    state.pathname = '/image';
    act(() => {
      rerender(<Layout />);
    });
    act(() => {
      vi.advanceTimersByTime(HOME_FADE_MS + 20);
    });
    expect(isStructurallyHidden()).toBe(true);

    state.pathname = '/';
    act(() => {
      rerender(<Layout />);
    });

    // Displayed again (so the transition has a starting frame) but still transparent.
    expect(isStructurallyHidden()).toBe(false);
    expect(overlay().dataset.homeState).toBe('hidden');

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(overlay().dataset.homeState).toBe('visible');
  });

  it('hides immediately under reduced motion, with no timer', () => {
    state.reduceMotion = true;
    const { rerender } = renderHome();

    expect(overlay().dataset.homeState).toBe('visible');

    state.pathname = '/image';
    act(() => {
      rerender(<Layout />);
    });

    expect(isStructurallyHidden()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
