'use client';

import { type LobeHubProps } from '@lobehub/ui/brand';
import { LobeHub } from '@lobehub/ui/brand';
import { memo } from 'react';

import { isCustomBranding } from '@/const/version';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';

import CustomLogo from './Custom';

interface ProductLogoProps extends LobeHubProps {
  height?: number;
  width?: number;
}

export const ProductLogo = memo<ProductLogoProps>((props) => {
  const branding = useBranding();

  if (isCustomBranding || branding.publishedRevision) {
    return <CustomLogo logoUrl={branding.logoUrl} name={branding.name} {...props} />;
  }

  return <LobeHub {...props} />;
});
