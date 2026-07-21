'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { identityProviderStyles as styles } from './styles';

/**
 * Single empty state when Database OIDC is disabled or deploy secrets/APP_URL are missing.
 */
const IdentityProviderSetupGuidance = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.panel} data-testid="identity-provider-setup-guidance">
      <Flexbox gap={10}>
        <Text strong style={{ fontSize: 16 }}>
          {t('identityProviders.setup.title')}
        </Text>
        <Text type="secondary">{t('identityProviders.setup.description')}</Text>
        <ul className={styles.setupList}>
          <li>
            <Text>
              <Text code>ENABLE_DATABASE_OIDC=1</Text>
              {' — '}
              {t('identityProviders.setup.flag')}
            </Text>
          </li>
          <li>
            <Text>
              <Text code>PLATFORM_MASTER_KEY</Text>
              {' — '}
              {t('identityProviders.setup.masterKey')}
            </Text>
            <br />
            <Text type="secondary">
              {t('identityProviders.setup.masterKeyHint')} <Text code>openssl rand -base64 32</Text>
            </Text>
          </li>
          <li>
            <Text>
              <Text code>APP_URL</Text>
              {' — '}
              {t('identityProviders.setup.appUrl')}
            </Text>
          </li>
        </ul>
        <Text type="secondary">{t('identityProviders.setup.restart')}</Text>
      </Flexbox>
    </div>
  );
});

IdentityProviderSetupGuidance.displayName = 'IdentityProviderSetupGuidance';
export default IdentityProviderSetupGuidance;
