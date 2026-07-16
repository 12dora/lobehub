'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { adminSettingsService } from '@/enterprise/client/services/adminSettings';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import RevisionBanner from '../primitives/RevisionBanner';
import { openReasonModal } from '../users/modals/openReasonModal';
import { refreshAdminSettingsDraft, useFetchAdminSettingsDraft } from './hooks/useAdminSettings';
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from './localDraftStorage';

type DraftMap = AdminSettingsGetDraftOutput['draft'];
type DraftPolicy = DraftMap[string];
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

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

const MODE_OPTIONS = [
  { label: 'User', value: 'user' },
  { label: 'Default', value: 'default' },
  { label: 'Locked', value: 'locked' },
] as const;

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
  const { data, error, isLoading, mutate } = useFetchAdminSettingsDraft(true);

  const [draft, setDraft] = useState<DraftMap>({});
  const [search, setSearch] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);
  const [impact, setImpact] = useState<{
    pathsWithOverrides: number;
    totalOverrideRows: number;
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const hydratedRef = useRef(false);

  // Hydrate editor from server + local durable draft
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
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
      setDraft((prev) => {
        const base = prev[path] ?? getPolicy(path);
        return { ...prev, [path]: { ...base, ...patch } };
      });
      setDirty(true);
      setSaveState('idle');
      setSaveError(null);
    },
    [getPolicy],
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
      } else {
        setValidationMsg(
          t('settingsPolicy.validateFail', {
            count: result.issues.length,
            first: result.issues[0]?.message ?? '',
          }),
        );
      }
    } catch (err) {
      const mapped = mapEnterpriseError(err);
      setValidationMsg(mapped ? mapped.code : String(err));
    }
  }, [draft, t]);

  const handlePublish = useCallback(() => {
    if (!data) return;
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
          setDirty(false);
          setRevisionConflict(false);
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
      submitLabel: t('settingsPolicy.publish'),
      targetLabel: t('settingsPolicy.title'),
      title: t('settingsPolicy.publish'),
    });
  }, [data, impact, mutate, t]);

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

  const primaryAction =
    dirty || saveState === 'failed' ? (
      <Button
        loading={saveState === 'saving'}
        type="primary"
        onClick={() => void handleSaveDraft()}
      >
        {saveState === 'failed' ? t('settingsPolicy.retrySave') : t('settingsPolicy.saveDraft')}
      </Button>
    ) : (
      <Button type="primary" onClick={handlePublish}>
        {t('settingsPolicy.publish')}
      </Button>
    );

  return (
    <AdminPageTemplate
      description={t('settingsPolicy.desc')}
      title={t('settingsPolicy.title')}
      actions={
        <Flexbox horizontal gap={8}>
          <Button onClick={() => void handleValidate()}>{t('settingsPolicy.validate')}</Button>
          <Button disabled={data.baseRevision < 1} onClick={handleRollback}>
            {t('settingsPolicy.rollback')}
          </Button>
          {primaryAction}
        </Flexbox>
      }
      banner={
        revisionConflict ? (
          <RevisionBanner
            conflict
            publishedRevision={data.baseRevision}
            onRefresh={() => {
              setRevisionConflict(false);
              hydratedRef.current = false;
              void mutate();
            }}
          />
        ) : null
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
                          style={{ minWidth: 120 }}
                          value={policy.mode}
                          options={MODE_OPTIONS.map((o) => ({
                            label: t(`settingsPolicy.mode.${o.value}` as never),
                            value: o.value,
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
                      options={entry.options}
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
          {saveState === 'failed' ? (
            <Button type="primary" onClick={() => void handleSaveDraft()}>
              {t('settingsPolicy.retrySave')}
            </Button>
          ) : null}
          {dirty ? (
            <Button
              loading={saveState === 'saving'}
              type="primary"
              onClick={() => void handleSaveDraft()}
            >
              {t('settingsPolicy.saveDraft')}
            </Button>
          ) : (
            <Button type="primary" onClick={handlePublish}>
              {t('settingsPolicy.publish')}
            </Button>
          )}
        </Flexbox>
      </div>
    </AdminPageTemplate>
  );
});

SettingsPolicyPage.displayName = 'SettingsPolicyPage';

const PolicyValueEditor = memo<{
  control: string;
  onChange: (value: unknown) => void;
  options?: ReadonlyArray<{ labelKey: string; value: string | number | boolean }>;
  value: unknown;
}>(({ control, value, onChange, options }) => {
  const { t } = useTranslation('admin');

  if (control === 'switch') {
    return <Switch checked={Boolean(value)} onChange={(checked: boolean) => onChange(checked)} />;
  }

  if (control === 'select' && options?.length) {
    return (
      <Select
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

  if (control === 'number' || control === 'slider') {
    return (
      <Input
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
