'use client';

import { Text } from '@lobehub/ui';
import { type CSSProperties, Fragment, memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';

import { resolveAuthFooterLinks } from './resolveAuthFooterLinks';

const linkStyle: CSSProperties = {
  color: 'inherit',
  cursor: 'pointer',
};

const AuthFooterLinks = memo(() => {
  const { t } = useTranslation('auth');
  const branding = useBranding();
  const links = resolveAuthFooterLinks(branding);

  return (
    <Text align={'center'} fontSize={13} type={'secondary'}>
      {links.map((link, index) => (
        <Fragment key={link.labelKey}>
          {index > 0 && <span style={{ marginInline: 8 }}>·</span>}
          <a href={link.href} style={linkStyle}>
            {t(link.labelKey)}
          </a>
        </Fragment>
      ))}
    </Text>
  );
});

export default AuthFooterLinks;
