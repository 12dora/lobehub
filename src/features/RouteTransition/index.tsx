'use client';

import { createStaticStyles } from 'antd-style';
import { m, useReducedMotion } from 'motion/react';
import { memo, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';

export const HOME_ROUTE_TRANSITION_KEY = 'home';

/**
 * First "app segment" of a pathname, workspace-slug aware:
 *
 * - `/` → `home`
 * - `/lobe-team` → `home`
 * - `/image` and `/lobe-team/image` → `image`
 * - `/agent/abc` → `agent`
 *
 * Keeping the key at segment granularity means in-section navigation
 * (`/community` → `/community/mcp`, `/agent/a` → `/agent/b`) does not re-run
 * the transition — only leaving one top-level area for another does.
 *
 * NOTE: `src/features/NavPanel/index.tsx` has the same segment logic
 * (`getMainRouteSegment`) but does not export it; it is duplicated here rather
 * than editing that file. Keep the two in sync.
 */
export const getRouteTransitionKey = (pathname: string, activeSlug?: string | null): string => {
  const segments = pathname.split('/').filter(Boolean);
  const segment = activeSlug && segments[0] === activeSlug ? segments[1] : segments[0];
  return segment || HOME_ROUTE_TRANSITION_KEY;
};

const styles = createStaticStyles(({ css }) => ({
  // Layout-transparent: reproduces the box the Outlet's children already got as
  // direct children of the (column, height:100%) layout container. No extra
  // scroll container, no height cap — full-bleed panes keep working.
  layer: css`
    display: flex;
    flex: 1;
    flex-direction: column;

    width: 100%;
    min-height: 0;
  `,
}));

/**
 * ~180ms — long enough to read as a transition, short enough not to feel laggy.
 *
 * Opacity only, deliberately no translate: a transform on this wrapper would
 * make it the containing block for every `position: fixed` descendant while the
 * animation runs (settings save bar, resource fullscreen modal, upload dock,
 * text-selection layer …), which would jump and clip them for ~180ms on every
 * route entry. Opacity creates a stacking context but not a containing block.
 */
const ENTER_DURATION = 0.18;
const ENTER_EASE: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

interface RouteTransitionProps {
  children?: ReactNode;
}

/**
 * Fades the main outlet in whenever the top-level route area changes.
 *
 * Deliberately enter-only. An exit animation would need either
 * `AnimatePresence mode="wait"` — which delays mounting the next route, and
 * therefore delays its lazy chunk request by the exit duration — or two
 * simultaneous in-flow layers, which shifts layout. The outgoing side of the
 * crossfade is provided by the home overlay's own opacity fade
 * (`src/routes/(main)/home/_layout`), which is the surface users actually
 * leave when this transition matters.
 */
const RouteTransition = memo<RouteTransitionProps>(({ children }) => {
  const { pathname } = useLocation();
  const activeSlug = useActiveWorkspaceSlug();
  const reduceMotion = useReducedMotion();

  const transitionKey = getRouteTransitionKey(pathname, activeSlug);

  if (reduceMotion)
    return (
      <div className={styles.layer} data-route-key={transitionKey} key={transitionKey}>
        {children}
      </div>
    );

  return (
    <m.div
      animate={{ opacity: 1 }}
      className={styles.layer}
      data-route-key={transitionKey}
      initial={{ opacity: 0 }}
      key={transitionKey}
      transition={{ duration: ENTER_DURATION, ease: ENTER_EASE }}
    >
      {children}
    </m.div>
  );
});

RouteTransition.displayName = 'RouteTransition';

export default RouteTransition;
