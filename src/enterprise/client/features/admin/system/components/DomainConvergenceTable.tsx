'use client';

import { Flexbox, Text } from '@lobehub/ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import DataTable from '@/enterprise/client/features/admin/primitives/DataTable';
import { formatRevisionToken } from '@/enterprise/client/features/admin/system/controller';
import type { AdminSystemStatus } from '@/enterprise/client/services/adminSystem';

import { OperationalStatus } from './OperationalStatus';

type Domain = AdminSystemStatus['domains'][number];

const styles = createStaticStyles(({ css }) => ({
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
  `,
  count: css`
    min-width: 28px;
    font-family: ${cssVar.fontFamilyCode};
    font-variant-numeric: tabular-nums;
    text-align: end;
  `,
}));

export const DomainConvergenceTable = memo<{ domains: Domain[] }>(({ domains }) => {
  const { t } = useTranslation('admin');
  const columns = useMemo<TableColumnsType<Domain>>(
    () => [
      {
        dataIndex: 'domain',
        key: 'domain',
        render: (domain: Domain['domain']) => (
          <Flexbox gap={4}>
            <Text strong>{t(`system.values.domain.${domain}` as never)}</Text>
            <Text className={styles.code} type="secondary">
              {domain}
            </Text>
          </Flexbox>
        ),
        title: t('system.domains.columns.domain'),
        width: 190,
      },
      {
        dataIndex: 'status',
        key: 'status',
        render: (status: Domain['status']) => <OperationalStatus status={status} />,
        title: t('system.domains.columns.status'),
        width: 130,
      },
      {
        dataIndex: 'targetToken',
        key: 'targetToken',
        render: (token: Domain['targetToken']) => (
          <Text className={styles.code}>{formatRevisionToken(token)}</Text>
        ),
        title: t('system.domains.columns.target'),
        width: 140,
      },
      {
        key: 'instances',
        render: (_, domain) => (
          <Flexbox horizontal gap={12} wrap="wrap">
            <Text type="secondary">
              {t('system.domains.counts.matching')}{' '}
              <span className={styles.count}>{domain.counts.matching}</span>
            </Text>
            <Text type="secondary">
              {t('system.domains.counts.fresh')}{' '}
              <span className={styles.count}>{domain.counts.fresh}</span>
            </Text>
            <Text type={domain.counts.stale > 0 ? 'warning' : 'secondary'}>
              {t('system.domains.counts.stale')}{' '}
              <span className={styles.count}>{domain.counts.stale}</span>
            </Text>
            <Text type={domain.counts.diverged > 0 ? 'danger' : 'secondary'}>
              {t('system.domains.counts.diverged')}{' '}
              <span className={styles.count}>{domain.counts.diverged}</span>
            </Text>
            <Text type={domain.counts.degraded > 0 ? 'warning' : 'secondary'}>
              {t('system.domains.counts.degraded')}{' '}
              <span className={styles.count}>{domain.counts.degraded}</span>
            </Text>
            <Text type={domain.counts.unreported > 0 ? 'warning' : 'secondary'}>
              {t('system.domains.counts.unreported')}{' '}
              <span className={styles.count}>{domain.counts.unreported}</span>
            </Text>
          </Flexbox>
        ),
        title: t('system.domains.columns.instances'),
      },
      {
        key: 'runtime',
        render: (_, domain) => (
          <Flexbox gap={4}>
            <Text>{t(`system.values.loadMode.${domain.loadMode}` as never)}</Text>
            <Text type="secondary">
              {t(`system.values.fallback.${domain.fallbackPolicy}` as never)}
            </Text>
          </Flexbox>
        ),
        title: t('system.domains.columns.runtime'),
        width: 180,
      },
    ],
    [t],
  );

  return (
    <DataTable<Domain>
      columns={columns}
      dataSource={domains}
      emptyDescription={t('system.domains.empty')}
      pagination={false}
      rowKey="domain"
      scroll={{ x: 980 }}
      size="small"
    />
  );
});

DomainConvergenceTable.displayName = 'AdminSystemDomainConvergenceTable';
