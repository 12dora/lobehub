'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminSettingsService } from '@/enterprise/client/services/adminSettings';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import RevisionBanner from '../primitives/RevisionBanner';
import { openReasonModal } from '../users/modals/openReasonModal';
import { refreshAdminSettingsDraft, useFetchAdminSettingsDraft } from './hooks/useAdminSettings';
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from './localDraftStorage';
import {
  buildChangePreview,
  clearConflictDraft,
  deriveSettingsPermissions,
  fingerprintDraft,
  loadConflictDraft,
  resolvePrimaryAction,
  saveConflictDraft,
  type SaveState,
} from './settingsPolicyController';

type DraftMap = AdminSettingsGetDraftOutput['draft'];
type DraftPolicy = DraftMap[string];

const styles = createStaticStyles(({ css }) => ({
  empty: css`
    padding: 24px;
    color: ${cssVar.colorTextSecondary};
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  fieldHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    margin-block-start: 8px;
    padding-block: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
  group: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
  path: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
  scroll: css`
    overflow: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;

    min-height: 0;
  `,
  status: css`
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

const MODE_VALUES = ['user', 'default', 'locked'] as const;

const GROUPS = [
  'general',
  'memory',
  'tool',
  'image',
  'tts',
  'notification',
  'defaultAgent',
  'systemAgent',
] as const;

const SettingsPolicyPage = memo(() => {
  const { t } = useTranslation('admin');
  const platform = useEnterprisePlatform();
  const policyEnabled = platform.capabilities.userSettingsPolicyEnabled === true;
  const { permissions } = useAdminAccess();
  const { canUpdate, canPublish } = deriveSettingsPermissions(permissions);

  const { data, error, isLoading, mutate } = useFetchAdminSettingsDraft(policyEnabled);

  const [draft, setDraft] = useState<DraftMap>({});
  const [search, setSearch] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);
  const [impact, setImpact] = useState<{
    pathsWithOverrides: number;
    totalOverrideRows: number;
  } | null>(null);
  const [validatedFingerprint, setValidatedFingerprint] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const hydratedRef = useRef(false);

  const draftFingerprint = useMemo(() => fingerprintDraft(draft), [draft]);
  const primary = resolvePrimaryAction({
    canPublish,
    canUpdate,
    dirty,
    draftFingerprint,
    revisionConflict,
    saveState,
    validatedForFingerprint: validatedFingerprint,
  });

  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const leave = window.confirm(t('settingsPolicy.unsavedLeave'));
    if (leave) blocker.proceed?.();
    else blocker.reset?.();
  }, [blocker, t]);

  // Hydrate editor from server + local durable draft / conflict draft
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    const conflict = loadConflictDraft();
    if (conflict && conflict.registryVersion === data.registryVersion) {
      setDraft(conflict.draft);
      setDirty(true);
      setRevisionConflict(true);
      return;
    }
    const local = loadLocalDraft(data.registryVersion, data.baseRevision);
    if (local) {
      setDraft(local.draft);
      setDirty(true);
    } else {
      setDraft(data.draft ?? {});
      setDirty(false);
    }
  }, [data]);

  // Persist dirty draft locally
  useEffect(() => {
    if (!data || !dirty) return;
    saveLocalDraft({
      baseRevision: data.baseRevision,
      draft,
      registryVersion: data.registryVersion,
      savedAt: new Date().toISOString(),
    });
  }, [data, dirty, draft]);

  // Warn before unload when dirty
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const registryByPath = useMemo(() => {
    const map = new Map<string, AdminSettingsGetDraftOutput['registry'][number]>();
    for (const entry of data?.registry ?? []) map.set(entry.path, entry);
    return map;
  }, [data?.registry]);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.registry ?? []).filter((entry) => {
      if (!q) return true;
      return (
        entry.path.toLowerCase().includes(q) ||
        entry.titleKey.toLowerCase().includes(q) ||
        entry.group.toLowerCase().includes(q)
      );
    });
  }, [data?.registry, search]);

  const getPolicy = useCallback(
    (path: string): DraftPolicy => {
      if (draft[path]) return draft[path]!;
      const published = data?.publishedPolicies[path];
      if (published) return published;
      const entry = registryByPath.get(path);
      return {
        mode: 'user',
        schemaVersion: entry?.schemaVersion ?? 1,
        value: undefined,
        visibility: 'visible',
      };
    },
    [data?.publishedPolicies, draft, registryByPath],
  );

  const updatePolicy = useCallback(
    (path: string, patch: Partial<DraftPolicy>) => {
      if (!canUpdate) return;
      setDraft((prev) => {
        const base = prev[path] ?? getPolicy(path);
        return { ...prev, [path]: { ...base, ...patch } };
      });
      setDirty(true);
      setSaveState('idle');
      setSaveError(null);
      setValidationMsg(null);
      setImpact(null);
      setValidatedFingerprint(null);
    },
    [canUpdate, getPolicy],
  );

  const handleSaveDraft = useCallback(async () => {
    if (!data) return;
    setSaveState('saving');
    setSaveError(null);
    try {
      await adminSettingsService.saveDraft({
        draft,
        reason: t('settingsPolicy.saveReason'),
      });
      clearLocalDraft(data.registryVersion, data.baseRevision);
      setDirty(false);
      setSaveState('saved');
      hydratedRef.current = false;
      await mutate();
      await refreshAdminSettingsDraft();
    } catch (err) {
      setSaveState('failed');
      const mapped = mapEnterpriseError(err);
      setSaveError(
        mapped ? t(mapped.i18nKey as never, { defaultValue: mapped.code }) : String(err),
      );
    }
  }, [data, draft, mutate, t]);

  const handleValidate = useCallback(async () => {
    setValidationMsg(null);
    try {
      const result = await adminSettingsService.validateDraft({ draft });
      setImpact(result.impactEstimate);
      if (result.ok) {
        setValidationMsg(t('settingsPolicy.validateOk'));
        setValidatedFingerprint(fingerprintDraft(draft));
      } else {
        setValidatedFingerprint(null);
        setValidationMsg(
          t('settingsPolicy.validateFail', {
            count: result.issues.length,
            first: result.issues[0]?.message ?? '',
          }),
        );
      }
    } catch (err) {
      setValidatedFingerprint(null);
      const mapped = mapEnterpriseError(err);
      setValidationMsg(mapped ? mapped.code : String(err));
    }
  }, [draft, t]);

  const handlePublish = useCallback(() => {
    if (!data || !canPublish) return;
    if (validatedFingerprint !== fingerprintDraft(draft)) {
      setValidationMsg(t('settingsPolicy.publishRequiresValidate'));
      return;
    }
    openReasonModal({
      buildPayload: (reason) => ({
        expectedRevision: data.baseRevision,
        reason,
      }),
      description: t('settingsPolicy.publishDesc'),
      impact: impact
        ? t('settingsPolicy.impactSummary', {
            paths: impact.pathsWithOverrides,
            rows: impact.totalOverrideRows,
          })
        : undefined,
      onSubmit: async (payload) => {
        try {
          await adminSettingsService.publish(
            payload as { expectedRevision: number; reason: string },
          );
          clearLocalDraft(data.registryVersion, data.baseRevision);
          clearConflictDraft();
          setDirty(false);
          setRevisionConflict(false);
          hydratedRef.current = false;
          await mutate();
        } catch (err) {
          const mapped = mapEnterpriseError(err);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
            saveConflictDraft({
              draft,
              previousBaseRevision: data.baseRevision,
              registryVersion: data.registryVersion,
              savedAt: new Date().toISOString(),
            });
            setRevisionConflict(true);
          }
          throw err;
        }
      },
      submitLabel: t('settingsPolicy.publish'),
      targetLabel: t('settingsPolicy.title'),
      title: t('settingsPolicy.publish'),
    });
  }, [canPublish, data, draft, impact, mutate, t, validatedFingerprint]);

  const handleRollback = useCallback(() => {
    if (!data || data.baseRevision < 1) return;
    openReasonModal({
      buildPayload: (reason) => ({
        expectedRevision: data.baseRevision,
        reason,
        targetRevision: Math.max(1, data.baseRevision - 1),
      }),
      danger: true,
      description: t('settingsPolicy.rollbackDesc'),
      onSubmit: async (payload) => {
        try {
          await adminSettingsService.rollback(
            payload as { expectedRevision: number; reason: string; targetRevision: number },
          );
          clearLocalDraft(data.registryVersion, data.baseRevision);
          setDirty(false);
          hydratedRef.current = false;
          await mutate();
        } catch (err) {
          const mapped = mapEnterpriseError(err);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
            setRevisionConflict(true);
          }
          throw err;
        }
      },
      submitLabel: t('settingsPolicy.rollback'),
      targetLabel: t('settingsPolicy.title'),
      title: t('settingsPolicy.rollback'),
    });
  }, [data, mutate, t]);

  // U1: policy flag off → disabled surface, zero getDraft
  if (!policyEnabled) {
    return (
      <AdminPageTemplate description={t('settingsPolicy.desc')} title={t('settingsPolicy.title')}>
        <Text type="secondary">{t('settingsPolicy.featureDisabled')}</Text>
      </AdminPageTemplate>
    );
  }

  // Error before empty
  if (error) {
    const mapped = mapEnterpriseError(error);
    return (
      <AdminPageTemplate
        description={t('settingsPolicy.desc')}
        title={t('settingsPolicy.title')}
        actions={
          <Button
            onClick={() => {
              void mutate();
            }}
          >
            {t('primitives.dataTable.retry')}
          </Button>
        }
      >
        <Text className={styles.error}>
          {mapped ? t(mapped.i18nKey as never, { defaultValue: mapped.code }) : String(error)}
        </Text>
      </AdminPageTemplate>
    );
  }

  if (isLoading || !data) {
    return (
      <AdminPageTemplate description={t('settingsPolicy.desc')} title={t('settingsPolicy.title')}>
        <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
      </AdminPageTemplate>
    );
  }

  const preview = buildChangePreview({
    draft,
    published: data.publishedPolicies,
    registryPaths: data.registry.map((r) => r.path),
  });

  // Exactly one primary action — sticky footer only (U5)
  const primaryButton =
    primary === 'save' || primary === 'retry' ? (
      <Button
        disabled={!canUpdate}
        loading={saveState === 'saving'}
        type="primary"
        onClick={() => void handleSaveDraft()}
      >
        {primary === 'retry' ? t('settingsPolicy.retrySave') : t('settingsPolicy.saveDraft')}
      </Button>
    ) : primary === 'validate' ? (
      <Button disabled={!canUpdate} type="primary" onClick={() => void handleValidate()}>
        {t('settingsPolicy.validate')}
      </Button>
    ) : primary === 'publish' ? (
      <Button disabled={!canPublish} type="primary" onClick={handlePublish}>
        {t('settingsPolicy.publish')}
      </Button>
    ) : null;

  return (
    <AdminPageTemplate
      title={t('settingsPolicy.title')}
      actions={
        <Flexbox horizontal gap={8}>
          {canUpdate ? (
            <Button onClick={() => void handleValidate()}>{t('settingsPolicy.validate')}</Button>
          ) : null}
          {canPublish ? (
            <Button disabled={data.baseRevision < 1} onClick={handleRollback}>
              {t('settingsPolicy.rollback')}
            </Button>
          ) : null}
        </Flexbox>
      }
      banner={
        revisionConflict ? (
          <RevisionBanner
            conflict
            publishedRevision={data.baseRevision}
            onRefresh={() => {
              const conflict = loadConflictDraft();
              if (conflict) setDraft(conflict.draft);
              setRevisionConflict(false);
              hydratedRef.current = false;
              void mutate();
            }}
          />
        ) : null
      }
      description={
        canUpdate
          ? t('settingsPolicy.desc')
          : `${t('settingsPolicy.desc')} ${t('settingsPolicy.readOnlyHint')}`
      }
      toolbar={
        <Input
          allowClear
          placeholder={t('settingsPolicy.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      }
    >
      <div className={styles.scroll}>
        {validationMsg ? <Text type="secondary">{validationMsg}</Text> : null}
        {impact ? (
          <Text type="secondary">
            {t('settingsPolicy.impactSummary', {
              paths: impact.pathsWithOverrides,
              rows: impact.totalOverrideRows,
            })}
          </Text>
        ) : null}
        {preview.length > 0 ? (
          <div>
            <Text strong>{t('settingsPolicy.changePreview')}</Text>
            {preview.map((row) => (
              <Text as="div" key={row.path} type="secondary">
                {row.path}: {row.beforeMode}/{String(row.beforeValue)} → {row.afterMode}/
                {String(row.afterValue)} ({row.beforeVisibility}→{row.afterVisibility})
              </Text>
            ))}
          </div>
        ) : null}

        {GROUPS.map((group) => {
          const entries = filteredEntries.filter((e) => e.group === group);
          if (entries.length === 0) return null;
          return (
            <div className={styles.group} key={group}>
              <Text strong>{t(`settingsPolicy.groups.${group}` as never)}</Text>
              {entries.map((entry) => {
                const policy = getPolicy(entry.path);
                return (
                  <div className={styles.field} id={`setting-${entry.path}`} key={entry.path}>
                    <div className={styles.fieldHeader}>
                      <div>
                        <Text strong>
                          {t(entry.titleKey as never, { defaultValue: entry.path })}
                        </Text>
                        <div className={styles.path}>{entry.path}</div>
                      </div>
                      <div className={styles.row}>
                        <Select
                          disabled={!canUpdate}
                          style={{ minWidth: 120 }}
                          value={policy.mode}
                          options={MODE_VALUES.map((value) => ({
                            label: t(`settingsPolicy.mode.${value}` as never),
                            value,
                          }))}
                          onChange={(v) =>
                            updatePolicy(entry.path, { mode: v as DraftPolicy['mode'] })
                          }
                        />
                        <Flexbox horizontal align="center" gap={6}>
                          <Text type="secondary">{t('settingsPolicy.hidden')}</Text>
                          <Switch
                            checked={policy.visibility === 'hidden'}
                            onChange={(checked: boolean) =>
                              updatePolicy(entry.path, {
                                visibility: checked ? 'hidden' : 'visible',
                              })
                            }
                          />
                        </Flexbox>
                      </div>
                    </div>
                    <Text type="secondary">
                      {t(entry.descriptionKey as never, { defaultValue: '' })}
                    </Text>
                    <PolicyValueEditor
                      control={entry.control}
                      disabled={!canUpdate}
                      max={entry.max}
                      min={entry.min}
                      options={entry.options}
                      step={entry.step}
                      value={policy.value}
                      onChange={(value) => updatePolicy(entry.path, { value })}
                    />
                    {data.publishedPolicies[entry.path] ? (
                      <Text type="secondary">
                        {t('settingsPolicy.publishedValue')}:{' '}
                        {JSON.stringify(data.publishedPolicies[entry.path]?.value)}
                      </Text>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}

        {filteredEntries.length === 0 ? (
          <div className={styles.empty}>{t('settingsPolicy.noResults')}</div>
        ) : null}
      </div>

      <div className={styles.footer}>
        <span className={styles.status}>
          {saveState === 'saving' && t('settingsPolicy.saveState.saving')}
          {saveState === 'saved' && t('settingsPolicy.saveState.saved')}
          {saveState === 'failed' && (saveError || t('settingsPolicy.saveState.failed'))}
          {saveState === 'idle' &&
            (dirty ? t('settingsPolicy.saveState.dirty') : t('settingsPolicy.saveState.idle'))}
          {' · '}
          {t('settingsPolicy.revision', { revision: data.baseRevision })}
        </span>
        <Flexbox horizontal gap={8}>
          {primaryButton}
        </Flexbox>
      </div>
    </AdminPageTemplate>
  );
});

SettingsPolicyPage.displayName = 'SettingsPolicyPage';

const PolicyValueEditor = memo<{
  control: string;
  disabled?: boolean;
  max?: number;
  min?: number;
  onChange: (value: unknown) => void;
  options?: ReadonlyArray<{ labelKey: string; value: string | number | boolean }>;
  step?: number;
  value: unknown;
}>(({ control, value, onChange, options, min, max, step, disabled }) => {
  const { t } = useTranslation('admin');

  if (control === 'switch') {
    return (
      <Switch
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(checked: boolean) => onChange(checked)}
      />
    );
  }

  if (control === 'select' && options?.length) {
    return (
      <Select
        disabled={disabled}
        style={{ minWidth: 180 }}
        value={value as string | number | boolean | undefined}
        options={options.map((o) => ({
          label: t(o.labelKey as never, { defaultValue: String(o.value) }),
          value: o.value,
        }))}
        onChange={(v) => onChange(v)}
      />
    );
  }

  if (control === 'textarea') {
    return (
      <textarea
        disabled={disabled}
        rows={4}
        style={{ width: '100%' }}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
      />
    );
  }

  if (control === 'slider') {
    // Prefer slider primitive with min/max/step (U6-R2) — number input only for pure number
    return (
      <Input
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        type="range"
        value={value === undefined || value === null ? String(min ?? 0) : String(value)}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : e.target.value);
        }}
      />
    );
  }

  if (control === 'number') {
    return (
      <Input
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : e.target.value);
        }}
      />
    );
  }

  return (
    <Input
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
});

PolicyValueEditor.displayName = 'PolicyValueEditor';

export default SettingsPolicyPage;
