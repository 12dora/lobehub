import type { ComponentProps } from 'react';

/**
 * Props that take a hover-only tooltip out of hit-testing completely.
 *
 * `styles.root` reaches the tooltip POPUP, which is only half of the floating chain: the
 * positioner is a box around the popup, and with a long description — or after a collision
 * flip — that box still swallowed the rows it covered, so an option under an open tooltip
 * could not be hovered or clicked.
 *
 * The positioner's style cannot be handed over directly: `@lobehub/ui` computes it (z-index,
 * placement) and REPLACES it with `positionerProps.style` instead of merging, which is why its
 * type omits `style` in the first place. `render` is the seam Base UI leaves for exactly this
 * — the element is rebuilt with every prop the package computed, plus the one declaration the
 * hover affordance needs.
 *
 * Shared because the recipe has no room for variation and four call sites need it verbatim;
 * a drifting copy would silently start swallowing clicks again.
 */
export const nonInteractiveTooltipProps = {
  positionerProps: {
    render: (props: ComponentProps<'div'>) => (
      <div {...props} style={{ ...props.style, pointerEvents: 'none' }} />
    ),
  },
  styles: { root: { pointerEvents: 'none' as const } },
};
