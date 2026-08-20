import { createStaticStyles } from 'antd-style';

import {
  HOME_OVERLAY_TRAVEL_PX,
  SECTION_TRANSITION_EASE_CSS,
  SECTION_TRANSITION_MS,
} from '@/features/RouteTransition/timing';

/**
 * Home overlay fade duration when entering/leaving the home route.
 *
 * Locked to the shared section clock (`@/features/RouteTransition/timing`) so the
 * overlay, the left nav and the main outlet read as one level change instead of
 * three staggered blinks. `src/routes/(main)/home/_layout/index.tsx` also uses it
 * as the delay before `<Activity mode="hidden">` cuts the DOM.
 */
export const HOME_FADE_MS = SECTION_TRANSITION_MS;

export const styles = createStaticStyles(({ css, cssVar }) => ({
  // Absolutely positioned container, fills parent
  absoluteContainer: css`
    position: absolute;
    inset: 0;
  `,

  // Content area - dark mode
  contentDark: css`
    overflow: hidden;
    background: linear-gradient(
      to bottom,
      ${cssVar.colorBgContainer},
      var(--content-bg-secondary, ${cssVar.colorBgContainer})
    );
  `,

  // Content area - light mode
  contentLight: css`
    overflow: hidden;
    background: var(--content-bg-secondary, ${cssVar.colorBgContainer});
  `,

  // Off-home state. `<Activity mode="hidden">` preserves state but does not hide
  // the DOM, and this container overlays the outlet — so it must stop painting
  // and stop taking pointer events. Fading opacity (instead of snapping to
  // `display: none`) is what turns "home vanished, splash appeared" into a
  // crossfade with the incoming route. `visibility` flips only after the fade so
  // the node leaves the a11y / hit-test tree without cutting the animation short.
  //
  // The small inline-start shift is the "pushed back a level" half of the
  // hierarchical transition the incoming section plays. It lives only on this
  // (hidden, inert) state: `visible` keeps `transform: none` so the overlay never
  // becomes a containing block for `position: fixed` descendants while home is
  // actually in use. `none` interpolates against a translate as the identity
  // matrix, so the transition still runs both ways.
  hidden: css`
    pointer-events: none;

    transform: translateX(-${HOME_OVERLAY_TRAVEL_PX}px);

    visibility: hidden;
    opacity: 0;

    transition:
      opacity ${HOME_FADE_MS}ms ${SECTION_TRANSITION_EASE_CSS},
      transform ${HOME_FADE_MS}ms ${SECTION_TRANSITION_EASE_CSS},
      visibility 0s linear ${HOME_FADE_MS}ms;

    [dir='rtl'] & {
      transform: translateX(${HOME_OVERLAY_TRAVEL_PX}px);
    }

    @media (prefers-reduced-motion: reduce) {
      transform: none;
      transition: none;
    }
  `,

  // On-home state.
  visible: css`
    transform: none;
    visibility: visible;
    opacity: 1;
    transition:
      opacity ${HOME_FADE_MS}ms ${SECTION_TRANSITION_EASE_CSS},
      transform ${HOME_FADE_MS}ms ${SECTION_TRANSITION_EASE_CSS};

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
}));
