import { BrandLoading, LobeHubText } from '@lobehub/ui/brand';

import { isCustomBranding } from '@/const/version';

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

  if (isCustomBranding)
    return (
      <div className={containerClassName}>
        <CircleLoading />
      </div>
    );

  const showDebug = process.env.NODE_ENV === 'development' && debugId;

  return (
    <div className={containerClassName}>
      {isInline ? (
        <CircleLoading />
      ) : (
        <div aria-label="Loading" className={styles.brand} role="status">
          <BrandLoading size={40} text={LobeHubText} />
        </div>
      )}
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
