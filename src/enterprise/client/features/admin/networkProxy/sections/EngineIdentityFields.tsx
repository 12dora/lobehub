'use client';

import { Tag, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type { ArtifactStatusView, InstanceStatusView } from '@/types/platform/networkProxy';

import { findArtifact } from '../engineArtifacts';
import { Field } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import { ENGINE_STATE_TAG_COLOR } from './engineInstanceTable';

export interface EngineIdentityFieldsProps {
  artifacts?: ArtifactStatusView;
  current?: InstanceStatusView;
  /** The status query failed with nothing cached — the current state is unknown, not absent. */
  statusUnknown?: boolean;
}

/** What this deployment runs: the build we are allowed to run, and what this instance has. */
const EngineIdentityFields = memo<EngineIdentityFieldsProps>(
  ({ artifacts, current, statusUnknown }) => {
    const { t } = useTranslation('admin');
    const engineArtifact = findArtifact(current?.artifacts, 'engine');

    return (
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
              <Tag color={ENGINE_STATE_TAG_COLOR[current.engineState] ?? 'default'} size="small">
                {t(`networkProxy.engineState.${current.engineState}` as never)}
              </Tag>
              {current.engineVersion ? (
                <span className={styles.code}>{current.engineVersion}</span>
              ) : null}
            </div>
          ) : (
            <span className={styles.hintText}>{t('networkProxy.engine.installStateUnknown')}</span>
          )}
        </Field>
        {engineArtifact?.source === 'operator_override' ? (
          <Text style={{ fontSize: 12 }} type="warning">
            {t('networkProxy.engine.operatorOverride')}
          </Text>
        ) : null}
      </div>
    );
  },
);

EngineIdentityFields.displayName = 'NetworkProxyEngineIdentityFields';

export default EngineIdentityFields;
