'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { adminSystemService } from '@/enterprise/client/services/adminSystem';

import { useAdminSystemStatus } from '../system/hooks/useAdminSystem';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  `,
  depRow: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 6px;
  `,
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  root: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  step: css`
    display: flex;
    flex: 1 1 160px;
    gap: 8px;
    align-items: center;

    padding-block: 10px;
    padding-inline: 12px;
    border-radius: ${cssVar.borderRadiusLG};

    color: ${cssVar.colorTextTertiary};

    background: ${cssVar.colorFillQuaternary};

    &[data-active='true'] {
      color: ${cssVar.colorPrimaryText};
      background: ${cssVar.colorPrimaryBg};
    }

    &[data-done='true'] {
      color: ${cssVar.colorSuccessText};
    }
  `,
  steps: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
}));

export type ModuleWizardStep = 1 | 2 | 3;

export interface ModuleWizardProps {
  canOperate: boolean;
  /** Leave the wizard without marking setup complete ("稍后再说"). */
  onExit: () => void;
  onFinish: () => void;
  onStepChange: (step: ModuleWizardStep) => void;
  saving: boolean;
  setupCompletedAt: string | null;
  step: ModuleWizardStep;
}

const DEPENDENCY_KEYS = ['database', 'objectStorage', 'redis', 'mail', 'keyManagement'] as const;

/**
 * First-run header for the modules page: pick modules → check the infrastructure they need →
 * done. Step 2 only *reports* the system-status probes (it never changes anything), because at
 * this point the operator's real question is "will what I just switched on actually work".
 */
const ModuleWizard = memo<ModuleWizardProps>(
  ({ canOperate, onExit, onFinish, onStepChange, saving, setupCompletedAt, step }) => {
    const { t } = useTranslation('admin');
    const statusSWR = useAdminSystemStatus(step === 2, adminSystemService);
    // Only a probe still in flight holds the wizard back; a failed one does not.
    const infraLoading = !statusSWR.data && !statusSWR.error;

    return (
      <div className={styles.root}>
        <div className={styles.steps}>
          {([1, 2, 3] as const).map((value) => (
            <div
              className={styles.step}
              data-active={step === value}
              data-done={step > value}
              key={value}
            >
              <Text strong>{value}</Text>
              <Text>{t(`modules.wizard.step${value}` as never)}</Text>
            </div>
          ))}
        </div>

        {step === 2 ? (
          <div className={styles.panel}>
            <Text strong>{t('modules.wizard.infraTitle')}</Text>
            <Text type="secondary">{t('modules.wizard.infraDesc')}</Text>
            {/* Error first: with an unreachable status endpoint there is no data and no loading
                flag left to distinguish, so checking `data` alone spins forever. A failed probe
                also must not trap the operator — the check is advisory, so offer both a retry
                and a way past it. */}
            {statusSWR.error && !statusSWR.data ? (
              <Flexbox gap={8}>
                <Text type="danger">{t('modules.wizard.infraFailed')}</Text>
                <Text style={{ fontSize: 12 }} type="secondary">
                  {t('modules.wizard.infraFailedHint')}
                </Text>
                <div>
                  <Button size="small" onClick={() => void statusSWR.mutate()}>
                    {t('access.error.retry')}
                  </Button>
                </div>
              </Flexbox>
            ) : statusSWR.data ? (
              DEPENDENCY_KEYS.map((key) => {
                const health = statusSWR.data?.dependencies[key];
                return (
                  <div className={styles.depRow} key={key}>
                    <Text>{t(`system.dependencies.${key}` as never, { defaultValue: key })}</Text>
                    <Text type={health?.status === 'healthy' ? 'success' : 'warning'}>
                      {t(
                        health?.status === 'healthy'
                          ? 'modules.wizard.infraHealthy'
                          : 'modules.wizard.infraUnavailable',
                      )}
                    </Text>
                  </div>
                );
              })
            ) : (
              <Text role="status" type="secondary">
                {t('access.loading')}
              </Text>
            )}
            <Link to="/admin/system/status">{t('modules.wizard.infraLink')}</Link>
          </div>
        ) : null}

        {step === 3 ? (
          <div className={styles.panel}>
            <Text strong>{t('modules.wizard.finishTitle')}</Text>
            <Text type="secondary">{t('modules.wizard.finishDesc')}</Text>
          </div>
        ) : null}

        <div className={styles.actions}>
          <Button size="small" type="text" onClick={onExit}>
            {t('modules.wizard.later')}
          </Button>
          {step > 1 ? (
            <Button size="small" onClick={() => onStepChange((step - 1) as ModuleWizardStep)}>
              {t('modules.wizard.back')}
            </Button>
          ) : null}
          {step < 3 ? (
            <Button
              disabled={step === 2 && infraLoading}
              size="small"
              type="primary"
              onClick={() => onStepChange((step + 1) as ModuleWizardStep)}
            >
              {t('modules.wizard.next')}
            </Button>
          ) : (
            <Button
              disabled={!canOperate || Boolean(setupCompletedAt)}
              loading={saving}
              size="small"
              type="primary"
              onClick={onFinish}
            >
              {t('modules.wizard.finish')}
            </Button>
          )}
        </div>
      </div>
    );
  },
);

ModuleWizard.displayName = 'AdminModuleWizard';

export default ModuleWizard;
