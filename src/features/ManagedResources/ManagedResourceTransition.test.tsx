import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ManagedResourceTransition } from './ManagedResourceTransition';

/**
 * Upstream renders the full-bleed settings pages (provider / skill / connector)
 * with no wrapper between the settings pane and the page. Those pages scroll
 * their own columns, which only works while that height chain stays unbroken —
 * so in the `content` state this boundary must add no DOM box at all.
 */
describe('ManagedResourceTransition', () => {
  it('renders content without any wrapper element', () => {
    const { container } = render(
      <ManagedResourceTransition state="content">
        <div data-testid="child" />
      </ManagedResourceTransition>,
    );

    expect(container.querySelector('[data-managed-resource-state]')).toBeNull();
    expect(container.firstElementChild).toBe(container.querySelector('[data-testid="child"]'));
  });

  it.each(['error', 'loading', 'managed'] as const)(
    'wraps the %s notice in a bounded, shrinkable box',
    (state) => {
      const { container } = render(
        <ManagedResourceTransition state={state}>
          <div data-testid="child" />
        </ManagedResourceTransition>,
      );

      const el = container.querySelector(`[data-managed-resource-state="${state}"]`) as HTMLElement;

      expect(el).not.toBeNull();
      expect(el.style.getPropertyValue('--lobe-flex')).toBe('1');
      expect(el.style.getPropertyValue('--lobe-flex-height')).toBe('100%');
      expect(el.style.minHeight).toBe('0');
      expect(el.querySelector('[data-testid="child"]')).not.toBeNull();
    },
  );
});
