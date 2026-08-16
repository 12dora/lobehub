'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { DingTalk } from '@lobehub/ui/icons';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { IdentityProviderCreateTemplateId } from './controller';
import { identityProviderStyles as styles } from './styles';

interface IdentityProviderTypePickerProps {
  /** Drop the card chrome when hosted inside a modal (which already frames content). */
  embedded?: boolean;
  onSelect: (type: IdentityProviderCreateTemplateId) => void;
}

const IdentityProviderTypePicker = memo<IdentityProviderTypePickerProps>(
  ({ embedded, onSelect }) => {
    const { t } = useTranslation('admin');

    return (
      <div
        className={embedded ? styles.stack : styles.panel}
        data-testid="identity-provider-type-picker"
      >
        <Flexbox gap={6}>
          <Text strong>{t('identityProviders.templates.title')}</Text>
          <Text type="secondary">{t('identityProviders.templates.description')}</Text>
        </Flexbox>
        <div className={styles.templateGrid}>
          <button
            className={styles.templateCard}
            type="button"
            onClick={() => onSelect('authentik')}
          >
            <Flexbox horizontal align="center" gap={8}>
              <Text strong>Authentik</Text>
              <Tag color="blue">OIDC</Tag>
            </Flexbox>
            <Text type="secondary">{t('identityProviders.templates.authentik.description')}</Text>
          </button>
          <button
            className={styles.templateCard}
            type="button"
            onClick={() => onSelect('dingtalk')}
          >
            <Flexbox horizontal align="center" gap={8}>
              <DingTalk.Color size={18} />
              <Text strong>{t('identityProviders.templates.dingtalk.label')}</Text>
              <Tag color="blue">OAuth 2.0</Tag>
            </Flexbox>
            <Text type="secondary">{t('identityProviders.templates.dingtalk.description')}</Text>
          </button>
          <button
            className={styles.templateCard}
            type="button"
            onClick={() => onSelect('generic_oidc')}
          >
            <Flexbox horizontal align="center" gap={8}>
              <Text strong>{t('identityProviders.templates.genericOidc.label')}</Text>
              <Tag>OIDC</Tag>
            </Flexbox>
            <Text type="secondary">{t('identityProviders.templates.genericOidc.description')}</Text>
          </button>
        </div>
      </div>
    );
  },
);

IdentityProviderTypePicker.displayName = 'IdentityProviderTypePicker';
export default IdentityProviderTypePicker;
