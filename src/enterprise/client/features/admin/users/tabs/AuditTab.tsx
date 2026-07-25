'use client';

import { Alert, Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatAuditReason } from '../auditReasonCodes';
import { useFetchAdminUserAuditTrail } from '../hooks/useAdminUsers';
import { formatAdminDateTime } from '../utils';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: grid;
    grid-template-columns: 140px 1fr 100px;
    gap: 8px;

    padding-block: 10px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));

interface AuditTabProps {
  canReadAudit: boolean;
  enabled: boolean;
  userId: string;
}

const AuditTab = memo<AuditTabProps>(({ userId, canReadAudit, enabled }) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const currentCursor = cursorStack.at(-1) ?? null;

  useEffect(() => {
    setCursorStack([]);
  }, [userId]);

  const shouldFetch = enabled && canReadAudit;
  const { data, error, isLoading, mutate } = useFetchAdminUserAuditTrail(
    { cursor: currentCursor ?? undefined, limit: 50, userId },
    shouldFetch,
  );

  const goNext = useCallback(() => {
    if (!data?.nextCursor) return;
    setCursorStack((s) => [...s, data.nextCursor]);
  }, [data?.nextCursor]);

  const goPrevious = useCallback(() => {
    setCursorStack((s) => (s.length === 0 ? s : s.slice(0, -1)));
  }, []);

  const formatAction = useCallback(
    (action: string) => t(`audit.logs.action.${action}` as never, { defaultValue: action }),
    [t],
  );

  const formatReason = useCallback(
    (reason: string | null | undefined) =>
      formatAuditReason(reason, (key, options) =>
        String(t(key as never, { defaultValue: options?.defaultValue })),
      ),
    [t],
  );

  if (!canReadAudit) {
    return (
      <Flexbox gap={8}>
        <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          {t('users.audit.title')}
        </Text>
        <Text type="secondary">{t('users.audit.noPermission')}</Text>
      </Flexbox>
    );
  }

  if (isLoading && !data) {
    return (
      <div aria-label={t('primitives.dataTable.loading')} role="status">
        <Skeleton active={!reduceMotion} paragraph={{ rows: 4 }} title={false} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <Flexbox gap={8} role="alert">
        <Text>{t('primitives.dataTable.error')}</Text>
        <Button size="small" type="primary" onClick={() => void mutate()}>
          {t('primitives.dataTable.retry')}
        </Button>
      </Flexbox>
    );
  }

  const items = data?.items ?? [];
  const showStaleWarning = Boolean(error) && Boolean(data);

  return (
    <Flexbox gap={12}>
      <Text as="h3" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
        {t('users.audit.title')}
      </Text>
      {showStaleWarning ? (
        <Alert
          showIcon
          type="warning"
          action={
            <Button size="small" onClick={() => void mutate()}>
              {t('primitives.dataTable.retry')}
            </Button>
          }
          message={t('users.stale.refreshFailed', {
            defaultValue: 'Showing cached data — the latest refresh failed.',
          })}
        />
      ) : null}
      {items.length === 0 ? (
        <Text type="secondary">{t('users.audit.empty')}</Text>
      ) : (
        items.map((row) => (
          <div className={styles.row} key={row.id}>
            <Text type="secondary">{formatAdminDateTime(row.createdAt)}</Text>
            <div>
              <Text style={{ fontWeight: 500 }}>{formatAction(row.action)}</Text>
              {row.reason ? (
                <Text style={{ display: 'block', fontSize: 12 }} type="secondary">
                  {formatReason(row.reason)}
                </Text>
              ) : null}
            </div>
            <Text>
              {t(`users.audit.result.${row.result}` as never, { defaultValue: row.result })}
            </Text>
          </div>
        ))
      )}
      <Flexbox horizontal gap={8} justify="flex-end">
        <Button disabled={cursorStack.length === 0} size="small" onClick={goPrevious}>
          {t('primitives.dataTable.previous')}
        </Button>
        <Button disabled={!data?.nextCursor} size="small" onClick={goNext}>
          {t('primitives.dataTable.next')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
});

AuditTab.displayName = 'AdminUserAuditTab';

export default AuditTab;
