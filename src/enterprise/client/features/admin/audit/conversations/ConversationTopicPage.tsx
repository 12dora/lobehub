'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useProviderLabel } from '@/utils/modelLabels';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import { formatAdminDateTime, hasPermission } from '../shared/format';
import { formatTopicModelLine } from '../shared/topicModelLine';
import ContentAccessDisabledState from './ContentAccessDisabledState';
import TopicAccessBanner from './TopicAccessBanner';
import TopicMessagePager from './TopicMessagePager';
import TopicMessageStream from './TopicMessageStream';
import { useTopicEvidence } from './useTopicEvidence';

const ConversationTopicPage = memo(() => {
  const { t } = useTranslation('admin');
  const providerLabel = useProviderLabel();
  const navigate = useNavigate();
  const { userId = '', topicId = '' } = useParams<{ userId: string; topicId: string }>();
  const { permissions } = useAdminAccess();
  const canConversationRead = hasPermission(
    permissions,
    PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ,
  );
  // policy.get requires AUDIT_READ — optional; conversation evidence may still be available.
  const canAuditRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const { contentAccessMode, detail, includeBody, isForbidden, messages, onToggleBody, pager } =
    useTopicEvidence({ canAuditRead, canConversationRead, t, topicId, userId });

  if (isForbidden || contentAccessMode === 'disabled') {
    return <ContentAccessDisabledState />;
  }

  const topic = detail.topic;
  const pageTitle = topic?.title || t('audit.conversations.topic.title');

  return (
    <AdminPageTemplate
      description={t('audit.conversations.topic.desc')}
      title={pageTitle}
      actions={
        <Flexbox horizontal gap={8}>
          <Button
            type="default"
            onClick={() =>
              navigate(
                `/admin/audit/live?userId=${encodeURIComponent(userId)}&topicId=${encodeURIComponent(topicId)}`,
              )
            }
          >
            {t('audit.conversations.topic.openLive')}
          </Button>
          <Button type="default" onClick={() => navigate(`/admin/audit/conversations/${userId}`)}>
            {t('audit.conversations.topic.back')}
          </Button>
        </Flexbox>
      }
      banner={
        <TopicAccessBanner
          contentAccessMode={contentAccessMode}
          includeBody={includeBody}
          onToggleBody={onToggleBody}
        />
      }
    >
      {detail.failed ? (
        <Alert
          showIcon
          message={t('audit.conversations.topic.detailUnavailable')}
          style={{ marginBlockEnd: 12 }}
          type="warning"
          action={
            <Button size="small" onClick={detail.retry}>
              {t('audit.shared.retryMissingSections')}
            </Button>
          }
        />
      ) : null}
      {topic ? (
        <Flexbox gap={8} style={{ marginBlockEnd: 12 }}>
          <Text type="secondary">{formatTopicModelLine(providerLabel, topic)}</Text>
          <Text type="secondary">
            {t('audit.conversations.columns.updatedAt')}: {formatAdminDateTime(topic.updatedAt)}
          </Text>
        </Flexbox>
      ) : null}

      <TopicMessageStream feed={messages} />

      <TopicMessagePager pager={pager} />
    </AdminPageTemplate>
  );
});

ConversationTopicPage.displayName = 'AuditConversationTopicPage';

export default ConversationTopicPage;
