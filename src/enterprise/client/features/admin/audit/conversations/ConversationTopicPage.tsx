'use client';

import { Alert, Flexbox, Skeleton, Tag, Text } from '@lobehub/ui';
import { Button, Switch, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditConversationMessage } from '@/enterprise/client/services/adminAudit';
import { getModelDisplayName, useProviderLabel } from '@/utils/modelLabels';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import { openDangerConfirm } from '../../primitives/DangerConfirm';
import {
  useFetchAuditConversation,
  useFetchAuditConversationMessages,
  useFetchAuditPolicy,
} from '../hooks/useAdminAudit';
import { formatAdminDateTime, hasPermission } from '../shared/format';
import ContentAccessDisabledState from './ContentAccessDisabledState';

const styles = createStaticStyles(({ css }) => ({
  banner: css`
    padding-block: 10px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorWarningBg};
  `,
  message: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding-block: 12px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  body: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 13px;
    line-height: 1.55;
    word-break: break-word;
    white-space: pre-wrap;
  `,
  redacted: css`
    font-weight: 600;
    color: ${cssVar.colorWarning};
  `,
  stream: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
}));

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

const ConversationTopicPage = memo(() => {
  const { t } = useTranslation('admin');
  const providerLabel = useProviderLabel();
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const { userId = '', topicId = '' } = useParams<{ userId: string; topicId: string }>();
  const { permissions } = useAdminAccess();
  const canConversationRead = hasPermission(
    permissions,
    PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ,
  );
  // policy.get requires AUDIT_READ — optional; conversation evidence may still be available.
  const canAuditRead = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);

  const [includeBody, setIncludeBody] = useState(false);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const detailFailureNotifiedRef = useRef(false);
  const currentCursor = cursorStack.at(-1) ?? null;

  const policy = useFetchAuditPolicy(canAuditRead);
  const detail = useFetchAuditConversation(
    userId,
    topicId,
    canConversationRead && !!userId && !!topicId,
  );
  const messages = useFetchAuditConversationMessages(
    {
      cursor: currentCursor,
      includeBody,
      limit: 50,
      topicId,
      userId,
    },
    canConversationRead && !!userId && !!topicId,
  );

  // Only conversation evidence failures deny the page — not optional policy metadata.
  const isForbidden = useMemo(() => {
    const errors = [detail.error, messages.error];
    return errors.some((err) => {
      if (!err) return false;
      const data = (err as { data?: { code?: string } }).data;
      return data?.code === 'FORBIDDEN';
    });
  }, [detail.error, messages.error]);
  // A revalidation failure with cached detail is still degraded: preserve the stale
  // evidence, but make its freshness failure explicit and retryable.
  const detailFailed = Boolean(detail.error) && !isForbidden;

  useEffect(() => {
    if (detailFailed && !detailFailureNotifiedRef.current) {
      detailFailureNotifiedRef.current = true;
      toast.error(t('audit.shared.summaryLoadFailed'));
    } else if (!detailFailed) {
      detailFailureNotifiedRef.current = false;
    }
  }, [detailFailed, t]);

  // Prefer contentAccessMode from conversation/messages (available with CONVERSATION_READ).
  const contentAccessMode =
    messages.data?.contentAccessMode ??
    detail.data?.contentAccessMode ??
    (canAuditRead ? policy.data?.contentAccessMode : undefined);

  const onToggleBody = useCallback(
    (checked: boolean) => {
      if (!checked) {
        setIncludeBody(false);
        setCursorStack([]);
        return;
      }
      openDangerConfirm({
        content: t('audit.conversations.topic.loadBodyConfirm'),
        title: t('audit.conversations.topic.loadBodyTitle'),
        onConfirm: () => {
          setIncludeBody(true);
          setCursorStack([]);
        },
      });
    },
    [t],
  );

  if (isForbidden || contentAccessMode === 'disabled') {
    return <ContentAccessDisabledState />;
  }

  const topic = detail.data;
  const items = messages.data?.items ?? [];

  return (
    <AdminPageTemplate
      description={t('audit.conversations.topic.desc')}
      title={topic?.title || t('audit.conversations.topic.title')}
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
        contentAccessMode === 'metadata_only' ? (
          <div className={styles.banner} role="status">
            {t('audit.conversations.topic.metadataOnlyBanner')}
          </div>
        ) : contentAccessMode === 'content_allowed' ? (
          <div className={styles.banner} role="status">
            <Flexbox horizontal align="center" gap={12}>
              <span>{t('audit.conversations.topic.bodyToggleLabel')}</span>
              <Switch
                checked={includeBody}
                onChange={(checked) => onToggleBody(Boolean(checked))}
              />
            </Flexbox>
          </div>
        ) : null
      }
    >
      {detailFailed ? (
        <Alert
          showIcon
          message={t('audit.conversations.topic.detailUnavailable')}
          style={{ marginBlockEnd: 12 }}
          type="warning"
          action={
            <Button size="small" onClick={() => void detail.mutate()}>
              {t('audit.shared.retryMissingSections')}
            </Button>
          }
        />
      ) : null}
      <Flexbox gap={8} style={{ marginBlockEnd: 12 }}>
        <Text type="secondary">
          {[
            providerLabel(topic?.provider),
            getModelDisplayName(topic?.model, topic?.provider),
            topic?.agentId,
          ]
            .filter(Boolean)
            .join(' · ') || '—'}
        </Text>
        <Text type="secondary">
          {t('audit.conversations.columns.updatedAt')}: {formatAdminDateTime(topic?.updatedAt)}
        </Text>
      </Flexbox>

      <div className={styles.stream}>
        {messages.isLoading && !messages.data ? (
          <div aria-label={t('primitives.dataTable.loading')} role="status">
            <Skeleton active={!reduceMotion} paragraph={{ rows: 5 }} title={false} />
          </div>
        ) : null}
        {items.map((msg: AdminAuditConversationMessage) => (
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
        {messages.error && !messages.data ? (
          <Flexbox align="flex-start" gap={8}>
            <Text role="alert" type="danger">
              {t('audit.conversations.topic.loadError')}
            </Text>
            <Button size="small" type="default" onClick={() => void messages.mutate()}>
              {t('primitives.dataTable.retry')}
            </Button>
          </Flexbox>
        ) : null}
        {!items.length && !messages.isLoading && !messages.error ? (
          <Text type="secondary">{t('audit.conversations.topic.emptyMessages')}</Text>
        ) : null}
      </div>

      <Flexbox horizontal gap={8} style={{ marginBlockStart: 12 }}>
        <Button
          disabled={cursorStack.length === 0}
          size="small"
          onClick={() => setCursorStack((p) => p.slice(0, -1))}
        >
          {t('primitives.dataTable.previous')}
        </Button>
        <Button
          disabled={!messages.data?.nextCursor}
          size="small"
          onClick={() => {
            const next = messages.data?.nextCursor;
            if (next) setCursorStack((p) => [...p, next]);
          }}
        >
          {t('primitives.dataTable.next')}
        </Button>
      </Flexbox>
    </AdminPageTemplate>
  );
});

ConversationTopicPage.displayName = 'AuditConversationTopicPage';

export default ConversationTopicPage;
