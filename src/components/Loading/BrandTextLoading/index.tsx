import { isCustomBranding } from '@/const/version';

import BootBrandMark from '../BootBrandMark';
import { readPublishedBootBrand } from '../BootBrandMark/bootBranding';
import CircleLoading from '../CircleLoading';
import styles from './index.module.css';

/**
 * - `fullscreen` (default): the boot splash — fills the viewport (`100dvh`) and
 *   shows the brand mark. Only for the true app-boot path.
 * - `inline`: fills its container instead of the viewport and drops the brand
 *   mark. Use it for in-app route / Suspense fallbacks so a client-side
 *   navigation does not read as a full page reload.
 */
export type BrandTextLoadingVariant = 'fullscreen' | 'inline';

interface BrandTextLoadingProps {
  debugId: string;
  variant?: BrandTextLoadingVariant;
}

const BrandTextLoading = ({ debugId, variant = 'fullscreen' }: BrandTextLoadingProps) => {
  const isInline = variant === 'inline';
  const containerClassName = isInline ? `${styles.container} ${styles.inline}` : styles.container;

  /**
   * The build-time flag must not shadow a brand the operator published at runtime: the server
   * renders that brand into the static `#loading-screen` regardless of the flag, so dropping to
   * the spinner here would swap the brand out the moment React mounts.
   */
  if (isCustomBranding && !readPublishedBootBrand())
    return (
      <div className={containerClassName}>
        <CircleLoading />
      </div>
    );

  const showDebug = process.env.NODE_ENV === 'development' && debugId;

  return (
    <div className={containerClassName}>
      {isInline ? <CircleLoading /> : <BootBrandMark aria-label="Loading" role="status" />}
      {showDebug && (
        <div className={styles.debug}>
          <div className={styles.debugRow}>
            <code>Debug ID:</code>
            <span className={styles.debugTag}>
              <code>{debugId}</code>
            </span>
          </div>
          <div className={styles.debugHint}>only visible in development</div>
        </div>
      )}
    </div>
  );
};

export default BrandTextLoading;
