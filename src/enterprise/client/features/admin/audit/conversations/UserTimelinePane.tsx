'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useFetchAuditUserTimeline } from '../hooks/useAdminAudit';
import { formatAdminDateTime } from '../shared/format';
import { isRedactionProfileTightening } from '../shared/liveMessageUtils';
import { purgeAuditConversationEvidenceCaches } from '../shared/purgeConversationEvidence';
import { useCursorPagination } from '../shared/useCursorPagination';

const TIMELINE_PAGE_SIZE = 30;

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
  canFetch: boolean;
  from: Date;
  onErrorChange?: (error: unknown) => void;
  to: Date;
  userId: string;
}

const UserTimelinePane = memo<UserTimelinePaneProps>(
  ({ canFetch, from, onErrorChange, to, userId }) => {
    const { t } = useTranslation('admin');
    const navigate = useNavigate();
    const { currentCursor, hasPrevious, limit, onNext, onPrevious, reset } = useCursorPagination({
      initialLimit: TIMELINE_PAGE_SIZE,
    });

    // Reset timeline pagination when the evidence window or subject changes.
    useEffect(() => {
      reset();
    }, [from, reset, to, userId]);

    const timeline = useFetchAuditUserTimeline(
      { cursor: currentCursor, from, limit, to, userId },
      canFetch,
    );

    const prevRedactionProfileRef = useRef<
      NonNullable<(typeof timeline)['data']>['redactionProfile'] | undefined
    >(undefined);
    useEffect(() => {
      const profile = timeline.data?.redactionProfile;
      const prev = prevRedactionProfileRef.current;
      if (profile) prevRedactionProfileRef.current = profile;
      if (!prev || !profile) return;
      if (!isRedactionProfileTightening(prev, profile)) return;
      reset();
      void purgeAuditConversationEvidenceCaches();
    }, [reset, timeline.data?.redactionProfile]);

    // Report before paint so a timeline-only FORBIDDEN still gates the parent page
    // (same as when both fetches lived in ConversationUserPage). Do not clear on
    // unmount — that would flip the parent gate off and remount us in a loop.
    useLayoutEffect(() => {
      onErrorChange?.(timeline.error);
    }, [onErrorChange, timeline.error]);

    const timelineItems = timeline.data?.items ?? [];
    const timelineFailed = Boolean(timeline.error) && !timeline.data;
    const timelineEmpty =
      !timeline.isLoading &&
      !timelineFailed &&
      timeline.data !== undefined &&
      timelineItems.length === 0;
    const timelineHasNext = Boolean(timeline.data?.nextCursor);

    return (
      <div style={{ flex: '0 1 320px', minWidth: 260 }}>
        <Text style={{ fontWeight: 600 }}>{t('audit.conversations.user.timeline')}</Text>
        <div className={styles.timeline}>
          {timeline.isLoading && !timeline.data ? (
            <Text type="secondary">{t('audit.conversations.user.timelineLoading')}</Text>
          ) : null}
          {timelineFailed ? (
            <div className={styles.timelineFooter}>
              <Text type="secondary">{t('audit.conversations.user.timelineError')}</Text>
              <Button type="default" onClick={() => void timeline.mutate()}>
                {t('audit.conversations.user.timelineRetry')}
              </Button>
            </div>
          ) : null}
          {!timelineFailed
            ? timelineItems.map((item) => (
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
          {timelineEmpty ? (
            <Text type="secondary">{t('audit.conversations.user.emptyTimeline')}</Text>
          ) : null}
          {!timelineFailed && (hasPrevious || timelineHasNext) ? (
            <div className={styles.timelineFooter}>
              <Flexbox horizontal gap={8}>
                <Button disabled={!hasPrevious} type="default" onClick={onPrevious}>
                  {t('audit.conversations.user.timelinePrevious')}
                </Button>
                <Button
                  disabled={!timelineHasNext}
                  loading={timeline.isValidating}
                  type="default"
                  onClick={() => onNext(timeline.data?.nextCursor)}
                >
                  {t('audit.conversations.user.timelineNext')}
                </Button>
              </Flexbox>
            </div>
          ) : null}
          {!timelineFailed && timeline.error && timeline.data ? (
            <Text type="secondary">{t('audit.conversations.user.timelineStale')}</Text>
          ) : null}
        </div>
      </div>
    );
  },
);

UserTimelinePane.displayName = 'AuditUserTimelinePane';

export default UserTimelinePane;
