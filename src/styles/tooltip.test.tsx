import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { nonInteractiveTooltipProps } from './tooltip';

describe('nonInteractiveTooltipProps', () => {
  it('takes the positioner out of hit-testing without dropping what the package computed', () => {
    const { container } = render(
      nonInteractiveTooltipProps.positionerProps.render({
        'data-placement': 'right',
        // What @lobehub/ui + Base UI hand the render seam: the floating z-index and the
        // resolved position. Losing either would put the tooltip behind other layers, or in
        // the wrong place — which is why the style is merged rather than replaced.
        'style': { insetBlockStart: 12, position: 'absolute', zIndex: 114_514 },
      } as Record<string, unknown>),
    );

    const positioner = container.firstElementChild as HTMLElement;
    expect(positioner.style.pointerEvents).toBe('none');
    expect(positioner.style.zIndex).toBe('114514');
    expect(positioner.style.position).toBe('absolute');
    expect(positioner.getAttribute('data-placement')).toBe('right');
  });

  it('keeps the popup itself non-interactive too', () => {
    // Both halves of the floating chain, or the one that is left keeps swallowing the rows.
    expect(nonInteractiveTooltipProps.styles.root.pointerEvents).toBe('none');
  });
});
