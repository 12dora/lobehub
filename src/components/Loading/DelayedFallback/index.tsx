'use client';

import { type ReactNode, useEffect, useState } from 'react';

/**
 * Default grace period before a loading indicator is allowed on screen.
 *
 * Route chunks almost always land well inside this window on a warm connection,
 * so the spinner never paints and a first click reads as instant instead of as
 * a flash of "loading…".
 */
export const DEFAULT_FALLBACK_DELAY_MS = 200;

export interface DelayedFallbackProps {
  /** The loading UI. Rendered only once `delayMs` has elapsed. */
  children: ReactNode;
  /** Grace period in ms. `0` (or less) renders immediately. */
  delayMs?: number;
}

/**
 * Renders nothing for `delayMs`, then its children.
 *
 * Use it to wrap Suspense fallbacks: work that finishes inside the grace period
 * shows no loader at all, while genuinely slow work still gets feedback.
 *
 * ## Deliberate omissions
 *
 * - **No minimum visible time.** A Suspense fallback is unmounted by React the
 *   moment the boundary resolves; it cannot keep itself on screen past that, so
 *   a `minVisibleMs` prop here could only ever be decorative. Anti-flicker of
 *   that kind has to be implemented around the *content*, not the fallback.
 * - **`prefers-reduced-motion` is not consulted.** The delay is not an
 *   animation — nothing moves, transitions or fades — it only decides whether a
 *   loader is mounted. Reduced motion is handled by the loader components
 *   themselves.
 */
const DelayedFallback = ({
  children,
  delayMs = DEFAULT_FALLBACK_DELAY_MS,
}: DelayedFallbackProps) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (delayMs <= 0) {
      setVisible(true);
      return;
    }

    setVisible(false);
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  if (!visible) return null;

  return <>{children}</>;
};

DelayedFallback.displayName = 'DelayedFallback';

export default DelayedFallback;
