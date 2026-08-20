import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RouteTransition from './index';
import { FULL_CLIP_PATH, MAIN_REVEAL_INSET_PERCENT, SECTION_TRANSITION_S } from './timing';

const state = vi.hoisted(() => ({
  onAnimationComplete: null as (() => void) | null,
  pathname: '/',
  reduceMotion: false as boolean | null,
  slug: null as string | null,
}));

vi.mock('react-router', () => ({
  useLocation: () => ({ pathname: state.pathname }),
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => state.slug,
}));

interface MotionDivProps {
  [key: string]: unknown;
  animate?: unknown;
  children?: ReactNode;
  className?: string;
  exit?: unknown;
  initial?: unknown;
  onAnimationComplete?: () => void;
  transition?: unknown;
}

vi.mock('motion/react', () => ({
  m: {
    div: ({
      animate,
      children,
      exit,
      initial,
      onAnimationComplete,
      transition,
      ...rest
    }: MotionDivProps) => {
      state.onAnimationComplete = onAnimationComplete ?? null;
      return (
        <div
          {...(rest as Record<string, unknown>)}
          data-animate={JSON.stringify(animate ?? null)}
          data-animated="true"
          data-exit={JSON.stringify(exit ?? null)}
          data-initial={JSON.stringify(initial ?? null)}
          data-transition={JSON.stringify(transition ?? null)}
        >
          {children}
        </div>
      );
    },
  },
  useReducedMotion: () => state.reduceMotion,
}));

const Page = () => <div data-testid="outlet">page</div>;

const renderTransition = () =>
  render(
    <RouteTransition>
      <Page />
    </RouteTransition>,
  );

const layer = (container: HTMLElement) =>
  container.querySelector('[data-route-key]') as HTMLElement | null;

const readProp = (container: HTMLElement, attribute: string): unknown =>
  JSON.parse(layer(container)?.getAttribute(attribute) ?? 'null');

describe('RouteTransition', () => {
  beforeEach(() => {
    state.pathname = '/';
    state.slug = null;
    state.reduceMotion = false;
    state.onAnimationComplete = null;
  });

  afterEach(() => {
    document.documentElement.dir = '';
  });

  it('renders its children', () => {
    renderTransition();

    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('changes the transition key when the top-level segment changes', () => {
    const { container, rerender } = renderTransition();

    expect(layer(container)?.getAttribute('data-route-key')).toBe('home');

    state.pathname = '/image';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    expect(layer(container)?.getAttribute('data-route-key')).toBe('image');
  });

  it('keeps the same key while navigating inside one section', () => {
    state.pathname = '/community';
    const { container, rerender } = renderTransition();
    const before = layer(container);

    state.pathname = '/community/mcp';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    expect(layer(container)?.getAttribute('data-route-key')).toBe('community');
    // Same key ⇒ same element instance ⇒ motion never replays `initial`.
    expect(layer(container)).toBe(before);
  });

  it('renders a plain, unanimated wrapper when reduced motion is requested', () => {
    state.reduceMotion = true;
    const { container } = renderTransition();

    expect(screen.getByTestId('outlet')).toBeInTheDocument();
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(layer(container)).not.toBeNull();
  });

  it('does not animate the very first paint after boot', () => {
    const { container } = renderTransition();

    expect(container.querySelector('[data-animated]')).not.toBeNull();
    expect(readProp(container, 'data-initial')).toBe(false);
  });

  it('reveals from the inline-end when moving deeper', () => {
    const { container, rerender } = renderTransition();

    state.pathname = '/image';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    expect(readProp(container, 'data-initial')).toEqual({
      clipPath: `inset(0% 0% 0% ${MAIN_REVEAL_INSET_PERCENT}%)`,
      opacity: 0,
    });
    expect(readProp(container, 'data-animate')).toEqual({
      clipPath: FULL_CLIP_PATH,
      opacity: 1,
    });
  });

  it('reveals from the inline-start when moving back up', () => {
    state.pathname = '/settings/common';
    const { container, rerender } = renderTransition();

    state.pathname = '/';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    expect(readProp(container, 'data-initial')).toEqual({
      clipPath: `inset(0% ${MAIN_REVEAL_INSET_PERCENT}% 0% 0%)`,
      opacity: 0,
    });
  });

  it('mirrors the reveal under rtl', () => {
    document.documentElement.dir = 'rtl';
    const { container, rerender } = renderTransition();

    state.pathname = '/image';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    expect(readProp(container, 'data-initial')).toEqual({
      clipPath: `inset(0% ${MAIN_REVEAL_INSET_PERCENT}% 0% 0%)`,
      opacity: 0,
    });
  });

  it('never puts a transform on the wrapper', () => {
    const { container, rerender } = renderTransition();

    state.pathname = '/settings';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    const initial = readProp(container, 'data-initial') as Record<string, unknown>;
    const animate = readProp(container, 'data-animate') as Record<string, unknown>;
    const transformKeys = ['x', 'y', 'scale', 'rotate', 'transform', 'translateX'];

    for (const key of transformKeys) {
      expect(initial).not.toHaveProperty(key);
      expect(animate).not.toHaveProperty(key);
    }
    // No exit either: an outgoing layer would keep two panes in flow.
    expect(readProp(container, 'data-exit')).toBeNull();
  });

  it('writes no clip at all when there is no direction to show', () => {
    state.pathname = '/image';
    const { container, rerender } = renderTransition();

    // `/image` and `/video` share one sidebar — same place, nothing to point at.
    state.pathname = '/video';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    expect(readProp(container, 'data-initial')).toEqual({ opacity: 0 });
    expect(readProp(container, 'data-animate')).toEqual({ opacity: 1 });
  });

  it('drops the finished clip so it cannot clip fixed descendants forever', () => {
    const { container, rerender } = renderTransition();

    state.pathname = '/image';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    const node = layer(container)!;
    node.style.clipPath = FULL_CLIP_PATH;
    expect(state.onAnimationComplete).toBeTypeOf('function');

    state.onAnimationComplete?.();

    expect(node.style.clipPath).toBe('');
  });

  it('runs on the shared section clock', () => {
    const { container, rerender } = renderTransition();

    state.pathname = '/image';
    rerender(
      <RouteTransition>
        <Page />
      </RouteTransition>,
    );

    expect(readProp(container, 'data-transition')).toEqual({
      duration: SECTION_TRANSITION_S,
      ease: [0.32, 0.72, 0, 1],
    });
  });
});
