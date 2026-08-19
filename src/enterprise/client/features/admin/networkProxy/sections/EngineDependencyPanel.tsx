'use client';

import { Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { ExternalLink } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type {
  ArtifactState,
  ArtifactStatusView,
  InstanceStatusView,
  NetworkProxyArtifactKind,
} from '@/types/platform/networkProxy';

import {
  downloadUrl,
  expectedDigest,
  expectedGzDigest,
  findArtifact,
  GEODATA_KINDS,
} from '../engineArtifacts';
import FieldStatus from '../FieldStatus';
import { shortDigest } from '../format';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import ArtifactUploadButton from './ArtifactUploadButton';

export interface EngineDependencyPanelProps {
  actions: NetworkProxyActions;
  artifacts?: ArtifactStatusView;
  canManage: boolean;
  current?: InstanceStatusView;
  instances: InstanceStatusView[];
  onArtifactInstalled: () => void;
  service: AdminNetworkProxyService;
  statusUnknown?: boolean;
  supported: boolean;
}

export const EngineDependencyPanel = memo<EngineDependencyPanelProps>(
  ({
    actions,
    artifacts,
    canManage,
    current,
    instances,
    onArtifactInstalled,
    service,
    statusUnknown,
    supported,
  }) => {
    const { t } = useTranslation('admin');

    const engineArtifact = findArtifact(current?.artifacts, 'engine');
    const engineField = NETWORK_PROXY_FIELDS.install('engine');
    const geodataField = NETWORK_PROXY_FIELDS.installGeodata;
    const geodataBusy = actions.isBusy(geodataField);
    const geodataFailed = actions.entryOf(geodataField)?.status === 'error';

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
    const installAllBusy = geodataBusy || dependencyRows.some((row) => actions.isBusy(row.field));

    /** One click installs whatever is missing: the engine first, then both rule files. */
    const installAll = async () => {
      if (missingKinds.includes('engine')) await actions.installArtifact('engine');
      if (missingKinds.some((kind) => kind !== 'engine')) await actions.installGeodata();
    };

    return (
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
          <FieldStatus
            actions={actions}
            field={geodataField}
            pendingLabel={t('networkProxy.engine.geodata.installing')}
            successLabel={t('networkProxy.engine.geodata.installRequested')}
          />
        </div>

        {dependencyRows.map((row) => {
          const digest = expectedDigest(row.kind, artifacts);
          const url = downloadUrl(row.kind, artifacts);
          const busy = actions.isBusy(row.field);
          const isInstalled = Boolean(row.installed?.installed);
          const unverified = row.installed?.pinnedDigestMatch === false;
          return (
            <div className={styles.depRow} data-testid={`dependency-${row.kind}`} key={row.kind}>
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
                  expectedGzDigest={expectedGzDigest(row.kind, artifacts)}
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
    );
  },
);

EngineDependencyPanel.displayName = 'NetworkProxyEngineDependencyPanel';
