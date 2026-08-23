'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type { ArtifactStatusView, InstanceStatusView } from '@/types/platform/networkProxy';

import DataTable from '../../primitives/DataTable';
import FieldStatus from '../FieldStatus';
import { Section } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { NETWORK_PROXY_FIELDS, type NetworkProxyActions } from '../useNetworkProxyActions';
import { EngineDependencyPanel } from './EngineDependencyPanel';
import EngineIdentityFields from './EngineIdentityFields';
import { useEngineInstanceColumns } from './engineInstanceTable';
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
    const supported = artifacts?.engine.supported ?? true;
    const columns = useEngineInstanceColumns(revision);

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
          <EngineIdentityFields
            artifacts={artifacts}
            current={current}
            statusUnknown={statusUnknown}
          />

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
