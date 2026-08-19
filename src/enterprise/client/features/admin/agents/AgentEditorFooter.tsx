'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { MODEL_BLOCKER, styles } from './agentEditorForm.styles';
import type { DependencyBlocker } from './dependencyEditorTypes';

export interface AgentEditorFooterProps {
  archived: boolean;
  blockers: DependencyBlocker[];
  canSubmit: boolean;
  conflict: boolean;
  error: string | null;
  missingRequirements: string[];
  onCancel?: () => void;
  saving: boolean;
  showMissing: boolean;
  submit: () => Promise<void> | void;
}

export const AgentEditorFooter = memo<AgentEditorFooterProps>(
  ({
    archived,
    blockers,
    canSubmit,
    conflict,
    error,
    missingRequirements,
    onCancel,
    saving,
    showMissing,
    submit,
  }) => {
    const { t } = useTranslation('admin');
    const visibleBlockers = blockers.filter((blocker) => blocker.message !== MODEL_BLOCKER);

    return (
      <div className={styles.footerRegion}>
        {conflict || error || showMissing || visibleBlockers.length > 0 ? (
          <div className={styles.status}>
            {conflict ? (
              <Alert
                showIcon
                message={t('agentCatalog.editor.conflict')}
                role={'alert'}
                type={'error'}
              />
            ) : null}
            {error ? (
              <Text role={'alert'} type={'danger'}>
                {error}
              </Text>
            ) : null}
            {/* One honest line for what Save is still waiting on, right where Save is. */}
            {showMissing ? (
              <Text type={'secondary'}>
                {t('agentCatalog.editor.missing.title', {
                  fields: missingRequirements.map((key) => t(key as never)).join(' · '),
                })}
              </Text>
            ) : null}
            {/* Why Save is unavailable, next to Save — the catalog that is blocking it may live
                in a collapsed group the admin never opened. */}
            {visibleBlockers.map((blocker) => (
              <Alert
                showIcon
                key={blocker.message}
                message={t(blocker.message as never)}
                role={'status'}
                type={'warning'}
                action={
                  blocker.retry ? (
                    <Button size={'small'} onClick={() => void blocker.retry?.()}>
                      {t('agentCatalog.dependency.retry')}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </div>
        ) : null}

        <div className={styles.footer}>
          <span className={styles.hint}>
            {t(
              archived
                ? 'agentCatalog.editor.effectHintArchived'
                : 'agentCatalog.editor.effectHint',
            )}
          </span>
          <div className={styles.footerActions}>
            <Button disabled={saving} onClick={onCancel}>
              {t('agentCatalog.editor.cancel')}
            </Button>
            <Button disabled={!canSubmit} type={'primary'} onClick={() => void submit()}>
              {saving ? t('agentCatalog.editor.saving') : t('agentCatalog.editor.save')}
            </Button>
          </div>
        </div>
      </div>
    );
  },
);

AgentEditorFooter.displayName = 'AgentEditorFooter';
