'use client';

import { Tag, Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type {
  ArtifactStatusView,
  EngineIssue,
  InstanceStatusView,
} from '@/types/platform/networkProxy';

import DataTable from '../../primitives/DataTable';
import { findArtifact } from '../engineArtifacts';
import { networkProxyIssueKey } from '../errors';
import FieldStatus from '../FieldStatus';
import { formatDateTime, shortInstanceId } from '../format';
import { Field, Section } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import { EngineDependencyPanel } from './EngineDependencyPanel';
import EngineLogsDrawer from './EngineLogsDrawer';

export interface EngineSectionProps {
  actions: NetworkProxyActions;
  artifacts?: ArtifactStatusView;
  /** The artifact query failed with nothing cached — do not claim anything about install state. */
  artifactsUnknown?: boolean;
  canManage: boolean;
  instances: InstanceStatusView[];
  onReloadArtifacts: () => void;
  onReloadStatus: () => void;
  /** Settings revision every instance is expected to converge on. */
  revision: number;
  service: AdminNetworkProxyService;
  /** The status query failed with nothing cached — the instances table is unknown, not empty. */
  statusUnknown?: boolean;
}

const ENGINE_STATE_TAG_COLOR: Record<string, 'default' | 'success' | 'warning' | 'error'> = {
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
const issueOf = (instance: InstanceStatusView): EngineIssue | null => instance.lastIssue ?? null;

/**
 * 引擎（插件）(design §6.1).
 *
 * The engine is installed after the fact, per instance. This block answers, in order: which
 * build are we allowed to run, is this platform supported, what does *this* instance have, and
 * what do the other live instances have.
 *
 * The smart-routing rule data is always offered here, whatever the current routing mode: it used
 * to appear only once smart mode was on, and smart mode could not be turned on until it was
 * installed — a fresh deployment had no way in at all.
 */
const EngineSection = memo<EngineSectionProps>(
  ({
    actions,
    artifacts,
    artifactsUnknown,
    canManage,
    instances,
    onReloadArtifacts,
    onReloadStatus,
    revision,
    service,
    statusUnknown,
  }) => {
    const { t } = useTranslation('admin');
    const [logsOpen, setLogsOpen] = useState(false);

    const current = instances.find((instance) => instance.isCurrent) ?? instances[0];
    const engineArtifact = findArtifact(current?.artifacts, 'engine');
    const supported = artifacts?.engine.supported ?? true;

    const columns = useMemo<TableColumnsType<InstanceStatusView>>(
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
                {t(
                  synced ? 'networkProxy.engine.configSynced' : 'networkProxy.engine.configPending',
                )}
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

    /** Both artifact catalogue and instance status describe an install; refresh both. */
    const onArtifactInstalled = () => {
      onReloadArtifacts();
      onReloadStatus();
    };

    return (
      <Section
        description={t('networkProxy.engine.desc')}
        title={t('networkProxy.engine.title')}
        actions={
          <>
            <Button size="small" onClick={() => setLogsOpen(true)}>
              {t('networkProxy.engine.viewLogs')}
            </Button>
            <Button
              disabled={!canManage || actions.isBusy(NETWORK_PROXY_FIELDS.restart)}
              loading={actions.isBusy(NETWORK_PROXY_FIELDS.restart)}
              size="small"
              onClick={() => void actions.restartEngine()}
            >
              {t('networkProxy.engine.restart')}
            </Button>
          </>
        }
      >
        {/* The page-level banner already explains an unsupported platform; here we only say why
            the install buttons are disabled. */}
        {!supported ? (
          <Text className={styles.hintText}>{t('networkProxy.engine.unsupportedHint')}</Text>
        ) : null}

        {/* Restart is a long task: its outcome stays next to the button, not in a toast. */}
        <FieldStatus
          actions={actions}
          field={NETWORK_PROXY_FIELDS.restart}
          pendingLabel={t('networkProxy.engine.restarting')}
          successLabel={t('networkProxy.engine.restartRequested')}
        />

        <div className={styles.splitRow}>
          {/* Left: what this deployment runs. */}
          <div className={styles.stack}>
            <Field
              hint={t('networkProxy.engine.pinnedVersionHint')}
              label={t('networkProxy.engine.pinnedVersion')}
            >
              <span className={styles.code}>
                {artifacts?.engine.version ?? NETWORK_PROXY_ENGINE_MANIFEST.version}
              </span>
            </Field>
            <Field label={t('networkProxy.engine.platform')}>
              <span className={styles.code}>
                {artifacts?.engine.platformKey ??
                  (current ? `${current.platform}/${current.arch}` : '—')}
              </span>
            </Field>
            <Field label={t('networkProxy.engine.currentState')}>
              {current && !statusUnknown ? (
                <div className={styles.badgeRow}>
                  <Tag
                    color={ENGINE_STATE_TAG_COLOR[current.engineState] ?? 'default'}
                    size="small"
                  >
                    {t(`networkProxy.engineState.${current.engineState}` as never)}
                  </Tag>
                  {current.engineVersion ? (
                    <span className={styles.code}>{current.engineVersion}</span>
                  ) : null}
                </div>
              ) : (
                <span className={styles.hintText}>
                  {t('networkProxy.engine.installStateUnknown')}
                </span>
              )}
            </Field>
            {engineArtifact?.source === 'operator_override' ? (
              <Text style={{ fontSize: 12 }} type="warning">
                {t('networkProxy.engine.operatorOverride')}
              </Text>
            ) : null}
          </div>

          {/* Right: dependencies and how to install them. */}
          <EngineDependencyPanel
            actions={actions}
            artifacts={artifacts}
            canManage={canManage}
            current={current}
            instances={instances}
            service={service}
            statusUnknown={statusUnknown}
            supported={supported}
            onArtifactInstalled={onArtifactInstalled}
          />
        </div>

        <div className={styles.stack}>
          <Text className={styles.tableCaption}>{t('networkProxy.engine.instancesCaption')}</Text>
          <DataTable<InstanceStatusView>
            columns={columns}
            dataSource={instances}
            error={statusUnknown}
            pagination={false}
            rowKey="instanceId"
            size="small"
            emptyDescription={
              statusUnknown
                ? t('networkProxy.engine.instancesUnknown')
                : t('networkProxy.engine.instancesEmpty')
            }
            onRetry={onReloadStatus}
          />
          {artifactsUnknown ? (
            <Text className={styles.hintText}>
              {t('networkProxy.engine.artifactCatalogUnknown')}
            </Text>
          ) : null}
        </div>

        <EngineLogsDrawer open={logsOpen} service={service} onClose={() => setLogsOpen(false)} />
      </Section>
    );
  },
);

EngineSection.displayName = 'NetworkProxyEngineSection';

export default EngineSection;
