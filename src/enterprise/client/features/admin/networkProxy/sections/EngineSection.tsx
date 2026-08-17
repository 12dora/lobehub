'use client';

import { Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type {
  ArtifactState,
  ArtifactStatusView,
  InstanceStatusView,
  NetworkProxyArtifactKind,
  NetworkProxyConfigView,
} from '@/types/platform/networkProxy';

import DataTable from '../../primitives/DataTable';
import FieldStatus from '../FieldStatus';
import { formatDateTime, shortDigest, shortInstanceId } from '../format';
import { Field, Section } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import ArtifactUploadButton from './ArtifactUploadButton';
import EngineLogsDrawer from './EngineLogsDrawer';

export interface EngineSectionProps {
  actions: NetworkProxyActions;
  artifacts?: ArtifactStatusView;
  /** The artifact query failed with nothing cached — do not claim anything about install state. */
  artifactsUnknown?: boolean;
  canManage: boolean;
  config: NetworkProxyConfigView;
  instances: InstanceStatusView[];
  onReloadArtifacts: () => void;
  onReloadStatus: () => void;
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

const findArtifact = (
  artifacts: ArtifactState[] | undefined,
  kind: NetworkProxyArtifactKind,
): ArtifactState | undefined => artifacts?.find((item) => item.kind === kind);

/**
 * 引擎（插件）(design §6.1).
 *
 * The engine is installed after the fact, per instance. This block answers, in order: which
 * build are we allowed to run, is this platform supported, what does *this* instance have, and
 * what do the other live instances have.
 */
const EngineSection = memo<EngineSectionProps>(
  ({
    actions,
    artifacts,
    artifactsUnknown,
    canManage,
    config,
    instances,
    onReloadArtifacts,
    onReloadStatus,
    service,
    statusUnknown,
  }) => {
    const { t } = useTranslation('admin');
    const [logsOpen, setLogsOpen] = useState(false);

    const current = instances.find((instance) => instance.isCurrent) ?? instances[0];
    const supported = artifacts?.engine.supported ?? true;
    const smart = config.ruleMode === 'smart';

    const artifactKinds = useMemo<NetworkProxyArtifactKind[]>(() => {
      const kinds: NetworkProxyArtifactKind[] = ['engine'];
      const geodataInstalled = (['geoip', 'geosite'] as const).some(
        (kind) => findArtifact(current?.artifacts, kind)?.installed,
      );
      // Geodata only matters in smart mode — but keep it visible once installed so an admin can
      // see (and repair) what is on disk after switching back to simple.
      if (smart || geodataInstalled) kinds.push('geoip', 'geosite');
      return kinds;
    }, [current?.artifacts, smart]);

    /** The digest an operator can eyeball before uploading, for every artifact kind. */
    const expectedDigest = (kind: NetworkProxyArtifactKind): string | null =>
      kind === 'engine'
        ? (artifacts?.engine.binSha256 ?? null)
        : NETWORK_PROXY_ENGINE_MANIFEST.geodata.files[kind].sha256;

    const columns = useMemo<TableColumnsType<InstanceStatusView>>(
      () => [
        {
          dataIndex: 'instanceId',
          key: 'instanceId',
          render: (_: unknown, row) => (
            <span className={styles.code}>
              {shortInstanceId(row.instanceId)}
              {row.isCurrent ? ` (${t('networkProxy.engine.thisInstance')})` : ''}
            </span>
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
          key: 'appliedRevision',
          render: (_: unknown, row) => row.appliedRevision ?? '—',
          title: t('networkProxy.engine.columns.appliedRevision'),
        },
        {
          dataIndex: 'lastError',
          key: 'lastError',
          render: (_: unknown, row) =>
            row.lastError ? (
              <Text style={{ fontSize: 12 }} type="danger">
                {row.lastError}
              </Text>
            ) : (
              '—'
            ),
          title: t('networkProxy.engine.columns.lastError'),
        },
        {
          dataIndex: 'updatedAt',
          key: 'updatedAt',
          render: (_: unknown, row) => formatDateTime(row.updatedAt),
          title: t('networkProxy.engine.columns.updatedAt'),
        },
      ],
      [t],
    );

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

        <div className={styles.fieldGrid}>
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
        </div>

        <div className={styles.stack}>
          {artifactKinds.map((kind) => {
            const state = findArtifact(current?.artifacts, kind);
            const field = NETWORK_PROXY_FIELDS.install(kind);
            const digest = expectedDigest(kind);
            return (
              <div className={styles.toolbarRow} key={kind}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <Text strong style={{ fontSize: 13 }}>
                    {t(`networkProxy.artifactKind.${kind}` as never)}
                  </Text>
                  <span className={styles.hintText}>
                    {statusUnknown
                      ? t('networkProxy.engine.installStateUnknown')
                      : state?.installed
                        ? t('networkProxy.engine.installedAs', {
                            source: t(`networkProxy.artifactSource.${state.source ?? 'download'}`),
                            version: state.version ?? '—',
                          })
                        : t('networkProxy.engine.notInstalled')}
                  </span>
                  <span className={styles.hintText}>
                    {t('networkProxy.engine.expectedDigestLine', { sha: shortDigest(digest) })}
                  </span>
                  {state?.source === 'operator_override' ? (
                    <Text style={{ fontSize: 12 }} type="warning">
                      {t('networkProxy.engine.operatorOverride')}
                    </Text>
                  ) : null}
                  <FieldStatus
                    actions={actions}
                    field={field}
                    pendingLabel={t('networkProxy.engine.installing')}
                    successLabel={t('networkProxy.engine.installRequested')}
                  />
                </div>
                <div className={styles.inlineActions}>
                  <Button
                    disabled={!canManage || !supported || actions.isBusy(field)}
                    loading={actions.isBusy(field)}
                    size="small"
                    onClick={() => void actions.installArtifact(kind)}
                  >
                    {state?.installed
                      ? t('networkProxy.engine.reinstall')
                      : t('networkProxy.engine.download')}
                  </Button>
                  <ArtifactUploadButton
                    disabled={!canManage || !supported}
                    kind={kind}
                    service={service}
                    onInstalled={onReloadArtifacts}
                  />
                </div>
              </div>
            );
          })}
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
