'use client';

import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, type ReactNode } from 'react';

interface OverviewCardStateProps {
  children: ReactNode;
  /** Semantic state key — animate only when this changes (loading/empty/data/error). */
  stateKey: string;
}

/**
 * Opacity-only crossfade between overview card states.
 * Preserves fixed card height via the parent; does not animate chart geometry.
 */
const OverviewCardState = memo<OverviewCardStateProps>(({ children, stateKey }) => {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <>{children}</>;
  }

  return (
    <AnimatePresence initial={false} mode="wait">
      <m.div
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        initial={{ opacity: 0 }}
        key={stateKey}
        transition={{ duration: 0.14 }}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
});

OverviewCardState.displayName = 'AdminOverviewCardState';

export default OverviewCardState;
