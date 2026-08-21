'use client';

import { Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_PAGE_SIZE } from '../primitives/dataTableChange';
import { useAdminConnectorAudit } from './useAdminConnectorAudit';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: grid;
    grid-template-columns: 160px minmax(220px, 1fr) 110px;
    gap: 12px;

    padding-block: 10px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 720px) {
      grid-template-columns: 1fr;
    }
  `,
}));

interface ConnectorAuditPanelProps {
  canReadAudit: boolean;
  connectorId: string;
}

const formatDateTime = (value: Date | string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

const ConnectorAuditPanel = memo<ConnectorAuditPanelProps>(({ canReadAudit, connectorId }) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const cursor = cursorStack.at(-1) ?? null;
  const { data, error, isLoading, mutate } = useAdminConnectorAudit({
    connectorId,
    cursor,
    enabled: canReadAudit,
    limit: DEFAULT_PAGE_SIZE,
  });

  useEffect(() => setCursorStack([]), [connectorId]);

  const goNext = useCallback(() => {
    if (data?.nextCursor) setCursorStack((value) => [...value, data.nextCursor]);
  }, [data?.nextCursor]);
  const goPrevious = useCallback(
    () => setCursorStack((value) => (value.length ? value.slice(0, -1) : value)),
    [],
  );

  return (
    <Flexbox gap={12}>
      <Text strong>{t('connectorCatalog.audit.title')}</Text>
      {!canReadAudit ? (
        <Text type={'secondary'}>{t('connectorCatalog.audit.noPermission')}</Text>
      ) : isLoading && !data ? (
        <div aria-label={t('primitives.dataTable.loading')} role="status">
          <Skeleton active={!reduceMotion} paragraph={{ rows: 4 }} title={false} />
        </div>
      ) : error && !data ? (
        <Flexbox gap={8} role={'alert'}>
          <Text>{t('primitives.dataTable.error')}</Text>
          <Button size={'small'} onClick={() => void mutate()}>
            {t('primitives.dataTable.retry')}
          </Button>
        </Flexbox>
      ) : !data?.items.length ? (
        <Text type={'secondary'}>{t('connectorCatalog.audit.empty')}</Text>
      ) : (
        <>
          {data.items.map((row) => (
            <div className={styles.row} key={row.id}>
              <Text type={'secondary'}>{formatDateTime(row.createdAt)}</Text>
              <Flexbox gap={2} style={{ minWidth: 0 }}>
                <Text strong>
                  {t(`connectorCatalog.audit.action.${row.action}` as never, {
                    defaultValue: row.action,
                  })}
                </Text>
                {row.reason ? <Text type={'secondary'}>{row.reason}</Text> : null}
              </Flexbox>
              <Text>{t(`connectorCatalog.audit.result.${row.result}` as never)}</Text>
            </div>
          ))}
          <Flexbox horizontal gap={8} justify={'flex-end'}>
            <Button disabled={!cursorStack.length} size={'small'} onClick={goPrevious}>
              {t('primitives.dataTable.previous')}
            </Button>
            <Button disabled={!data.nextCursor} size={'small'} onClick={goNext}>
              {t('primitives.dataTable.next')}
            </Button>
          </Flexbox>
        </>
      )}
    </Flexbox>
  );
});

ConnectorAuditPanel.displayName = 'AdminConnectorAuditPanel';

export default ConnectorAuditPanel;
