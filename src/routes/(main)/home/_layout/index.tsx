import { Flexbox } from '@lobehub/ui';
import { cx, useTheme } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { Activity, type FC, type ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { useIsDark } from '@/hooks/useIsDark';

import HomeAgentIdSync from './HomeAgentIdSync';
import RecentHydration from './RecentHydration';
import Sidebar from './Sidebar';
import { HOME_FADE_MS, styles } from './style';

interface LayoutProps {
  children?: ReactNode;
}

/**
 * React's `<Activity mode="hidden">` does not merely pause the subtree: `hideInstance`
 * sets `display: none !important` on the host child (react-dom 19.2). That kills any
 * CSS opacity transition on this container — the overlay would snap away on exit and
 * snap back on entry.
 *
 * So the *structural* hide (Activity) is decoupled from the *visual* hide (opacity):
 *
 * - Leaving home: the class flips to `hidden` during the same render (fade starts
 *   immediately) while Activity stays `visible`; Activity only flips to `hidden` once
 *   the fade has finished. Throughout that window the overlay is `aria-hidden` + `inert`
 *   + `pointer-events: none`, so it never covers or steals input from the outlet.
 * - Entering home: Activity is un-hidden in a layout effect (before paint) while the
 *   overlay is still transparent, and the opacity flips on the next frame so the
 *   transition has a starting frame to animate from.
 * - Reduced motion: both flips happen immediately, no timers, no frame deferral.
 */
const Layout: FC<LayoutProps> = ({ children }) => {
  const isDarkMode = useIsDark();
  const theme = useTheme(); // Keep for colorBgContainerSecondary (not in cssVar)
  const { pathname } = useLocation();
  const activeSlug = useActiveWorkspaceSlug();
  const reduceMotion = useReducedMotion();
  const isHomeRoute =
    pathname === '/' ||
    (!!activeSlug && (pathname === `/${activeSlug}` || pathname === `/${activeSlug}/`));
  const [hasActivated, setHasActivated] = useState(isHomeRoute);
  /** Structural hide — lags `isHomeRoute` by the exit fade. */
  const [activityHidden, setActivityHidden] = useState(!isHomeRoute);
  /** Entry gate — flipped one frame after the subtree is un-hidden. */
  const [enterReady, setEnterReady] = useState(isHomeRoute);
  const content = children ?? <Outlet />;

  useEffect(() => {
    if (isHomeRoute) setHasActivated(true);
  }, [isHomeRoute]);

  // Un-hide before paint so the fade-in has a transparent starting frame.
  useLayoutEffect(() => {
    if (isHomeRoute) setActivityHidden(false);
  }, [isHomeRoute]);

  useEffect(() => {
    if (isHomeRoute) {
      if (reduceMotion) {
        setEnterReady(true);
        return;
      }
      const frame = requestAnimationFrame(() => setEnterReady(true));
      return () => cancelAnimationFrame(frame);
    }

    // Reset the entry gate so the next visit fades in again.
    setEnterReady(false);

    if (reduceMotion) {
      setActivityHidden(true);
      return;
    }
    const timer = setTimeout(() => setActivityHidden(true), HOME_FADE_MS);
    return () => clearTimeout(timer);
  }, [isHomeRoute, reduceMotion]);

  // CSS variable for dynamic background color (colorBgContainerSecondary is not in cssVar)
  const cssVariables = useMemo<Record<string, string>>(
    () => ({
      '--content-bg-secondary': theme.colorBgContainerSecondary,
    }),
    [theme.colorBgContainerSecondary],
  );

  if (!hasActivated) return null;

  const isOpaque = isHomeRoute && enterReady;

  // Keep the Home layout alive and render it offscreen when inactive.
  return (
    <Activity mode={activityHidden ? 'hidden' : 'visible'} name="DesktopHomeLayout">
      {/* `position: absolute; inset: 0` keeps this overlaying the outlet, so while it is
        fading out it must already be non-interactive and hidden from assistive tech. */}
      <Flexbox
        aria-hidden={!isHomeRoute}
        className={cx(styles.absoluteContainer, isOpaque ? styles.visible : styles.hidden)}
        data-home-state={isOpaque ? 'visible' : 'hidden'}
        data-testid="home-overlay"
        height={'100%'}
        inert={!isHomeRoute}
        width={'100%'}
      >
        <Sidebar />
        <Flexbox
          className={isDarkMode ? styles.contentDark : styles.contentLight}
          flex={1}
          height={'100%'}
          style={cssVariables}
        >
          {content}
        </Flexbox>

        <HomeAgentIdSync />
        <RecentHydration />
      </Flexbox>
    </Activity>
  );
};

export default Layout;
