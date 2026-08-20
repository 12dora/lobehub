import { BrandLoading, LobeHubText } from '@lobehub/ui/brand';

import { isCustomBranding } from '@/const/version';

import styles from './index.module.css';

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
const BootSplashOverlay = () => (
  <div aria-label="Loading" className={styles.overlay} role="status">
    {isCustomBranding ? (
      <div className={styles.spinner} />
    ) : (
      <div className={styles.brand}>
        <BrandLoading size={40} text={LobeHubText} />
      </div>
    )}
  </div>
);

export default BootSplashOverlay;
