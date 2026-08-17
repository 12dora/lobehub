'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PlatformModuleId } from '@/const/platform/modules';

import type { ModuleRestartPhase } from './useAdminModules';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorWarningBg};
  `,
  text: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;

    min-width: 240px;
  `,
}));

export interface ModuleRestartBannerProps {
  canOperate: boolean;
  modules: PlatformModuleId[];
  onRestart: () => void;
  phase: ModuleRestartPhase;
  /** Why an in-place restart is not available (serverless / edge / no supervisor). */
  restartReason?: string;
  restartSupported: boolean;
}

/**
 * Reasons the server can return (`resolveRestartCapability`). They are internal enum tokens, so
 * they are translated here rather than printed — an operator reading `supervisor_not_configured`
 * learns nothing, and it is the one reason they can actually act on.
 */
const KNOWN_RESTART_REASONS = new Set([
  'edge_runtime',
  'serverless_runtime',
  'supervisor_not_configured',
  'test_runtime',
]);

/** Only the supervisor case is fixable by configuration; the others are the platform itself. */
const REASON_WITH_ENV_HINT = 'supervisor_not_configured';

/**
 * Shown while a saved change still holds resources this process allocated at boot.
 *
 * The switch already took effect for the API — this banner is only about reclaiming memory and
 * stopping workers, so it says exactly that instead of implying the change has not landed.
 * When the deployment cannot restart itself the button is replaced by the instruction that
 * actually works, never by a button that would kill the service.
 */
const ModuleRestartBanner = memo<ModuleRestartBannerProps>(
  ({ canOperate, modules, onRestart, phase, restartReason, restartSupported }) => {
    const { t } = useTranslation('admin');

    const reasonText = restartReason
      ? t(
          `modules.restart.reason.${
            KNOWN_RESTART_REASONS.has(restartReason) ? restartReason : 'unknown'
          }` as never,
        )
      : null;

    return (
      <div className={styles.root} role="status">
        <div className={styles.text}>
          <Text strong>{t('modules.restart.title', { n: modules.length })}</Text>
          <Text type="secondary">{t('modules.restart.desc')}</Text>
          {phase === 'failed' ? <Text type="danger">{t('modules.restart.failed')}</Text> : null}
          {phase === 'activated' ? <Text>{t('modules.restart.done')}</Text> : null}
        </div>
        {restartSupported ? (
          <Button
            disabled={!canOperate || phase === 'accepted'}
            loading={phase === 'accepted'}
            type="primary"
            onClick={onRestart}
          >
            {phase === 'accepted' ? t('modules.restart.waiting') : t('modules.restart.action')}
          </Button>
        ) : (
          <Flexbox gap={2} style={{ maxWidth: 320 }}>
            <Text type="secondary">
              {reasonText
                ? t('modules.restart.unsupportedBecause', { reason: reasonText })
                : t('modules.restart.unsupported')}
            </Text>
            {restartReason === REASON_WITH_ENV_HINT ? (
              <Text style={{ fontSize: 12 }} type="secondary">
                {t('modules.restart.envHint', { variable: 'PLATFORM_RESTART_MODE=supervisor' })}
              </Text>
            ) : null}
          </Flexbox>
        )}
      </div>
    );
  },
);

ModuleRestartBanner.displayName = 'AdminModuleRestartBanner';

export default ModuleRestartBanner;
