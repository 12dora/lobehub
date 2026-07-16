'use client';

import { Alert, Center, Flexbox, FluentEmoji, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { ManagedResourceKind } from '@/const/platform/managedResources';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    flex: 1;
    min-height: 320px;
    padding: 32px;
  `,
  surface: css`
    width: min(520px, 100%);
    padding: 24px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));

export interface ManagedResourceNoticeProps {
  inline?: boolean;
  resource: ManagedResourceKind;
}

export const ManagedResourceNotice = memo<ManagedResourceNoticeProps>(({ resource, inline }) => {
  const { t } = useTranslation('setting');
  const navigate = useNavigate();
  const resourceName = t(`managedResources.resource.${resource}` as never);

  if (inline) {
    return (
      <Alert
        showIcon
        message={t('managedResources.inline.title', { resource: resourceName })}
        description={t('managedResources.inline.connectorDesc')}
        type="info"
      />
    );
  }

  return (
    <Center className={styles.root}>
      <Flexbox align="center" className={styles.surface} gap={16}>
        <FluentEmoji emoji="🏢" size={48} />
        <Flexbox align="center" gap={8}>
          <Text as="h1" style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
            {t('managedResources.notice.title', { resource: resourceName })}
          </Text>
          <Text align="center" type="secondary">
            {t('managedResources.notice.desc')}
          </Text>
        </Flexbox>
        <Flexbox horizontal gap={8}>
          <Button type="primary" onClick={() => navigate('/')}>
            {t('managedResources.notice.back')}
          </Button>
          <Button onClick={() => navigate('/community')}>
            {t('managedResources.notice.browse')}
          </Button>
        </Flexbox>
      </Flexbox>
    </Center>
  );
});

ManagedResourceNotice.displayName = 'ManagedResourceNotice';
