'use client';

import { Text } from '@lobehub/ui';
import { type CSSProperties, memo } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { PRIVACY_URL, TERMS_URL } from '@/const/url';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';

const linkStyle: CSSProperties = {
  color: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
};

const AuthAgreement = memo(() => {
  const branding = useBranding();
  const { t } = useTranslation('auth');
  return (
    <Text fontSize={13} style={{ display: 'block', marginBlockStart: 8 }} type={'secondary'}>
      <Trans
        i18nKey={'footer.agreement'}
        ns={'auth'}
        components={{
          privacy: (
            <a href={branding.privacyUrl ?? PRIVACY_URL} style={linkStyle}>
              {t('footer.privacy')}
            </a>
          ),
          terms: (
            <a href={branding.termsUrl ?? TERMS_URL} style={linkStyle}>
              {t('footer.terms')}
            </a>
          ),
        }}
      />
    </Text>
  );
});

export default AuthAgreement;
