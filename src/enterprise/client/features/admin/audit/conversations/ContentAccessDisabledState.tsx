'use client';

import { Empty, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';

const ContentAccessDisabledState = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();

  return (
    <AdminPageTemplate title={t('audit.conversations.page.title')}>
      <Empty
        style={{ paddingBlock: 64 }}
        description={
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <Text>{t('audit.conversations.disabled.title')}</Text>
            <div style={{ marginBlockStart: 8 }}>
              <Text type="secondary">{t('audit.conversations.disabled.desc')}</Text>
            </div>
            <div style={{ marginBlockStart: 16 }}>
              <Button type="primary" onClick={() => navigate('/admin/audit/retention')}>
                {t('audit.conversations.disabled.goRetention')}
              </Button>
            </div>
          </div>
        }
      />
    </AdminPageTemplate>
  );
});

ContentAccessDisabledState.displayName = 'AuditContentAccessDisabledState';

export default ContentAccessDisabledState;
