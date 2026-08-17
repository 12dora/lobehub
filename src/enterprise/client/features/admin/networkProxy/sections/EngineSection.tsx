'use client';

import { Tag, Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { ExternalLink } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type {
  ArtifactState,
  ArtifactStatusView,
  EngineIssue,
  InstanceStatusView,
  NetworkProxyArtifactKind,
} from '@/types/platform/networkProxy';

import DataTable from '../../primitives/DataTable';
import { networkProxyIssueKey } from '../errors';
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

/** The two files smart routing needs; they are installed and shown as one thing. */
const GEODATA_KINDS = ['geoip', 'geosite'] as const;

const findArtifact = (
  artifacts: ArtifactState[] | undefined,
  kind: NetworkProxyArtifactKind,
): ArtifactState | undefined => artifacts?.find((item) => item.kind === kind);

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
    const engineField = NETWORK_PROXY_FIELDS.install('engine');
    const supported = artifacts?.engine.supported ?? true;
    const geodataField = NETWORK_PROXY_FIELDS.installGeodata;
    const geodataBusy = actions.isBusy(geodataField);
    const geodataFailed = actions.entryOf(geodataField)?.status === 'error';

    /** The digest an operator can eyeball before uploading, for every artifact kind. */
    const expectedDigest = (kind: NetworkProxyArtifactKind): string | null =>
      kind === 'engine'
        ? (artifacts?.engine.binSha256 ?? null)
        : NETWORK_PROXY_ENGINE_MANIFEST.geodata.files[kind].sha256;

    /** Install state of one rule file on this instance, in the four words that matter. */
    const geodataState = (kind: NetworkProxyArtifactKind): string => {
      if (statusUnknown) return t('networkProxy.engine.installStateUnknown');
      if (geodataBusy) return t('networkProxy.engine.geodata.stateInstalling');
      if (findArtifact(current?.artifacts, kind)?.installed)
        return t('networkProxy.engine.geodata.stateInstalled');
      if (geodataFailed) return t('networkProxy.engine.geodata.stateFailed');
      return t('networkProxy.engine.geodata.stateMissing');
    };

    /** How far the fleet has got — only worth saying when there is more than one node. */
    const geodataCoverage = (kind: NetworkProxyArtifactKind): string | null => {
      if (instances.length <= 1 || statusUnknown) return null;
      const installed = instances.filter(
        (instance) => findArtifact(instance.artifacts, kind)?.installed,
      ).length;
      return t('networkProxy.engine.geodata.installedOn', {
        installed,
        total: instances.length,
      });
    };

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

    /** Official file the operator can fetch by hand when the server cannot reach the host. */
    const downloadUrl = (kind: NetworkProxyArtifactKind): string | null => {
      if (kind === 'engine') {
        const asset =
          artifacts?.engine.expectedAsset ??
          (artifacts?.engine.platformKey
            ? NETWORK_PROXY_ENGINE_MANIFEST.assets[
                artifacts.engine.platformKey as keyof typeof NETWORK_PROXY_ENGINE_MANIFEST.assets
              ]?.asset
            : null);
        if (!asset) return null;
        return `${NETWORK_PROXY_ENGINE_MANIFEST.baseUrl}/${artifacts?.engine.version ?? NETWORK_PROXY_ENGINE_MANIFEST.version}/${asset}`;
      }
      const { baseUrl, commit, files } = NETWORK_PROXY_ENGINE_MANIFEST.geodata;
      return `${baseUrl}/${commit}/${files[kind].file}`;
    };

    /** gzip digest of the engine release asset — what a hand-downloaded file hashes to. */
    const expectedGzDigest = (kind: NetworkProxyArtifactKind): string | null => {
      if (kind !== 'engine' || !artifacts?.engine.platformKey) return null;
      return (
        NETWORK_PROXY_ENGINE_MANIFEST.assets[
          artifacts.engine.platformKey as keyof typeof NETWORK_PROXY_ENGINE_MANIFEST.assets
        ]?.gzSha256 ?? null
      );
    };

    const dependencyRows: {
      field: string;
      installed: ArtifactState | undefined;
      kind: NetworkProxyArtifactKind;
      stateText: string;
    }[] = [
      {
        field: engineField,
        installed: engineArtifact,
        kind: 'engine',
        stateText: statusUnknown
          ? t('networkProxy.engine.installStateUnknown')
          : engineArtifact?.installed
            ? t('networkProxy.engine.installedAs', {
                source: t(`networkProxy.artifactSource.${engineArtifact.source ?? 'download'}`),
                version: engineArtifact.version ?? '—',
              })
            : t('networkProxy.engine.notInstalled'),
      },
      ...GEODATA_KINDS.map((kind) => ({
        field: NETWORK_PROXY_FIELDS.install(kind),
        installed: findArtifact(current?.artifacts, kind),
        kind,
        stateText: geodataState(kind),
      })),
    ];

    // With no status at all we cannot say what is missing — do not offer to (re)install anything.
    const missingKinds = statusUnknown
      ? []
      : dependencyRows.filter((row) => !row.installed?.installed).map((row) => row.kind);
    const actionsLocked = !canManage || !supported || Boolean(statusUnknown);
    /** Both artifact catalogue and instance status describe an install; refresh both. */
    const onArtifactInstalled = () => {
      onReloadArtifacts();
      onReloadStatus();
    };
    const installAllBusy = geodataBusy || dependencyRows.some((row) => actions.isBusy(row.field));

    /** One click installs whatever is missing: the engine first, then both rule files. */
    const installAll = async () => {
      if (missingKinds.includes('engine')) await actions.installArtifact('engine');
      if (missingKinds.some((kind) => kind !== 'engine')) await actions.installGeodata();
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
          <div className={styles.depsPanel} data-testid="engine-dependencies">
            <div className={styles.depMeta} style={{ paddingBlock: 4 }}>
              <div className={styles.toolbarRow}>
                <Text strong style={{ fontSize: 13 }}>
                  {t('networkProxy.engine.deps.title')}
                </Text>
                <Button
                  disabled={actionsLocked || installAllBusy || missingKinds.length === 0}
                  loading={installAllBusy}
                  size="small"
                  type="primary"
                  onClick={() => void installAll()}
                >
                  {missingKinds.length === 0 && !statusUnknown
                    ? t('networkProxy.engine.deps.allInstalled')
                    : t('networkProxy.engine.deps.installAll')}
                </Button>
              </div>
              <span className={styles.hintText}>{t('networkProxy.engine.deps.desc')}</span>
              <FieldStatus
                actions={actions}
                field={geodataField}
                pendingLabel={t('networkProxy.engine.geodata.installing')}
                successLabel={t('networkProxy.engine.geodata.installRequested')}
              />
            </div>

            {dependencyRows.map((row) => {
              const digest = expectedDigest(row.kind);
              const url = downloadUrl(row.kind);
              const busy = actions.isBusy(row.field);
              const isInstalled = Boolean(row.installed?.installed);
              const unverified = row.installed?.pinnedDigestMatch === false;
              return (
                <div
                  className={styles.depRow}
                  data-testid={`dependency-${row.kind}`}
                  key={row.kind}
                >
                  <div className={styles.depMeta}>
                    <div className={styles.depTitleRow}>
                      <Text strong style={{ fontSize: 13 }}>
                        {t(`networkProxy.artifactKind.${row.kind}` as never)}
                      </Text>
                      {digest ? (
                        <Tooltip title={digest}>
                          <span className={styles.hintText}>
                            <span className={styles.code}>SHA-256 {shortDigest(digest)}</span>
                          </span>
                        </Tooltip>
                      ) : null}
                    </div>
                    <span className={styles.hintText}>{row.stateText}</span>
                    {row.kind !== 'engine' && geodataCoverage(row.kind) ? (
                      <span className={styles.hintText}>{geodataCoverage(row.kind)}</span>
                    ) : null}
                    {unverified ? (
                      <Text style={{ fontSize: 12 }} type="warning">
                        {t('networkProxy.engine.digestMismatch.installed')}
                      </Text>
                    ) : null}
                    <FieldStatus
                      actions={actions}
                      field={row.field}
                      pendingLabel={t('networkProxy.engine.installing')}
                      successLabel={t('networkProxy.engine.installRequested')}
                    />
                  </div>
                  <div className={styles.inlineActions}>
                    {url ? (
                      <Button
                        icon={<ExternalLink size={14} />}
                        size="small"
                        title={url}
                        onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                      >
                        {t('networkProxy.engine.downloadFile')}
                      </Button>
                    ) : null}
                    {/* Manual upload is the no-network path; once installed there is nothing to upload. */}
                    <ArtifactUploadButton
                      disabled={actionsLocked || isInstalled}
                      expectedDigest={digest}
                      expectedGzDigest={expectedGzDigest(row.kind)}
                      kind={row.kind}
                      service={service}
                      onInstalled={onArtifactInstalled}
                    />
                    <Button
                      disabled={actionsLocked || busy || installAllBusy}
                      loading={busy}
                      size="small"
                      onClick={() => void actions.installArtifact(row.kind)}
                    >
                      {isInstalled
                        ? t('networkProxy.engine.reinstall')
                        : t('networkProxy.engine.download')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
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
