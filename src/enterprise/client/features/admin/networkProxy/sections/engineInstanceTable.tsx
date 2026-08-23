'use client';

import { Tag, Text, Tooltip } from '@lobehub/ui';
import type { TableColumnsType } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { EngineIssue, InstanceStatusView } from '@/types/platform/networkProxy';

import { networkProxyIssueKey } from '../errors';
import { formatDateTime, shortInstanceId } from '../format';
import { networkProxyStyles as styles } from '../styles';

export const ENGINE_STATE_TAG_COLOR: Record<string, 'default' | 'success' | 'warning' | 'error'> = {
  degraded: 'warning',
  error: 'error',
  installing: 'warning',
  not_installed: 'default',
  running: 'success',
  starting: 'warning',
  stopped: 'default',
  unsupported: 'error',
};

/** A server that predates the engine-issue model has no `lastIssue` on the row. */
export const issueOf = (instance: InstanceStatusView): EngineIssue | null =>
  instance.lastIssue ?? null;

/** The 实例 table: one row per instance, answering what it runs and whether it caught up. */
export const useEngineInstanceColumns = (
  /** Settings revision every instance is expected to converge on. */
  revision: number,
): TableColumnsType<InstanceStatusView> => {
  const { t } = useTranslation('admin');

  return useMemo<TableColumnsType<InstanceStatusView>>(
    () => [
      {
        dataIndex: 'instanceId',
        key: 'instanceId',
        // The current instance is named, never identified by its opaque id; other
        // instances (multi-node deployments only) fall back to the shortened id.
        render: (_: unknown, row) =>
          row.isCurrent ? (
            <span>{t('networkProxy.engine.thisInstance')}</span>
          ) : (
            <span className={styles.code}>{shortInstanceId(row.instanceId)}</span>
          ),
        title: t('networkProxy.engine.columns.instance'),
      },
      {
        dataIndex: 'engineState',
        key: 'engineState',
        render: (_: unknown, row) => (
          <Tag color={ENGINE_STATE_TAG_COLOR[row.engineState] ?? 'default'} size="small">
            {t(`networkProxy.engineState.${row.engineState}` as never)}
          </Tag>
        ),
        title: t('networkProxy.engine.columns.state'),
      },
      {
        dataIndex: 'engineVersion',
        key: 'engineVersion',
        render: (_: unknown, row) => row.engineVersion ?? '—',
        title: t('networkProxy.engine.columns.version'),
      },
      {
        dataIndex: 'appliedRevision',
        // A revision number tells an admin nothing; whether this instance is on the current
        // configuration is the only thing the column is asked.
        key: 'appliedRevision',
        render: (_: unknown, row) => {
          if (row.appliedRevision === null) return '—';
          const synced = row.appliedRevision === revision;
          return (
            <Tag color={synced ? 'success' : 'warning'} size="small">
              {t(synced ? 'networkProxy.engine.configSynced' : 'networkProxy.engine.configPending')}
            </Tag>
          );
        },
        title: t('networkProxy.engine.columns.appliedRevision'),
      },
      {
        dataIndex: 'lastIssue',
        key: 'lastIssue',
        // The engine reports a code; the raw text behind it is technical detail, not copy.
        render: (_: unknown, row) => {
          const issue = issueOf(row);
          if (!issue) return '—';
          const label = (
            <Text style={{ fontSize: 12 }} type="danger">
              {t(networkProxyIssueKey(issue.code) as never)}
            </Text>
          );
          return issue.detail ? <Tooltip title={issue.detail}>{label}</Tooltip> : label;
        },
        title: t('networkProxy.engine.columns.lastIssue'),
      },
      {
        dataIndex: 'updatedAt',
        key: 'updatedAt',
        render: (_: unknown, row) => formatDateTime(row.updatedAt),
        title: t('networkProxy.engine.columns.updatedAt'),
      },
    ],
    [revision, t],
  );
};
