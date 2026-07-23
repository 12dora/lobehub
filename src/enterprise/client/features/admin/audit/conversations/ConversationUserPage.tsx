'use client';

import { Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';

/** Placeholder until the dedicated batch lands. */
const ConversationUserPage = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <AdminPageTemplate title={t('nav.audit')}>
      <Text type="secondary">{t('audit.redirecting')}</Text>
    </AdminPageTemplate>
  );
});

ConversationUserPage.displayName = 'AuditConversationUserPage';

export default ConversationUserPage;
