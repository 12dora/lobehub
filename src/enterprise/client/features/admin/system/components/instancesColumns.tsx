'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import type { TFunction } from 'i18next';

import { enumColumnFilter } from '@/enterprise/client/features/admin/primitives/columnFilters';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import type { AdminSystemInstanceRevisions } from '@/enterprise/client/services/adminSystem';

type Instance = AdminSystemInstanceRevisions['items'][number];

export const INSTANCE_STATUS = {
  all: 'all',
  offline: 'offline',
  online: 'online',
} as const;

export type InstanceStatusFilter = (typeof INSTANCE_STATUS)[keyof typeof INSTANCE_STATUS];

/** Registry ids carry 48 hex chars of process entropy; the first 8 already disambiguate a row. */
const shortInstanceId = (instanceId: string) =>
  instanceId.replace(/^(?:oidci_|pinst_)/, '').slice(0, 8);

const styles = createStaticStyles(({ css }) => ({
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    font-variant-numeric: tabular-nums;
  `,
}));

export interface BuildInstancesColumnsParams {
  statusFilter: InstanceStatusFilter;
  t: TFunction<'admin'>;
}

export const buildInstancesColumns = ({
  statusFilter,
  t,
}: BuildInstancesColumnsParams): TableColumnsType<Instance> => [
  {
    key: 'instance',
    render: (_, instance) => (
      <Flexbox gap={2}>
        <Text>{t(`system.values.instanceKind.${instance.instanceKind}` as never)}</Text>
        <Text className={styles.code} type="secondary">
          {shortInstanceId(instance.instanceId)}
        </Text>
      </Flexbox>
    ),
    title: t('system.instances.columns.instance'),
  },
  {
    key: 'health',
    render: (_, instance) => (
      <Flexbox horizontal gap={8} wrap="wrap">
        <Tag color={instance.fresh ? 'success' : 'default'} size="small">
          {t(instance.fresh ? 'system.instances.fresh' : 'system.instances.stale')}
        </Tag>
        {/* An offline process can never act on a restart, so the badge would be noise. */}
        {instance.fresh && instance.pendingRestart ? (
          <Tag color="warning" size="small">
            {t('system.instances.pendingRestart')}
          </Tag>
        ) : null}
      </Flexbox>
    ),
    title: t('system.instances.columns.health'),
    width: 200,
    ...enumColumnFilter({
      options: [
        { label: t('system.instances.fresh'), value: INSTANCE_STATUS.online },
        { label: t('system.instances.stale'), value: INSTANCE_STATUS.offline },
        { label: t('system.instances.filter.all'), value: INSTANCE_STATUS.all },
      ],
      value: statusFilter,
    }),
  },
  {
    dataIndex: 'startedAt',
    key: 'startedAt',
    render: (value: Date) => <Text className={styles.code}>{formatAdminDateTime(value)}</Text>,
    title: t('system.instances.columns.startedAt'),
    width: 200,
  },
  {
    dataIndex: 'lastHeartbeatAt',
    key: 'lastHeartbeatAt',
    render: (value: Date) => <Text className={styles.code}>{formatAdminDateTime(value)}</Text>,
    title: t('system.instances.columns.heartbeat'),
    width: 200,
  },
];
