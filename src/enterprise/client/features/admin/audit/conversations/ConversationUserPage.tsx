'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditConversationListItem } from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import DataTable from '../../primitives/DataTable';
import {
  useFetchAuditConversationsList,
  useFetchAuditPolicy,
  useFetchAuditUserSummary,
  useFetchAuditUserTimeline,
} from '../hooks/useAdminAudit';
import { displayAuditUserLabel, hasPermission } from '../shared/format';
import { emptyRedactionSlots, envelopeSlot } from '../shared/redactionAuthority';
import { useRedactionAuthority } from '../shared/useRedactionAuthority';
import { useSummaryFailureToast } from '../shared/useSummaryFailureToast';
import ContentAccessDisabledState from './ContentAccessDisabledState';
import { useConversationColumns } from './useConversationColumns';
import { useConversationUserFilters } from './useConversationUserFilters';
import UserSummaryCard from './UserSummaryCard';
import UserTimelinePane from './UserTimelinePane';

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

  const {
    applyDateRange,
    applyTitleQuery,
    from,
    handleTableChange,
    listCursor,
    q,
    resetPagination,
    timelineCursor,
    to,
  } = useConversationUserFilters(userId);

  const summary = useFetchAuditUserSummary(userId, canAuditRead && !!userId);
  const policy = useFetchAuditPolicy(canAuditRead);
  const list = useFetchAuditConversationsList(
    {
      cursor: listCursor.currentCursor,
      from,
      limit: listCursor.limit,
      q: q || undefined,
      to,
      userId,
    },
    canConversationRead && !!userId,
  );
  const timeline = useFetchAuditUserTimeline(
    { cursor: timelineCursor.currentCursor, from, limit: timelineCursor.limit, to, userId },
    canConversationRead && !!userId,
  );

  const redaction = useRedactionAuthority(
    {
      ...emptyRedactionSlots(),
      list: envelopeSlot(list.data),
      policy: canAuditRead ? envelopeSlot(policy.data) : undefined,
      timeline: envelopeSlot(timeline.data),
    },
    [],
    userId,
    resetPagination,
  );
  const listRenderable = redaction.isEnvelopeRenderable(envelopeSlot(list.data));
  const timelineRenderable = redaction.isEnvelopeRenderable(envelopeSlot(timeline.data));

  // Only conversation evidence failures deny the page — not optional AUDIT_READ summary.
  const isForbidden = useMemo(() => {
    return [list.error, timeline.error].some(isForbiddenError);
  }, [list.error, timeline.error]);
  const summaryFailed = Boolean(summary.error);

  useSummaryFailureToast(summaryFailed, t);

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
      <UserSummaryCard failed={summaryFailed} user={user} onRetry={() => void summary.mutate()} />

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
              hasPrevious: listRenderable && listCursor.hasPrevious,
              onNext: () => {
                if (!listRenderable) return;
                listCursor.onNext(list.data?.nextCursor);
              },
              onJumpTo: (target) => {
                if (!listRenderable) return;
                listCursor.onJumpTo(target);
              },
              onPrevious: listRenderable ? listCursor.onPrevious : () => undefined,
              page: listCursor.page,
              pageSize: listCursor.limit,
              onPageSizeChange: listCursor.onPageSizeChange,
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
          hasPrevious={timelineRenderable && timelineCursor.hasPrevious}
          isValidating={timeline.isValidating}
          items={timelineItems}
          loading={timeline.isLoading && !timeline.data}
          stale={Boolean(timeline.error) && Boolean(timeline.data)}
          userId={userId}
          onPrevious={timelineRenderable ? timelineCursor.onPrevious : () => undefined}
          onRetry={() => void timeline.mutate()}
          onNext={() => {
            if (!timelineRenderable) return;
            timelineCursor.onNext(timeline.data?.nextCursor);
          }}
        />
      </Flexbox>
    </AdminPageTemplate>
  );
});

ConversationUserPage.displayName = 'AuditConversationUserPage';

export default ConversationUserPage;
