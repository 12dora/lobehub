'use client';

import { Alert, Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { DatePicker, type TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import dayjs from 'dayjs';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  useFetchAuditUserSummary,
  useFetchAuditUserTimeline,
} from '../hooks/useAdminAudit';
import { displayAuditUserLabel, formatAdminDateTime, hasPermission } from '../shared/format';
import { getDefaultAuditTimeWindow } from '../shared/timeWindow';
import ContentAccessDisabledState from './ContentAccessDisabledState';

const DEFAULT_LIST_LIMIT = 50;
const TIMELINE_PAGE_SIZE = 30;
const DEBOUNCE_MS = 300;

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
  const [qDraft, setQDraft] = useState('');
  const [q, setQ] = useState('');
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [timelineCursorStack, setTimelineCursorStack] = useState<(string | null)[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIST_LIMIT);
  const debounceRef = useRef<number | null>(null);
  const summaryFailureNotifiedRef = useRef(false);
  const currentCursor = cursorStack.at(-1) ?? null;
  const timelineCursor = timelineCursorStack.at(-1) ?? null;

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setQ(qDraft.trim()), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [qDraft]);

  // Reset timeline pagination when the evidence window or subject changes.
  useEffect(() => {
    setTimelineCursorStack([]);
  }, [from, to, userId]);

  const summary = useFetchAuditUserSummary(userId, canAuditRead && !!userId);
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
    { cursor: timelineCursor, from, limit: TIMELINE_PAGE_SIZE, to, userId },
    canConversationRead && !!userId,
  );

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

  const columns: TableColumnsType<AdminAuditConversationListItem> = useMemo(
    () => [
      {
        dataIndex: 'title',
        key: 'title',
        title: t('audit.conversations.columns.title'),
        render: (v: string | null) => v || t('audit.conversations.untitled'),
      },
      {
        key: 'model',
        title: t('audit.conversations.columns.model'),
        render: (_, row) => [row.provider, row.model].filter(Boolean).join(' / ') || '—',
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('audit.conversations.columns.status'),
        width: 100,
        render: (v: string | null) =>
          v ? t(`audit.conversations.status.${v}` as never, { defaultValue: v }) : '—',
      },
      {
        dataIndex: 'updatedAt',
        key: 'updatedAt',
        title: t('audit.conversations.columns.updatedAt'),
        width: 170,
        render: (v: Date) => formatAdminDateTime(v),
      },
    ],
    [t],
  );

  const goNext = useCallback(() => {
    const next = list.data?.nextCursor;
    if (!next) return;
    setCursorStack((prev) => [...prev, next]);
  }, [list.data?.nextCursor]);

  // Timeline uses page-replace cursor stack (same pattern as topics / other admin lists),
  // not client-side append — previous/next controls keep all pages reachable.
  const goNextTimeline = useCallback(() => {
    const next = timeline.data?.nextCursor;
    if (!next) return;
    setTimelineCursorStack((prev) => [...prev, next]);
  }, [timeline.data?.nextCursor]);

  const goPreviousTimeline = useCallback(() => {
    setTimelineCursorStack((prev) => (prev.length ? prev.slice(0, -1) : prev));
  }, []);

  if (isForbidden) {
    return <ContentAccessDisabledState />;
  }

  const user = summary.data;
  const timelineItems = timeline.data?.items ?? [];
  const timelineFailed = Boolean(timeline.error) && !timeline.data;
  const timelineEmpty =
    !timeline.isLoading &&
    !timelineFailed &&
    timeline.data !== undefined &&
    timelineItems.length === 0;
  const timelineHasNext = Boolean(timeline.data?.nextCursor);
  const timelineHasPrevious = timelineCursorStack.length > 0;

  return (
    <AdminPageTemplate
      description={t('audit.conversations.user.desc')}
      title={user ? displayAuditUserLabel(user) : t('audit.conversations.user.title')}
      actions={
        <Button type="default" onClick={() => navigate('/admin/audit/conversations')}>
          {t('audit.conversations.user.back')}
        </Button>
      }
      toolbar={
        <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
          <Input
            placeholder={t('audit.conversations.user.searchTitle')}
            style={{ minWidth: 200 }}
            value={qDraft}
            onChange={(e) => {
              setQDraft(e.target.value);
              setCursorStack([]);
            }}
          />
          <DatePicker.RangePicker
            showTime
            allowClear={false}
            value={[dayjs(from), dayjs(to)]}
            onChange={(vals) => {
              if (!vals?.[0] || !vals[1]) return;
              setFrom(vals[0].toDate());
              setTo(vals[1].toDate());
              setCursorStack([]);
            }}
          />
        </Flexbox>
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
            dataSource={list.data?.items ?? []}
            emptyDescription={t('audit.conversations.user.emptyTopics')}
            error={Boolean(list.error) && !list.data}
            loading={list.isLoading && !list.data}
            pagination={false}
            rowKey="id"
            cursorPagination={{
              hasNext: Boolean(list.data?.nextCursor),
              hasPrevious: cursorStack.length > 0,
              onNext: goNext,
              onPrevious: () => setCursorStack((p) => p.slice(0, -1)),
              pageSize: limit,
              onPageSizeChange: (size) => {
                setLimit(size);
                setCursorStack([]);
              },
            }}
            onRetry={() => void list.mutate()}
            onRowActivate={(row) =>
              navigate(`/admin/audit/conversations/${userId}/topics/${row.id}`)
            }
          />
        </div>
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
            {!timelineFailed && (timelineHasPrevious || timelineHasNext) ? (
              <div className={styles.timelineFooter}>
                <Flexbox horizontal gap={8}>
                  <Button
                    disabled={!timelineHasPrevious}
                    type="default"
                    onClick={goPreviousTimeline}
                  >
                    {t('audit.conversations.user.timelinePrevious')}
                  </Button>
                  <Button
                    disabled={!timelineHasNext}
                    loading={timeline.isValidating}
                    type="default"
                    onClick={goNextTimeline}
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
      </Flexbox>
    </AdminPageTemplate>
  );
});

ConversationUserPage.displayName = 'AuditConversationUserPage';

export default ConversationUserPage;
