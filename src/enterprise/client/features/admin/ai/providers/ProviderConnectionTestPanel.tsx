'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';

import type { AiProviderConnectionTestView } from '../controller';

const styles = createStaticStyles(({ css }) => ({
  testResult: css`
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
}));

export interface ProviderConnectionTestPanelProps {
  connectionTest: AiProviderConnectionTestView;
}

const ProviderConnectionTestPanel = memo<ProviderConnectionTestPanelProps>(({ connectionTest }) => {
  const { t } = useTranslation('admin');

  return (
    <section aria-live="polite" className={styles.testResult}>
      {connectionTest.state ? (
        <Flexbox gap={4}>
          <Flexbox horizontal align="center" gap={8}>
            <Text strong>{t(`aiCatalog.editor.test.${connectionTest.state.status}` as never)}</Text>
            {connectionTest.stale ? (
              <Tag color="warning">{t('aiCatalog.editor.test.stale')}</Tag>
            ) : null}
          </Flexbox>
          <Text type="secondary">
            {t('aiCatalog.editor.test.summary', {
              latency: connectionTest.state.latencyMs ?? '—',
              message: connectionTest.state.sanitizedMessage,
            })}
          </Text>
          <Text type="secondary">
            {t('aiCatalog.editor.test.testedAt', {
              time: formatAdminDateTime(connectionTest.state.testedAt),
            })}
          </Text>
        </Flexbox>
      ) : (
        <Text type="secondary">{t('aiCatalog.editor.test.notRun')}</Text>
      )}
    </section>
  );
});

ProviderConnectionTestPanel.displayName = 'AdminAiProviderConnectionTestPanel';

export default ProviderConnectionTestPanel;
