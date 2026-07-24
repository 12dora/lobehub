'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAiProviderDraft } from '../types';

const styles = createStaticStyles(({ css }) => ({
  secret: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));

export interface ProviderSecretPanelProps {
  canUpdate: boolean;
  disabled?: boolean;
  onApply?: () => void;
  secret: AdminAiProviderDraft['secret'];
}

const ProviderSecretPanel = memo<ProviderSecretPanelProps>(
  ({ canUpdate, disabled, onApply, secret }) => {
    const { t } = useTranslation('admin');

    return (
      <section className={styles.secret}>
        <Flexbox gap={4}>
          <Flexbox horizontal align="center" gap={8}>
            <Text strong>{t('aiCatalog.editor.secret.title')}</Text>
            <Tag color={secret.configured ? 'success' : 'warning'}>
              {t(
                secret.configured
                  ? 'aiCatalog.providers.secret.configured'
                  : 'aiCatalog.providers.secret.missing',
              )}
            </Tag>
          </Flexbox>
          <Text type="secondary">{t('aiCatalog.editor.secret.neverReveal')}</Text>
        </Flexbox>
        {canUpdate ? (
          <Button disabled={disabled} onClick={onApply}>
            {t('aiCatalog.secret.apply')}
          </Button>
        ) : null}
      </section>
    );
  },
);

ProviderSecretPanel.displayName = 'AdminAiProviderSecretPanel';

export default ProviderSecretPanel;
