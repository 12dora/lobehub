'use client';

import { ORG_NAME, UTM_SOURCE } from '@lobechat/business-const';
import { type FlexboxProps } from '@lobehub/ui';
import { Flexbox } from '@lobehub/ui';
import { LobeHub } from '@lobehub/ui/brand';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';

import { ProductLogo } from '@/components/Branding/ProductLogo';
import { isCustomORG } from '@/const/version';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';

const styles = createStaticStyles(({ css, cssVar }) => ({
  logoLink: css`
    line-height: 1;
    color: inherit;

    &:hover {
      color: ${cssVar.colorLink};
    }
  `,
}));

const BrandWatermark = memo<Omit<FlexboxProps, 'children'>>(({ style, ...rest }) => {
  const { publishedRevision } = useBranding();

  const renderMark = () => {
    // A published brand owns this surface: show its own wordmark, never the
    // compile-time organisation or LobeHub's.
    if (publishedRevision) return <ProductLogo size={20} type={'text'} />;

    if (isCustomORG) return <span>{ORG_NAME}</span>;

    return (
      <a
        className={styles.logoLink}
        href={`https://lobehub.com?utm_source=${UTM_SOURCE}&utm_content=brand_watermark`}
        rel="noreferrer"
        target="_blank"
      >
        <LobeHub size={20} type={'text'} />
      </a>
    );
  };

  return (
    <Flexbox
      horizontal
      align={'center'}
      dir={'ltr'}
      flex={'none'}
      gap={4}
      style={{ color: cssVar.colorTextDescription, fontSize: 12, ...style }}
      {...rest}
    >
      <span>Powered by</span>
      {renderMark()}
    </Flexbox>
  );
});

export default BrandWatermark;
