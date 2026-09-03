import type { CSSProperties } from 'react';

import { isCustomBranding } from '@/const/version';

import BootBrandMark from '../BootBrandMark';
import { readPublishedBootBrand } from '../BootBrandMark/bootBranding';
import styles from './index.module.css';

const BOOT_BG_VAR = '--lobe-boot-bg';

const isOpaque = (color: string) =>
  !!color &&
  color !== 'transparent' &&
  !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/.test(color);

/**
 * Host shells paint different boot backgrounds (`#f8f8f8`/`#000` on the web and
 * auth shells, `#fafafa`/`#141414` in the desktop popup) and they set it on
 * different elements (`body` vs `html`). Hard-coding one pair flashes the wrong
 * colour for a frame or two on the others.
 *
 * Preference order:
 * 1. a `--lobe-boot-bg` declared by the shell — left to CSS, nothing inlined;
 * 2. the shell's own painted background, probed once at boot;
 * 3. the web-shell literals baked into the stylesheet.
 */
const resolveBootBackground = (): string | null => {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return null;

  const root = document.documentElement;
  const declared = getComputedStyle(root).getPropertyValue(BOOT_BG_VAR).trim();
  // The shell owns the value — do not shadow it with an inline override.
  if (declared) return null;

  for (const element of [document.body, root]) {
    if (!element) continue;
    const background = getComputedStyle(element).backgroundColor;
    if (isOpaque(background)) return background;
  }

  return null;
};

let cachedBootBackground: string | null | undefined;

const getBootBackground = () => {
  if (cachedBootBackground === undefined) cachedBootBackground = resolveBootBackground();
  return cachedBootBackground;
};

/**
 * Root-level, viewport-fixed boot splash.
 *
 * Mounted at the router root — above the app shell and *outside* every provider
 * — so it stays whole while the initial route tree is still resolving. A route
 * Suspense fallback cannot do this job: once the main layout chunk lands, the
 * fallback for the still-loading leaf renders inside the layout container, so a
 * "fullscreen" loader there is clipped to the outlet with the app chrome
 * already showing around it.
 *
 * Because it renders outside `SPAGlobalProvider` it must not depend on i18n,
 * antd theming or the Zustand stores.
 */
const BootSplashOverlay = () => {
  const background = getBootBackground();
  /**
   * The build-time flag must not shadow a brand the operator published at runtime: the server
   * renders that brand into the static `#loading-screen` regardless of the flag, so dropping to
   * the spinner here would swap the brand out the moment React mounts.
   */
  const showSpinner = isCustomBranding && !readPublishedBootBrand();

  return (
    <div
      aria-label="Loading"
      className={styles.overlay}
      role="status"
      style={background ? ({ [BOOT_BG_VAR]: background } as CSSProperties) : undefined}
    >
      {showSpinner ? <div className={styles.spinner} /> : <BootBrandMark />}
    </div>
  );
};

export default BootSplashOverlay;
