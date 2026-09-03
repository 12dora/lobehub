import { BrandLoading, LobeHubText } from '@lobehub/ui/brand';
import type { ComponentPropsWithoutRef } from 'react';

import { readPublishedBootBrand } from './bootBranding';
import styles from './index.module.css';

/**
 * The brand mark of the boot splash, shared by the root overlay and the fullscreen
 * `BrandTextLoading`.
 *
 * It continues the mark the server already rendered into the static `#loading-screen`
 * (`src/server/loadingBrand.ts`): the published logo, the published brand name, or — when no
 * brand is published — the built-in LobeHub wordmark. Both splashes must therefore agree on the
 * rendering rule, the sizing and the animation, or the handoff to React flashes another brand.
 *
 * It renders outside every provider, so it must not depend on i18n, antd theming or the Zustand
 * stores: the brand comes straight from the synchronously injected server snapshot.
 */
const BootBrandMark = ({
  className,
  ...rest
}: Omit<ComponentPropsWithoutRef<'div'>, 'children'>) => {
  const brand = readPublishedBootBrand();
  const classNames = [styles.mark, brand ? undefined : styles.wordmark, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames} {...rest}>
      {!brand && <BrandLoading size={40} text={LobeHubText} />}
      {brand?.logoSrc && <img alt="" className={styles.logo} src={brand.logoSrc} />}
      {brand && !brand.logoSrc && <div className={styles.name}>{brand.name}</div>}
    </div>
  );
};

export default BootBrandMark;
