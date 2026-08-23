'use client';

import { Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { AdminAuditConversationDetail } from '@/enterprise/client/services/adminAudit';
import { useProviderLabel } from '@/utils/modelLabels';

import { formatAdminDateTime } from '../shared/format';
import { formatTopicModelLine } from '../shared/topicModelLine';
import { styles } from './messagePaneStyles';

export interface MessagePaneHeaderProps {
  topic: AdminAuditConversationDetail;
  userId: string;
}

/** Topic identity above the live stream, with the deep link to its durable evidence page. */
const MessagePaneHeader = memo<MessagePaneHeaderProps>(({ topic, userId }) => {
  const { t } = useTranslation('admin');
  const providerLabel = useProviderLabel();

  return (
    <div className={styles.header}>
      <div>
        <Text style={{ fontWeight: 600, margin: 0 }}>
          {topic.title || t('audit.conversations.untitled')}
        </Text>
        <Text style={{ display: 'block', fontSize: 12 }} type="secondary">
          {formatTopicModelLine(providerLabel, topic)}
          {' · '}
          {formatAdminDateTime(topic.createdAt)}
        </Text>
      </div>
      <Link to={`/admin/audit/conversations/${userId}/topics/${topic.id}`}>
        {t('audit.live.messages.openEvidence')}
      </Link>
    </div>
  );
});

MessagePaneHeader.displayName = 'AuditLiveMessagePaneHeader';

export default MessagePaneHeader;
