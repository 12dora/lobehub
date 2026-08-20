'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { AdminAuditUsersTimelineItem } from '@/enterprise/client/services/adminAudit';

import { formatAdminDateTime } from '../shared/format';

export const TIMELINE_PAGE_SIZE = 30;

const styles = createStaticStyles(({ css }) => ({
  timeline: css`
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;

    max-height: 480px;
  `,
  timelineItem: css`
    cursor: pointer;

    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    &:hover {
      border-color: ${cssVar.colorPrimary};
    }
  `,
  timelineFooter: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: stretch;

    margin-block-start: 4px;
  `,
}));

export interface UserTimelinePaneProps {
  empty: boolean;
  failed: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  isValidating?: boolean;
  items: AdminAuditUsersTimelineItem[];
  loading: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onRetry: () => void;
  stale: boolean;
  userId: string;
}

const UserTimelinePane = memo<UserTimelinePaneProps>(
  ({
    empty,
    failed,
    hasNext,
    hasPrevious,
    isValidating,
    items,
    loading,
    onNext,
    onPrevious,
    onRetry,
    stale,
    userId,
  }) => {
    const { t } = useTranslation('admin');
    const navigate = useNavigate();

    return (
      <div style={{ flex: '0 1 320px', minWidth: 260 }}>
        <Text style={{ fontWeight: 600 }}>{t('audit.conversations.user.timeline')}</Text>
        <div className={styles.timeline}>
          {loading ? (
            <Text type="secondary">{t('audit.conversations.user.timelineLoading')}</Text>
          ) : null}
          {failed ? (
            <div className={styles.timelineFooter}>
              <Text type="secondary">{t('audit.conversations.user.timelineError')}</Text>
              <Button type="default" onClick={onRetry}>
                {t('audit.conversations.user.timelineRetry')}
              </Button>
            </div>
          ) : null}
          {!failed
            ? items.map((item) => (
                <div
                  className={styles.timelineItem}
                  key={`${item.kind}-${item.id}`}
                  onClick={() => {
                    if (item.kind === 'topic' && item.topicId) {
                      navigate(`/admin/audit/conversations/${userId}/topics/${item.topicId}`);
                    }
                  }}
                >
                  <Flexbox horizontal gap={6}>
                    <Tag size="small">
                      {t(`audit.conversations.timeline.kind.${item.kind}` as never, {
                        defaultValue: item.kind,
                      })}
                    </Tag>
                    <Text ellipsis style={{ margin: 0 }}>
                      {item.title || item.id}
                    </Text>
                  </Flexbox>
                  <Text style={{ fontSize: 12 }} type="secondary">
                    {formatAdminDateTime(item.updatedAt)}
                  </Text>
                </div>
              ))
            : null}
          {empty ? (
            <Text type="secondary">{t('audit.conversations.user.emptyTimeline')}</Text>
          ) : null}
          {!failed && (hasPrevious || hasNext) ? (
            <div className={styles.timelineFooter}>
              <Flexbox horizontal gap={8}>
                <Button disabled={!hasPrevious} type="default" onClick={onPrevious}>
                  {t('audit.conversations.user.timelinePrevious')}
                </Button>
                <Button disabled={!hasNext} loading={isValidating} type="default" onClick={onNext}>
                  {t('audit.conversations.user.timelineNext')}
                </Button>
              </Flexbox>
            </div>
          ) : null}
          {stale ? (
            <Text type="secondary">{t('audit.conversations.user.timelineStale')}</Text>
          ) : null}
        </div>
      </div>
    );
  },
);

UserTimelinePane.displayName = 'AuditUserTimelinePane';

export default UserTimelinePane;
