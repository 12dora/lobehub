'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
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
}));

const ConversationUserPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { userId = '' } = useParams<{ userId: string }>();
  const { permissions } = useAdminAccess();
  const canRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ);

  const window0 = useMemo(() => getDefaultAuditTimeWindow(), []);
  const [from, setFrom] = useState(window0.from);
  const [to, setTo] = useState(window0.to);
  const [qDraft, setQDraft] = useState('');
  const [q, setQ] = useState('');
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIST_LIMIT);
  const debounceRef = useRef<number | null>(null);
  const currentCursor = cursorStack.at(-1) ?? null;

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setQ(qDraft.trim()), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [qDraft]);

  const summary = useFetchAuditUserSummary(userId, canRead && !!userId);
  const list = useFetchAuditConversationsList(
    {
      cursor: currentCursor,
      from,
      limit,
      q: q || undefined,
      to,
      userId,
    },
    canRead && !!userId,
  );
  const timeline = useFetchAuditUserTimeline({ from, limit: 30, to, userId }, canRead && !!userId);

  const forbidden =
    [summary.error, list.error, timeline.error].some((err) => {
      const mapped = mapEnterpriseError(err);
      return (
        mapped?.code === 'PLATFORM_PERMISSION_DENIED' ||
        mapped?.code === 'ADMIN_ACCESS_DENIED' ||
        mapped?.code === 'FORBIDDEN'
      );
    }) || false;

  // Also treat raw TRPC FORBIDDEN
  const isForbidden = useMemo(() => {
    const errors = [summary.error, list.error, timeline.error];
    return errors.some((err) => {
      if (!err) return false;
      const data = (err as { data?: { code?: string } }).data;
      if (data?.code === 'FORBIDDEN') return true;
      return forbidden;
    });
  }, [forbidden, list.error, summary.error, timeline.error]);

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
        render: (v: string | null) => v ?? '—',
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

  if (isForbidden) {
    return <ContentAccessDisabledState />;
  }

  const user = summary.data;

  return (
    <AdminPageTemplate
      description={t('audit.conversations.user.desc')}
      actions={
        <Button type="default" onClick={() => navigate('/admin/audit/conversations')}>
          {t('audit.conversations.user.back')}
        </Button>
      }
      title={user ? displayAuditUserLabel(user) : t('audit.conversations.user.title')}
      toolbar={
        <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
          <input
            placeholder={t('audit.conversations.user.searchTitle')}
            value={qDraft}
            style={{
              minWidth: 200,
              padding: '4px 8px',
              border: `1px solid ${cssVar.colorBorder}`,
              borderRadius: 6,
            }}
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
            {(timeline.data?.items ?? []).map((item) => (
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
                  <Tag size="small">{item.kind}</Tag>
                  <Text ellipsis style={{ margin: 0 }}>
                    {item.title || item.id}
                  </Text>
                </Flexbox>
                <Text style={{ fontSize: 12 }} type="secondary">
                  {formatAdminDateTime(item.updatedAt)}
                </Text>
              </div>
            ))}
            {!timeline.data?.items?.length && !timeline.isLoading ? (
              <Text type="secondary">{t('audit.conversations.user.emptyTimeline')}</Text>
            ) : null}
          </div>
        </div>
      </Flexbox>
    </AdminPageTemplate>
  );
});

ConversationUserPage.displayName = 'AuditConversationUserPage';

export default ConversationUserPage;
