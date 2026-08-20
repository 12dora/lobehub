'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditConversationListItem } from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable, { type AdminTableChangeMeta } from '../../primitives/DataTable';
import {
  useFetchAuditConversationsList,
  useFetchAuditPolicy,
  useFetchAuditUserSummary,
  useFetchAuditUserTimeline,
} from '../hooks/useAdminAudit';
import { displayAuditUserLabel, formatAdminDateTime, hasPermission } from '../shared/format';
import { emptyRedactionSlots, envelopeSlot } from '../shared/redactionAuthority';
import { getDefaultAuditTimeWindow } from '../shared/timeWindow';
import { useCursorPagination } from '../shared/useCursorPagination';
import { useRedactionAuthority } from '../shared/useRedactionAuthority';
import ContentAccessDisabledState from './ContentAccessDisabledState';
import { endOfDay, firstFilterValue, parseIsoDay, sameCalendarDay, startOfDay } from './dayFilters';
import { useConversationColumns } from './useConversationColumns';
import UserTimelinePane, { TIMELINE_PAGE_SIZE } from './UserTimelinePane';

const styles = createStaticStyles(({ css }) => ({
  summary: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));

const isForbiddenError = (err: unknown) => {
  if (!err) return false;
  const data = (err as { data?: { code?: string } }).data;
  if (data?.code === 'FORBIDDEN') return true;
  const mapped = mapEnterpriseError(err);
  return mapped?.code === 'PLATFORM_PERMISSION_DENIED' || mapped?.code === 'ADMIN_ACCESS_DENIED';
};

const ConversationUserPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { userId = '' } = useParams<{ userId: string }>();
  const { permissions } = useAdminAccess();
  const canConversationRead = hasPermission(
    permissions,
    PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ,
  );
  // users.summary requires AUDIT_READ — optional metadata for conversation-only actors.
  const canAuditRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const window0 = useMemo(() => getDefaultAuditTimeWindow(), []);
  const [from, setFrom] = useState(window0.from);
  const [to, setTo] = useState(window0.to);
  const [q, setQ] = useState('');
  const {
    currentCursor,
    hasPrevious,
    limit,
    onNext,
    onPageSizeChange,
    onPrevious,
    reset: resetCursor,
  } = useCursorPagination();
  const summaryFailureNotifiedRef = useRef(false);
  const {
    currentCursor: timelineCursor,
    hasPrevious: timelineHasPrevious,
    limit: timelineLimit,
    onNext: onTimelineNext,
    onPrevious: onTimelinePrevious,
    reset: resetTimeline,
  } = useCursorPagination({ initialLimit: TIMELINE_PAGE_SIZE });

  const applyTitleQuery = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (trimmed === q) return;
      setQ(trimmed);
      resetCursor();
    },
    [q, resetCursor],
  );

  const applyDateRange = useCallback(
    (range: [Date | null, Date | null] | null) => {
      if (!range?.[0] || !range[1]) {
        const fallback = getDefaultAuditTimeWindow();
        setFrom(fallback.from);
        setTo(fallback.to);
        resetCursor();
        return;
      }
      const nextFrom = startOfDay(range[0]);
      const nextTo = endOfDay(range[1]);
      if (sameCalendarDay(from, nextFrom) && sameCalendarDay(to, nextTo)) return;
      setFrom(nextFrom);
      setTo(nextTo);
      resetCursor();
    },
    [from, resetCursor, to],
  );

  const handleTableChange = useCallback(
    ({ filters }: AdminTableChangeMeta) => {
      if (Object.hasOwn(filters, 'title')) {
        applyTitleQuery(firstFilterValue(filters.title) ?? '');
      }

      if (!Object.hasOwn(filters, 'updatedAt')) return;
      const rawRange = filters.updatedAt;
      if (!rawRange || (Array.isArray(rawRange) && !rawRange[0] && !rawRange[1])) {
        applyDateRange(null);
        return;
      }
      const nextFrom = parseIsoDay(rawRange[0]);
      const nextTo = parseIsoDay(rawRange[1]);
      if (!nextFrom || !nextTo) return;
      applyDateRange([nextFrom, nextTo]);
    },
    [applyDateRange, applyTitleQuery],
  );

  const summary = useFetchAuditUserSummary(userId, canAuditRead && !!userId);
  const policy = useFetchAuditPolicy(canAuditRead);
  const list = useFetchAuditConversationsList(
    {
      cursor: currentCursor,
      from,
      limit,
      q: q || undefined,
      to,
      userId,
    },
    canConversationRead && !!userId,
  );
  const timeline = useFetchAuditUserTimeline(
    { cursor: timelineCursor, from, limit: timelineLimit, to, userId },
    canConversationRead && !!userId,
  );

  // Reset timeline pagination when the evidence window or subject changes.
  useEffect(() => {
    resetTimeline();
  }, [from, resetTimeline, to, userId]);

  const redaction = useRedactionAuthority(
    {
      ...emptyRedactionSlots(),
      list: envelopeSlot(list.data),
      policy: canAuditRead ? envelopeSlot(policy.data) : undefined,
      timeline: envelopeSlot(timeline.data),
    },
    [],
    userId,
    () => {
      resetCursor();
      resetTimeline();
    },
  );
  const listRenderable = redaction.isEnvelopeRenderable(envelopeSlot(list.data));
  const timelineRenderable = redaction.isEnvelopeRenderable(envelopeSlot(timeline.data));

  // Only conversation evidence failures deny the page — not optional AUDIT_READ summary.
  const isForbidden = useMemo(() => {
    return [list.error, timeline.error].some(isForbiddenError);
  }, [list.error, timeline.error]);
  const summaryFailed = Boolean(summary.error);

  useEffect(() => {
    if (summaryFailed && !summaryFailureNotifiedRef.current) {
      summaryFailureNotifiedRef.current = true;
      toast.error(t('audit.shared.summaryLoadFailed'));
    } else if (!summaryFailed) {
      summaryFailureNotifiedRef.current = false;
    }
  }, [summaryFailed, t]);

  const columns = useConversationColumns({
    applyDateRange,
    applyTitleQuery,
    from,
    q,
    to,
  });

  if (isForbidden) {
    return <ContentAccessDisabledState />;
  }

  const user = summary.data;
  const listItems = listRenderable ? (list.data?.items ?? []) : [];
  const timelineItems = timelineRenderable ? (timeline.data?.items ?? []) : [];
  const timelineFailed = Boolean(timeline.error) && !timeline.data;
  const timelineEmpty =
    !timeline.isLoading &&
    !timelineFailed &&
    timeline.data !== undefined &&
    timelineItems.length === 0;

  return (
    <AdminPageTemplate
      description={t('audit.conversations.user.desc')}
      title={user ? displayAuditUserLabel(user) : t('audit.conversations.user.title')}
      actions={
        <Button type="default" onClick={() => navigate('/admin/audit/conversations')}>
          {t('audit.conversations.user.back')}
        </Button>
      }
    >
      <div className={styles.summary}>
        {summaryFailed ? (
          <Alert
            showIcon
            message={t('audit.conversations.user.summaryUnavailable')}
            style={{ gridColumn: '1 / -1' }}
            type="warning"
            action={
              <Button size="small" onClick={() => void summary.mutate()}>
                {t('audit.shared.retryMissingSections')}
              </Button>
            }
          />
        ) : null}
        <div>
          <Text type="secondary">{t('audit.conversations.user.email')}</Text>
          <div>{user?.email ?? '—'}</div>
        </div>
        <div>
          <Text type="secondary">{t('audit.conversations.user.username')}</Text>
          <div>{user?.username ?? '—'}</div>
        </div>
        <div>
          <Text type="secondary">{t('audit.conversations.user.topics')}</Text>
          <div>{user?.topicCount ?? '—'}</div>
        </div>
        <div>
          <Text type="secondary">{t('audit.conversations.user.messages')}</Text>
          <div>{user?.messageCount ?? '—'}</div>
        </div>
        <div>
          <Text type="secondary">{t('audit.conversations.user.lastActive')}</Text>
          <div>{formatAdminDateTime(user?.lastActiveAt)}</div>
        </div>
      </div>

      <Flexbox horizontal gap={16} style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 480px', minWidth: 0 }}>
          <Text style={{ fontWeight: 600 }}>{t('audit.conversations.user.topicsList')}</Text>
          <DataTable<AdminAuditConversationListItem>
            columns={columns}
            dataSource={listItems}
            emptyDescription={t('audit.conversations.user.emptyTopics')}
            error={Boolean(list.error) && !list.data}
            loading={list.isLoading && !list.data}
            pagination={false}
            rowKey="id"
            cursorPagination={{
              hasNext: listRenderable && Boolean(list.data?.nextCursor),
              hasPrevious: listRenderable && hasPrevious,
              onNext: () => {
                if (!listRenderable) return;
                onNext(list.data?.nextCursor);
              },
              onPrevious: listRenderable ? onPrevious : () => undefined,
              pageSize: limit,
              onPageSizeChange,
            }}
            onChange={handleTableChange}
            onRetry={() => void list.mutate()}
            onRowActivate={(row) =>
              navigate(`/admin/audit/conversations/${userId}/topics/${row.id}`)
            }
          />
        </div>
        <UserTimelinePane
          empty={timelineEmpty}
          failed={timelineFailed}
          hasNext={timelineRenderable && Boolean(timeline.data?.nextCursor)}
          hasPrevious={timelineRenderable && timelineHasPrevious}
          isValidating={timeline.isValidating}
          items={timelineItems}
          loading={timeline.isLoading && !timeline.data}
          stale={Boolean(timeline.error) && Boolean(timeline.data)}
          userId={userId}
          onPrevious={timelineRenderable ? onTimelinePrevious : () => undefined}
          onRetry={() => void timeline.mutate()}
          onNext={() => {
            if (!timelineRenderable) return;
            onTimelineNext(timeline.data?.nextCursor);
          }}
        />
      </Flexbox>
    </AdminPageTemplate>
  );
});

ConversationUserPage.displayName = 'AuditConversationUserPage';

export default ConversationUserPage;
