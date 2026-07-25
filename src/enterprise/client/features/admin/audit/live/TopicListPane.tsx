'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditConversationListItem } from '@/enterprise/client/services/adminAudit';

import { formatAdminDateTime } from '../shared/format';
import { relativeTimeMs } from '../shared/liveMessageUtils';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;

    height: 100%;
    padding: 8px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};
  `,
  item: css`
    cursor: pointer;

    padding-block: 10px;
    padding-inline: 10px;
    border: 1px solid transparent;
    border-radius: ${cssVar.borderRadius};

    transition: background 0.12s ease;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }

    &[data-active='true'] {
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorPrimaryBg};
    }
  `,
  title: css`
    margin: 0;
    font-weight: 600;
  `,
  meta: css`
    margin: 0;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

const formatRelative = (value: Date, now: number, t: (k: string, o?: object) => string) => {
  const ms = relativeTimeMs(value, now);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t('audit.live.relative.justNow');
  if (minutes < 60) return t('audit.live.relative.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('audit.live.relative.hours', { count: hours });
  const days = Math.floor(hours / 24);
  return t('audit.live.relative.days', { count: days });
};

export interface TopicListPaneProps {
  hasMore: boolean;
  items: AdminAuditConversationListItem[];
  loading?: boolean;
  onLoadMore: () => void;
  onSelect: (topicId: string) => void;
  selectedTopicId?: string;
}

const TopicListPane = memo<TopicListPaneProps>(
  ({ items, selectedTopicId, onSelect, hasMore, onLoadMore, loading }) => {
    const { t } = useTranslation('admin');
    const reduceMotion = useReducedMotion();
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
      const id = window.setInterval(() => setNow(Date.now()), 30_000);
      return () => window.clearInterval(id);
    }, []);

    if (!items.length && !loading) {
      return (
        <div className={styles.root}>
          <Text type="secondary">{t('audit.live.topics.empty')}</Text>
        </div>
      );
    }

    // layoutScroll so popLayout/layout children measure offsetTop against the scrollport
    // when the operator has scrolled (plain overflow:auto has no layoutScroll ancestor).
    return (
      <m.div layoutScroll className={styles.root}>
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item) => (
            <m.div
              animate={{ opacity: 1 }}
              className={styles.item}
              data-active={item.id === selectedTopicId}
              exit={reduceMotion ? undefined : { opacity: 0 }}
              initial={reduceMotion ? false : { opacity: 0 }}
              key={item.id}
              layout={!reduceMotion}
              role="button"
              tabIndex={0}
              title={formatAdminDateTime(item.updatedAt)}
              transition={{ duration: reduceMotion ? 0 : 0.16 }}
              onClick={() => onSelect(item.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect(item.id);
              }}
            >
              <p className={styles.title}>{item.title || t('audit.conversations.untitled')}</p>
              <p className={styles.meta}>
                {formatRelative(new Date(item.updatedAt), now, t as never)}
                {item.model ? ` · ${item.model}` : ''}
              </p>
            </m.div>
          ))}
        </AnimatePresence>
        {hasMore ? (
          <Button loading={loading} size="small" type="default" onClick={onLoadMore}>
            {t('audit.live.topics.loadMore')}
          </Button>
        ) : null}
      </m.div>
    );
  },
);

TopicListPane.displayName = 'AuditLiveTopicListPane';

export default TopicListPane;
