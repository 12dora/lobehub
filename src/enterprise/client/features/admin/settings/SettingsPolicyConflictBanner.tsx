'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import type { ConflictState } from './conflictStateMachine';
import { formatSettingValue } from './policyPresentation';

const styles = createStaticStyles(({ css }) => ({
  conflictActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-block-start: 8px;
  `,
  conflictGrid: css`
    display: grid;
    grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr);
    gap: 8px 16px;
    margin-block-start: 8px;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
}));

export interface SettingsPolicyConflictBannerProps {
  canUpdate: boolean;
  conflictState: ConflictState;
  onDiscard: () => void;
  onRebase: () => void;
  onRefresh: () => void;
  registryByPath: Map<string, AdminSettingsGetDraftOutput['registry'][number]>;
}

const SettingsPolicyConflictBanner = memo<SettingsPolicyConflictBannerProps>(
  ({ canUpdate, conflictState, onDiscard, onRebase, onRefresh, registryByPath }) => {
    const { t } = useTranslation('admin');

    return (
      <Alert
        showIcon
        closable={false}
        message={t('settingsPolicy.conflict.title')}
        type="warning"
        description={
          <div>
            {conflictState.phase === 'conflict' ? (
              <>
                <Text as="div" type="secondary">
                  {t('settingsPolicy.conflict.revisions', {
                    local: conflictState.localBaseRevision,
                    server: conflictState.serverBaseRevision,
                  })}
                </Text>
                {conflictState.conflictingPaths.length > 0 ? (
                  <div className={styles.conflictGrid}>
                    {conflictState.conflictingPaths.map((path) => {
                      const entry = registryByPath.get(path);
                      if (!entry) return <Text key={path}>{path}</Text>;
                      return (
                        <div key={path} style={{ gridColumn: '1 / -1' }}>
                          <Text strong>{t(entry.titleKey as never, { defaultValue: path })}</Text>
                          <div className={styles.conflictGrid}>
                            <Text type="secondary">
                              {t('settingsPolicy.conflict.localValue', {
                                value: formatSettingValue({
                                  entry,
                                  t,
                                  value: conflictState.localDraft[path]?.value,
                                }),
                              })}
                            </Text>
                            <Text type="secondary">
                              {t('settingsPolicy.conflict.serverValue', {
                                value: formatSettingValue({
                                  entry,
                                  t,
                                  value: conflictState.serverDraft[path]?.value,
                                }),
                              })}
                            </Text>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <Text as="div" type="secondary">
                    {t('settingsPolicy.conflict.noCollisions')}
                  </Text>
                )}
                <div className={styles.conflictActions}>
                  <Button onClick={() => void onRefresh()}>
                    {t('settingsPolicy.conflict.refresh')}
                  </Button>
                  {canUpdate ? (
                    <Button type="primary" onClick={onRebase}>
                      {t('settingsPolicy.conflict.rebase')}
                    </Button>
                  ) : null}
                  <Button onClick={onDiscard}>{t('settingsPolicy.conflict.discard')}</Button>
                </div>
              </>
            ) : (
              <>
                <Text as="div" type="secondary">
                  {t(
                    conflictState.phase === 'awaitingServer'
                      ? 'settingsPolicy.conflict.awaitingServer'
                      : 'settingsPolicy.conflict.latestUnavailable',
                  )}
                </Text>
                <div className={styles.conflictActions}>
                  <Button
                    disabled={conflictState.phase === 'awaitingServer'}
                    loading={conflictState.phase === 'awaitingServer'}
                    onClick={() => void onRefresh()}
                  >
                    {t('settingsPolicy.conflict.retryRefresh')}
                  </Button>
                </div>
              </>
            )}
          </div>
        }
      />
    );
  },
);

SettingsPolicyConflictBanner.displayName = 'SettingsPolicyConflictBanner';

export default SettingsPolicyConflictBanner;
