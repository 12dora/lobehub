import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RouteTransition, { getRouteTransitionKey } from './index';

const state = vi.hoisted(() => ({
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
  transition?: unknown;
}

vi.mock('motion/react', () => ({
  m: {
    div: ({
      animate: _animate,
      children,
      exit: _exit,
      initial: _initial,
      transition: _transition,
      ...rest
    }: MotionDivProps) => (
      <div {...(rest as Record<string, unknown>)} data-animated="true">
        {children}
      </div>
    ),
  },
  useReducedMotion: () => state.reduceMotion,
}));

describe('getRouteTransitionKey', () => {
  it('maps the root path to the home key', () => {
    expect(getRouteTransitionKey('/', null)).toBe('home');
    expect(getRouteTransitionKey('', null)).toBe('home');
  });

  it('uses the first path segment', () => {
    expect(getRouteTransitionKey('/image', null)).toBe('image');
    expect(getRouteTransitionKey('/community/mcp', null)).toBe('community');
    expect(getRouteTransitionKey('/agent/abc-123', null)).toBe('agent');
  });

  it('skips the active workspace slug', () => {
    expect(getRouteTransitionKey('/lobe-team', 'lobe-team')).toBe('home');
    expect(getRouteTransitionKey('/lobe-team/', 'lobe-team')).toBe('home');
    expect(getRouteTransitionKey('/lobe-team/image', 'lobe-team')).toBe('image');
    expect(getRouteTransitionKey('/lobe-team/agent/abc', 'lobe-team')).toBe('agent');
  });

  it('does not strip a segment that only looks like the slug', () => {
    expect(getRouteTransitionKey('/image', 'lobe-team')).toBe('image');
  });
});

describe('RouteTransition', () => {
  beforeEach(() => {
    state.pathname = '/';
    state.slug = null;
    state.reduceMotion = false;
  });

  it('renders its children', () => {
    render(
      <RouteTransition>
        <div data-testid="outlet">page</div>
      </RouteTransition>,
    );

    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('changes the transition key when the top-level segment changes', () => {
    const { rerender, container } = render(
      <RouteTransition>
        <div>page</div>
      </RouteTransition>,
    );

    expect(container.querySelector('[data-route-key]')?.getAttribute('data-route-key')).toBe(
      'home',
    );

    state.pathname = '/image';
    rerender(
      <RouteTransition>
        <div>page</div>
      </RouteTransition>,
    );

    expect(container.querySelector('[data-route-key]')?.getAttribute('data-route-key')).toBe(
      'image',
    );
  });

  it('keeps the same key while navigating inside one section', () => {
    state.pathname = '/community';
    const { rerender, container } = render(
      <RouteTransition>
        <div>page</div>
      </RouteTransition>,
    );

    state.pathname = '/community/mcp';
    rerender(
      <RouteTransition>
        <div>page</div>
      </RouteTransition>,
    );

    expect(container.querySelector('[data-route-key]')?.getAttribute('data-route-key')).toBe(
      'community',
    );
  });

  it('renders a plain, unanimated wrapper when reduced motion is requested', () => {
    state.reduceMotion = true;
    const { container } = render(
      <RouteTransition>
        <div data-testid="outlet">page</div>
      </RouteTransition>,
    );

    expect(screen.getByTestId('outlet')).toBeInTheDocument();
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(container.querySelector('[data-route-key]')).not.toBeNull();
  });

  it('animates when reduced motion is not requested', () => {
    const { container } = render(
      <RouteTransition>
        <div>page</div>
      </RouteTransition>,
    );

    expect(container.querySelector('[data-animated]')).not.toBeNull();
  });
});
