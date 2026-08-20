'use client';

import { createStaticStyles } from 'antd-style';
import { m, useReducedMotion } from 'motion/react';
import { memo, type ReactNode, useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';

import {
  FULL_CLIP_PATH,
  getInlineSign,
  getMainRouteSegment,
  getRevealClipPath,
  getSectionDirection,
  SECTION_TRANSITION_EASE,
  SECTION_TRANSITION_S,
  type SectionDirection,
} from './timing';

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

interface RouteTransitionProps {
  children?: ReactNode;
}

/**
 * Reveals the main outlet whenever the top-level route area changes, on the same
 * clock as the left nav and the home overlay (`./timing`).
 *
 * Two hard constraints shape the animation:
 *
 * 1. **Never a transform on this wrapper.** A transform would make it the
 *    containing block for every `position: fixed` descendant while the animation
 *    runs (settings save bar, resource fullscreen chrome, upload dock, PDF
 *    fullscreen nav …), which would jump and clip them on every route entry. So
 *    the directional cue is `clip-path: inset(...)` — it creates a stacking
 *    context but not a containing block — plus opacity.
 * 2. **Enter-only.** An exit animation would need either `AnimatePresence
 *    mode="wait"` — which delays mounting the next route and therefore delays its
 *    lazy chunk request by the exit duration — or two simultaneous in-flow
 *    layers, which shifts layout. The outgoing side of the crossfade is provided
 *    by the home overlay's own fade (`src/routes/(main)/home/_layout`), which is
 *    the surface users actually leave when this transition matters.
 */
const RouteTransition = memo<RouteTransitionProps>(({ children }) => {
  const { pathname } = useLocation();
  const activeSlug = useActiveWorkspaceSlug();
  const reduceMotion = useReducedMotion();

  const transitionKey = getMainRouteSegment(pathname, activeSlug);

  // Direction comes from the shared depth/peer table, not from `history`:
  // refresh, workspace-prefixed URLs, `replace` and Cmd-click all produce
  // histories that do not describe the level the user perceives.
  const previousKeyRef = useRef<string | null>(null);
  const directionRef = useRef<SectionDirection>(0);
  if (previousKeyRef.current !== transitionKey) {
    directionRef.current =
      previousKeyRef.current === null
        ? 0
        : getSectionDirection(previousKeyRef.current, transitionKey);
    previousKeyRef.current = transitionKey;
  }

  // The very first key after the boot splash must not animate: sliding the first
  // route in as the splash unmounts reads as a load glitch, not as navigation.
  const hasRenderedSectionRef = useRef(false);
  useEffect(() => {
    hasRenderedSectionRef.current = true;
  }, []);

  const layerRef = useRef<HTMLDivElement>(null);
  // `clip-path` clips *every* descendant, `position: fixed` ones included — so the
  // finished `inset(0 0 0 0)` must not be left behind on the wrapper, or the save
  // bar / upload dock / PDF chrome would stay clipped to the outlet box forever.
  const dropFinishedClip = useCallback(() => {
    if (layerRef.current) layerRef.current.style.clipPath = '';
  }, []);

  if (reduceMotion)
    return (
      <div className={styles.layer} data-route-key={transitionKey} key={transitionKey}>
        {children}
      </div>
    );

  const shouldAnimate = hasRenderedSectionRef.current;
  // No direction to show (unknown section, or `/image` ↔ `/video`, which share one
  // sidebar) ⇒ plain fade, and no clip is written at all.
  const revealFrom =
    shouldAnimate && directionRef.current !== 0
      ? getRevealClipPath(directionRef.current, getInlineSign())
      : null;

  return (
    <m.div
      animate={revealFrom ? { clipPath: FULL_CLIP_PATH, opacity: 1 } : { opacity: 1 }}
      className={styles.layer}
      data-route-key={transitionKey}
      initial={shouldAnimate ? { ...(revealFrom && { clipPath: revealFrom }), opacity: 0 } : false}
      key={transitionKey}
      ref={layerRef}
      transition={{ duration: SECTION_TRANSITION_S, ease: SECTION_TRANSITION_EASE }}
      onAnimationComplete={dropFinishedClip}
    >
      {children}
    </m.div>
  );
});

RouteTransition.displayName = 'RouteTransition';

export default RouteTransition;
