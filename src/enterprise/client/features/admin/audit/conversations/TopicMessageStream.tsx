'use client';

import { Flexbox, Skeleton, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useReducedMotion } from 'motion/react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditConversationMessage } from '@/enterprise/client/services/adminAudit';

import { formatAdminDateTime } from '../shared/format';
import { styles } from './topicPageStyles';
import type { TopicEvidence } from './useTopicEvidence';

/** Keeps server-applied `[REDACTED …]` markers visually distinct from the auditor's own reading. */
const renderBody = (content: string) => {
  const parts = content.split(/(\[REDACTED[^\]]*\])/g);
  return parts.map((part, i) =>
    part.startsWith('[REDACTED') ? (
      <span className={styles.redacted} key={i}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
};

export interface TopicMessageStreamProps {
  feed: TopicEvidence['messages'];
}

/** One page of conversation evidence, with its own loading / failure / empty states. */
const TopicMessageStream = memo<TopicMessageStreamProps>(({ feed }) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();

  return (
    <div className={styles.stream}>
      {feed.isLoading && !feed.hasData ? (
        <div aria-label={t('primitives.dataTable.loading')} role="status">
          <Skeleton active={!reduceMotion} paragraph={{ rows: 5 }} title={false} />
        </div>
      ) : null}
      {feed.items.map((msg: AdminAuditConversationMessage) => (
        <div className={styles.message} key={msg.id}>
          <Flexbox horizontal align="center" gap={8}>
            <Tag size="small">{msg.role}</Tag>
            <Text style={{ fontSize: 12 }} type="secondary">
              {formatAdminDateTime(msg.createdAt)}
            </Text>
          </Flexbox>
          {msg.content != null && msg.content !== '' ? (
            <div className={styles.body}>{renderBody(msg.content)}</div>
          ) : msg.hasContent ? (
            <Text type="secondary">{t('audit.conversations.topic.bodyNotLoaded')}</Text>
          ) : (
            <Text type="secondary">—</Text>
          )}
        </div>
      ))}
      {feed.hasError && !feed.hasData ? (
        <Flexbox align="flex-start" gap={8}>
          <Text role="alert" type="danger">
            {t('audit.conversations.topic.loadError')}
          </Text>
          <Button size="small" type="default" onClick={feed.retry}>
            {t('primitives.dataTable.retry')}
          </Button>
        </Flexbox>
      ) : null}
      {!feed.items.length && !feed.isLoading && !feed.hasError ? (
        <Text type="secondary">{t('audit.conversations.topic.emptyMessages')}</Text>
      ) : null}
    </div>
  );
});

TopicMessageStream.displayName = 'AuditTopicMessageStream';

export default TopicMessageStream;
