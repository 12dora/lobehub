'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import {
  ALL_MODULES_ENABLED,
  type PlatformModuleId,
  type PlatformModulePreset,
  type PlatformModuleStateMap,
} from '@/const/platform/modules';
import { deriveAdminSystemPermissions } from '@/enterprise/client/features/admin/system/controller';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminModulesService } from '@/enterprise/client/services/adminModules';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { openDangerConfirm } from '../primitives/DangerConfirm';
import { runAdminMutation } from '../primitives/runAdminMutation';
import {
  applyPresetToDraft,
  diffModuleDraft,
  draftPreset,
  draftToUpdatePayload,
  setModuleInDraft,
} from './moduleDraft';
import ModuleGroupList, { CoreModulesFooter } from './ModuleGroupList';
import ModulePresetRow from './ModulePresetRow';
import ModuleRestartBanner from './ModuleRestartBanner';
import ModuleSummaryBar from './ModuleSummaryBar';
import ModuleWizard, { type ModuleWizardStep } from './ModuleWizard';
import { dismissSetupGuide } from './setupGuideDismissal';
import {
  isModuleRevisionConflict,
  refreshAdminModules,
  useAdminModules,
  useModuleRestart,
} from './useAdminModules';

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: flex-end;

    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowTertiary};
  `,
  footerText: css`
    flex: 1;
    min-width: 200px;
  `,
  skeleton: css`
    height: 96px;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};
  `,
}));

/** Compliance modules whose removal stops evidence collection — always confirmed explicitly. */
const CONFIRM_ON_DISABLE: readonly PlatformModuleId[] = ['audit', 'moderation'];

/**
 * `/admin/system/modules` — the deployment's module switches, and the first-run guide.
 *
 * One surface serves both: with `?wizard=1` it gains a three-step header, otherwise it is the
 * ordinary settings page. Splitting them would mean two places to keep true (DESIGN.md:
 * layered, not split), and the wizard's real content is this page anyway.
 */
const ModulesPage = memo(() => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions, status } = useAdminAccess();
  const { canOperate, canRead } = deriveAdminSystemPermissions(permissions);
  const [params, setParams] = useSearchParams();

  const enabled = status === 'allowed' && canRead;
  const { data, error, isLoading, mutate } = useAdminModules(enabled);
  const restart = useModuleRestart();

  const [draft, setDraft] = useState<PlatformModuleStateMap | null>(null);
  const [saving, setSaving] = useState(false);
  const [wizardStep, setWizardStep] = useState<ModuleWizardStep>(1);

  const effective = data?.snapshot.effective ?? ALL_MODULES_ENABLED;
  const current = draft ?? effective;
  const diff = useMemo(() => diffModuleDraft(effective, current), [current, effective]);
  const preset = useMemo(() => draftPreset(current), [current]);

  const wizard = params.get('wizard') === '1';

  const onToggle = useCallback(
    (id: PlatformModuleId, next: boolean) => {
      setDraft((previous) => setModuleInDraft(previous ?? effective, id, next));
    },
    [effective],
  );

  const onSelectPreset = useCallback(
    (next: PlatformModulePreset) => {
      setDraft(applyPresetToDraft(next, data?.snapshot.envDisabled ?? []));
    },
    [data?.snapshot.envDisabled],
  );

  const commit = useCallback(
    async (next: PlatformModuleStateMap, setupCompleted?: boolean) => {
      if (!data) return;
      setSaving(true);
      const changed = diffModuleDraft(effective, next);
      let failure: unknown;
      const ok = await runAdminMutation({
        authMethod,
        mapErrorKey: (error) =>
          isModuleRevisionConflict(error) ? 'modules.errors.conflict' : 'modules.errors.saveFailed',
        run: async () => {
          try {
            const updated = await adminModulesService.update({
              expectedRevision: data.snapshot.revision,
              modules: draftToUpdatePayload(effective, next),
              ...(setupCompleted ? { setupCompleted: true } : {}),
            });
            await mutate(updated, { revalidate: false });
          } catch (error) {
            failure = error;
            throw error;
          }
        },
      });
      setSaving(false);
      if (!ok) {
        // Only a CAS conflict means the server's state moved on: reload and drop the draft,
        // because it was computed against a revision that no longer exists. Every other failure
        // (offline, denied, reauth cancelled) leaves the server exactly as it was — throwing the
        // operator's selection away there would be destroying work over a transient error.
        if (isModuleRevisionConflict(failure)) {
          await mutate();
          setDraft(null);
        }
        return;
      }
      setDraft(null);
      await refreshAdminModules();
      toast.success(
        changed.restartRequired.length > 0
          ? t('modules.saved.withRestart', {
              disabled: changed.disabled.length,
              enabled: changed.enabled.length,
              restart: changed.restartRequired.length,
            })
          : t('modules.saved.hot', {
              disabled: changed.disabled.length,
              enabled: changed.enabled.length,
            }),
      );
    },
    [authMethod, data, effective, mutate, t],
  );

  /**
   * The single save path. The wizard's 完成 goes through here too — otherwise finishing setup
   * could switch 审计 off without ever showing the compliance confirmation.
   */
  const onSave = useCallback(
    (setupCompleted?: boolean) => {
      const compliance = diff.disabled.filter((id) => CONFIRM_ON_DISABLE.includes(id));
      if (compliance.length > 0) {
        openDangerConfirm({
          content: t('modules.danger.desc'),
          onConfirm: () => commit(current, setupCompleted),
          title: t('modules.danger.title', {
            modules: compliance
              .map((id) => t(`modules.items.${id}.title` as never, { defaultValue: id }))
              .join('、'),
          }),
        });
        return;
      }
      void commit(current, setupCompleted);
    },
    [commit, current, diff.disabled, t],
  );

  if (!canRead) {
    return (
      <Flexbox padding={24}>
        <Text type="secondary">{t('page.forbidden.desc')}</Text>
      </Flexbox>
    );
  }

  // Nothing loaded: show the failure and a retry, and *only* that. Rendering the switches over
  // `ALL_MODULES_ENABLED` would invite an operator to compose a change against a state we never
  // read, and Save would then no-op — the worst possible answer to "did that work?".
  if (error && !data) {
    return (
      <AdminPageTemplate description={t('modules.description')} title={t('modules.title')}>
        <Flexbox align="center" gap={12} horizontal role="alert">
          <Text type="danger">{t('modules.errors.loadFailed')}</Text>
          <Button size="small" onClick={() => void mutate()}>
            {t('access.error.retry')}
          </Button>
        </Flexbox>
      </AdminPageTemplate>
    );
  }

  return (
    <AdminPageTemplate description={t('modules.description')} title={t('modules.title')}>
      {wizard ? (
        <ModuleWizard
          canOperate={canOperate}
          saving={saving}
          setupCompletedAt={data?.snapshot.setupCompletedAt ?? null}
          step={wizardStep}
          onFinish={() => onSave(true)}
          onStepChange={setWizardStep}
          onExit={() => {
            // Leaving the wizard is the same "稍后再说" the overview card offers.
            dismissSetupGuide();
            const next = new URLSearchParams(params);
            next.delete('wizard');
            setParams(next, { replace: true });
          }}
        />
      ) : null}

      {isLoading && !data ? (
        <>
          <div aria-label={t('access.loading')} className={styles.skeleton} role="status" />
          <div className={styles.skeleton} />
        </>
      ) : wizard && wizardStep !== 1 ? null : (
        <>
          {data && data.pendingRestart.length > 0 ? (
            <ModuleRestartBanner
              canOperate={canOperate}
              modules={data.pendingRestart}
              phase={restart.phase}
              restartReason={data.restart.reason}
              restartSupported={data.restart.supported}
              onRestart={() => void restart.request()}
            />
          ) : null}

          <ModulePresetRow activePreset={preset} disabled={!canOperate} onSelect={onSelectPreset} />

          <ModuleSummaryBar draft={current} restartRequiredCount={diff.restartRequired.length} />

          <ModuleGroupList
            draft={current}
            envDisabledBy={data?.snapshot.envDisabledBy ?? {}}
            pendingRestart={data?.pendingRestart ?? []}
            readOnly={!canOperate}
            onToggle={onToggle}
          />

          <CoreModulesFooter />

          {diff.dirty ? (
            <div className={styles.footer}>
              <Text className={styles.footerText} type="secondary">
                {t('modules.pendingChanges', {
                  disabled: diff.disabled.length,
                  enabled: diff.enabled.length,
                })}
              </Text>
              <Button disabled={saving} onClick={() => setDraft(null)}>
                {t('modules.discard')}
              </Button>
              <Button
                disabled={!canOperate}
                loading={saving}
                type="primary"
                onClick={() => onSave()}
              >
                {t('modules.save')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </AdminPageTemplate>
  );
});

ModulesPage.displayName = 'AdminModulesPage';

export default ModulesPage;
