import { render, waitFor } from '@testing-library/react';
import { domMax, LazyMotion } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RouteTransition from './index';

/**
 * Unlike `index.test.tsx`, this file deliberately runs against the REAL motion
 * runtime (same `LazyMotion features={domMax}` the SPA provider installs). The
 * contract it guards is invisible to a mocked `m.div`: the reveal must hand the
 * clip back to the UA when it lands (`transitionEnd`), and must keep it handed
 * back across later renders — `clip-path` clips every descendant, `position:
 * fixed` ones included, so a retained `inset(...)` would clip the settings save
 * bar / upload dock / PDF chrome to the outlet box for the life of the route.
 */

const state = vi.hoisted(() => ({
  pathname: '/',
  slug: null as string | null,
}));

vi.mock('react-router', () => ({
  useLocation: () => ({ pathname: state.pathname }),
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => state.slug,
}));

// `RouteTransition` is memoised, so every re-render has to hand it a fresh
// children element — exactly what the real `<Outlet />` does on navigation.
const Harness = ({ label }: { label: string }) => (
  <LazyMotion features={domMax}>
    <RouteTransition>
      <span data-testid="outlet">{label}</span>
    </RouteTransition>
  </LazyMotion>
);

const layer = (container: HTMLElement) =>
  container.querySelector('[data-route-key]') as HTMLElement;

describe('RouteTransition (real motion runtime)', () => {
  beforeEach(() => {
    state.pathname = '/';
    state.slug = null;
  });

  it('leaves no clip-path behind once the directional reveal has finished', async () => {
    const { container, rerender } = render(<Harness label="page" />);

    // First paint does not animate; the wrapper must be unclipped from the start.
    expect(layer(container).style.clipPath).toBe('');

    state.pathname = '/settings';
    rerender(<Harness label="page" />);

    const node = layer(container);
    expect(node.getAttribute('data-route-key')).toBe('settings');
    // The reveal really did run: the entering pane starts clipped.
    expect(node.style.clipPath).toMatch(/^inset\(/);

    // Wait for the reveal to settle.
    await waitFor(() => expect(node.style.opacity).toBe('1'), { timeout: 4000 });

    // `transitionEnd` hands the clip back to the UA once the reveal is over…
    expect(node.style.clipPath).toBe('none');

    // …and it stays handed back across ordinary re-renders, which is what makes
    // `transitionEnd` (motion's own state) the right lever rather than an
    // imperative `style.clipPath = ''` that only patches the DOM.
    rerender(<Harness label="page again" />);
    rerender(<Harness label="page once more" />);

    expect(layer(container)).toBe(node);
    expect(node.style.clipPath).not.toMatch(/inset/);
  });
});
