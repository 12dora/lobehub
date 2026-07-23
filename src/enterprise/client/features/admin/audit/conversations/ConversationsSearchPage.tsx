'use client';

import { Empty, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditUserSearchItem } from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';
import { displayAuditUserLabel, formatAdminDateTime, hasPermission } from '../shared/format';

const styles = createStaticStyles(({ css }) => ({
  hero: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;

    max-width: 560px;
    margin-block: 48px;
    margin-inline: auto;
    padding-block: 32px;
    padding-inline: 24px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    text-align: center;

    background: ${cssVar.colorBgContainer};
  `,
  search: css`
    width: 100%;
  `,
}));

const ConversationsSearchPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { permissions } = useAdminAccess();
  const canRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ);
  const [picked, setPicked] = useState<AdminAuditUserSearchItem | undefined>();

  const onSelect = useCallback(
    (userId: string | undefined, user?: AdminAuditUserSearchItem) => {
      setPicked(user);
      if (userId) navigate(`/admin/audit/conversations/${userId}`);
    },
    [navigate],
  );

  if (!canRead) {
    return (
      <AdminPageTemplate title={t('audit.conversations.page.title')}>
        <Empty description={t('audit.noPermission')} />
      </AdminPageTemplate>
    );
  }

  return (
    <AdminPageTemplate
      description={t('audit.conversations.page.desc')}
      title={t('audit.conversations.page.title')}
    >
      <div className={styles.hero}>
        <Text as="h2" style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          {t('audit.conversations.search.heading')}
        </Text>
        <Text type="secondary">{t('audit.conversations.search.hint')}</Text>
        <div className={styles.search}>
          <AuditUserSearchSelect
            enabled={canRead}
            placeholder={t('audit.conversations.search.placeholder')}
            style={{ width: '100%' }}
            value={picked?.id}
            valueLabel={picked ? displayAuditUserLabel(picked) : undefined}
            onChange={onSelect}
          />
        </div>
        {picked ? (
          <Text type="secondary">
            {displayAuditUserLabel(picked)}
            {picked.lastActiveAt
              ? ` · ${t('audit.conversations.search.lastActive')}: ${formatAdminDateTime(picked.lastActiveAt)}`
              : ''}
          </Text>
        ) : null}
        <Text style={{ fontSize: 12 }} type="secondary">
          {t('audit.conversations.search.policyNote')}
        </Text>
      </div>
    </AdminPageTemplate>
  );
});

ConversationsSearchPage.displayName = 'AuditConversationsSearchPage';

export default ConversationsSearchPage;
