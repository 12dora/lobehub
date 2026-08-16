'use client';

import { Alert, Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ModerationMode } from '@/const/platform/contentModeration';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { ContentModerationSettingsView } from '@/types/platform/contentModeration';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import { type ConfigValidationMessage, resolveConfigValidationMessage } from '../configErrors';
import { invalidateModerationOverview, useModerationSettings } from '../hooks';
import ManageGuard from '../ManageGuard';
import { adminContentModerationService } from '../service';
import { moderationStyles as styles } from '../styles';
import {
  type DraftIssue,
  fingerprintDraftBase,
  fingerprintKeywords,
  type ModerationConfigView,
  type ModerationSettingsDraft,
  toDraft,
  toUpdateConfig,
  validateDraftBase,
  validateKeywordRules,
} from './draft';
import AutoBanSection from './sections/AutoBanSection';
import BasicSection from './sections/BasicSection';
import CacheSection from './sections/CacheSection';
import CategoriesSection from './sections/CategoriesSection';
import ClassifierSection from './sections/ClassifierSection';
import KeywordsSection from './sections/KeywordsSection';
import RecordsSection from './sections/RecordsSection';
import ScopeSection from './sections/ScopeSection';

/** One place the baseline fingerprint is produced, so adopt/save/reload can never disagree. */
const draftFingerprint = (draft: ModerationSettingsDraft): string =>
  `${fingerprintDraftBase(draft)}|${fingerprintKeywords(draft.config.keywords)}`;

/** Validation keys whose message belongs under the classifier sub-form. */
const CLASSIFIER_ISSUE_KEYS = new Set([
  'llmJudgeRequired',
  'moderationsApiRequired',
  'moderationsApiUrl',
  'moderationsApiKeyRequired',
]);

export interface SettingsTabProps {
  canManage: boolean;
  enabled: boolean;
}

/**
 * 设置 tab (design §6.3). Direct save, no drafts: one 保存 button writes the whole config with
 * a revision CAS. A conflict never silently overwrites the other admin — it offers a reload.
 */
const SettingsTab = memo<SettingsTabProps>(({ canManage, enabled }) => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions } = useAdminAccess();
  const { data, error, isLoading, mutate } = useModerationSettings(enabled);

  const [draft, setDraft] = useState<ModerationSettingsDraft | null>(null);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [importText, setImportText] = useState('');
  const [fieldError, setFieldError] = useState<ConfigValidationMessage | null>(null);
  const baselineRef = useRef<string>('');

  /**
   * Replace the whole editor from an authoritative server payload (first load, save, reload).
   *
   * The baseline is recomputed from the SAME object that becomes the draft, so the base and
   * keyword halves of the fingerprint always move together — a baseline taken from one array while
   * the deferred copy still held another is what produced a transient "unsaved changes" flash.
   */
  const applySnapshot = useCallback((bundle: { settings: ContentModerationSettingsView }) => {
    const next = toDraft(bundle.settings);
    baselineRef.current = draftFingerprint(next);
    setDraft(next);
    setBaseRevision(bundle.settings.revision);
    setConflict(false);
    setFieldError(null);
  }, []);

  // Adopt the server snapshot only while there is nothing local to lose.
  useEffect(() => {
    if (!data) return;
    setDraft((current) => {
      if (current !== null) return current;
      const next = toDraft(data.settings);
      baselineRef.current = draftFingerprint(next);
      setBaseRevision(data.settings.revision);
      return next;
    });
  }, [data]);

  /** Endpoint the stored Moderations keys were saved against (server truth, not the draft). */
  const persistedBaseUrl = data?.settings.classifier.moderationsApi?.baseUrl;

  /**
   * The keyword list is allowed to hold 10,000 rules, so its two expensive derivations —
   * serialization for the dirty check and rule validation — run against a DEFERRED copy of the
   * array. Typing in a rule commits the edit at normal priority (the input stays responsive) and
   * React re-runs these at low priority once typing settles; 保存 simply enables a beat later.
   */
  const deferredKeywords = useDeferredValue(draft?.config.keywords);
  /**
   * True while the deferred copy is behind the live rule array. During that window the keyword
   * fingerprint and the keyword issues describe the PREVIOUS rules, so mixing them with the
   * up-to-date base state would let an already-dirty form save a rule that has not been validated
   * yet. Writes are held until the low-priority pass catches up (usually the next frame).
   */
  const keywordsPending = Boolean(draft) && deferredKeywords !== draft?.config.keywords;
  const baseFingerprint = useMemo(() => (draft ? fingerprintDraftBase(draft) : ''), [draft]);
  const keywordFingerprint = useMemo(
    () => (deferredKeywords ? fingerprintKeywords(deferredKeywords) : ''),
    [deferredKeywords],
  );
  const currentFingerprint = `${baseFingerprint}|${keywordFingerprint}`;
  /**
   * Real config changes — the only thing 保存 should ever write.
   *
   * While the keyword pass is pending the fingerprint mixes a fresh base half with a stale keyword
   * half, so it is not authoritative; treat the form as not-yet-saveable rather than as clean
   * (a false "clean" right after a snapshot adoption is exactly the transient dirty/clean flash
   * this guard removes).
   */
  const configDirty =
    draft && !keywordsPending ? currentFingerprint !== baselineRef.current : false;
  /**
   * An unapplied batch-import paste is unsaved work too, so the leave guard covers it — but it
   * must not enable 保存, which would otherwise commit an unchanged document and bump the revision.
   */
  const dirty = configDirty || importText.length > 0;

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('contentModeration.settings.unsaved.stay'),
      content: t('contentModeration.settings.unsaved.desc'),
      okText: t('contentModeration.settings.unsaved.leave'),
      title: t('contentModeration.settings.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({ enabled: dirty, messages: unsavedMessages });

  const patch = useCallback((next: Partial<ModerationConfigView>) => {
    setDraft((current) =>
      current ? { ...current, config: { ...current.config, ...next } } : current,
    );
  }, []);

  const setAddedKeys = useCallback((keys: string[]) => {
    setDraft((current) => (current ? { ...current, addedApiKeys: keys } : current));
  }, []);

  const handleModeChange = (mode: ModerationMode) => {
    if (mode !== 'enforce') {
      patch({ mode });
      return;
    }
    openDangerConfirm({
      confirmText: t('contentModeration.settings.enforceConfirmOk'),
      content: t('contentModeration.settings.enforceConfirm'),
      title: t('contentModeration.settings.enforceConfirmTitle'),
      onConfirm: () => patch({ mode }),
    });
  };

  const handleAutoBanToggle = (nextEnabled: boolean) => {
    if (!draft) return;
    if (!nextEnabled) {
      patch({ autoBan: { ...draft.config.autoBan, enabled: false } });
      return;
    }
    openDangerConfirm({
      confirmText: t('contentModeration.settings.autoBan.confirmOk'),
      content: t('contentModeration.settings.autoBan.confirm'),
      title: t('contentModeration.settings.autoBan.confirmTitle'),
      onConfirm: () => patch({ autoBan: { ...draft.config.autoBan, enabled: true } }),
    });
  };

  const handleClearCache = () => {
    if (!canManage || clearingCache) return;
    openDangerConfirm({
      content: t('contentModeration.overview.clearCacheConfirm'),
      title: t('contentModeration.overview.clearCacheTitle'),
      onConfirm: async () => {
        setClearingCache(true);
        try {
          const ok = await runAdminMutation({
            authMethod,
            mapErrorKey: () => 'contentModeration.toast.clearCacheFailed',
            run: async () => {
              const result = await adminContentModerationService.clearDecisionCache();
              toast.success(
                t('contentModeration.toast.clearCacheSuccess', { count: result.deleted }),
              );
            },
          });
          if (ok) await invalidateModerationOverview();
        } finally {
          setClearingCache(false);
        }
      },
    });
  };

  const baseIssues = useMemo(
    () => (draft ? validateDraftBase(draft, { persistedBaseUrl }) : []),
    [draft, persistedBaseUrl],
  );
  // Same deferral as the fingerprint — validating 10,000 rules per keystroke is the other half.
  const keywordIssues = useMemo<DraftIssue[]>(
    () => (deferredKeywords ? validateKeywordRules(deferredKeywords) : []),
    [deferredKeywords],
  );
  const issues = useMemo(() => [...baseIssues, ...keywordIssues], [baseIssues, keywordIssues]);

  /** Local validation that belongs to the classifier section, so it renders next to the fields. */
  const classifierMessage = useMemo(() => {
    if (fieldError?.field?.startsWith('classifier.')) return fieldError;
    const issue = baseIssues.find((item) => CLASSIFIER_ISSUE_KEYS.has(item.key));
    if (!issue) return null;
    return { message: t(`contentModeration.errors.${issue.key}` as never, issue.params) };
  }, [baseIssues, fieldError, t]);

  const handleSave = async () => {
    if (!draft || !canManage || saving || baseRevision === null || !configDirty) return;
    if (keywordsPending) {
      toast.error(t('contentModeration.settings.keywordsValidating'));
      return;
    }
    // Re-validate the CURRENT rules synchronously: `keywordIssues` is derived from the deferred
    // copy, so trusting it alone could wave an invalid rule straight through to the server.
    const liveIssues = [...baseIssues, ...validateKeywordRules(draft.config.keywords)];
    if (liveIssues.length > 0) {
      const [first] = liveIssues;
      toast.error(t(`contentModeration.errors.${first.key}` as never, first.params));
      return;
    }
    setSaving(true);
    setFieldError(null);
    try {
      await runAdminMutation({
        authMethod,
        run: async () => {
          const saved = await adminContentModerationService.updateSettings({
            config: toUpdateConfig(draft, { persistedBaseUrl }),
            expectedRevision: baseRevision,
          });
          applySnapshot(saved);
          // Plaintext keys existed only for this request — never keep them in component state.
          setImportText('');
          await mutate(saved, { revalidate: false });
          await invalidateModerationOverview();
          toast.success(t('contentModeration.toast.saveSuccess'));
        },
        onError: async (cause) => {
          if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
            setConflict(true);
            toast.error(t('contentModeration.toast.conflict'));
            return;
          }
          const mapped = resolveConfigValidationMessage(
            cause,
            t,
            'contentModeration.toast.saveFailed',
          );
          if (mapped) {
            setFieldError(mapped);
            toast.error(mapped.message);
            return;
          }
          toast.error(t('contentModeration.toast.saveFailed'));
        },
      });
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    const fresh = await mutate();
    if (!fresh) return;
    applySnapshot(fresh);
    setImportText('');
  };

  if (isLoading && !data) return <Skeleton.Block height={320} width="100%" />;

  if (error && !data) {
    return (
      <Alert
        showIcon
        message={t('contentModeration.settings.loadFailed')}
        type="error"
        action={
          <Button size="small" onClick={() => void mutate()}>
            {t('contentModeration.charts.retry')}
          </Button>
        }
      />
    );
  }

  if (!draft || !data) return null;

  const formDisabled = !canManage || saving;

  return (
    <Flexbox className={styles.stack} gap={16}>
      {conflict ? (
        <Alert
          showIcon
          description={t('contentModeration.settings.conflictDesc')}
          message={t('contentModeration.settings.conflictTitle')}
          type="warning"
          action={
            <Button size="small" onClick={() => void reload()}>
              {t('contentModeration.settings.reload')}
            </Button>
          }
        />
      ) : null}

      {!canManage ? (
        <Alert showIcon message={t('contentModeration.settings.readOnly')} type="info" />
      ) : null}

      <div className={styles.tableToolbar}>
        <Text className={styles.hintText} data-testid="settings-status">
          {keywordsPending
            ? t('contentModeration.settings.keywordsValidating')
            : dirty
              ? t('contentModeration.settings.dirty')
              : t('contentModeration.settings.saved', { revision: baseRevision ?? 0 })}
        </Text>
        <ManageGuard allowed={canManage}>
          <Button
            disabled={!canManage || saving || keywordsPending || !configDirty}
            loading={saving}
            type="primary"
            onClick={() => void handleSave()}
          >
            {t('contentModeration.settings.save')}
          </Button>
        </ManageGuard>
      </div>

      <BasicSection
        catalog={data.catalog}
        config={draft.config}
        disabled={formDisabled}
        onModeChange={handleModeChange}
        onPatch={patch}
      />
      <ScopeSection
        canSearchUsers={permissions.includes(PLATFORM_PERMISSIONS.USER_READ)}
        catalog={data.catalog}
        config={draft.config}
        disabled={formDisabled}
        roles={data.roles}
        onPatch={patch}
      />
      <ClassifierSection
        canManage={canManage}
        catalog={data.catalog}
        disabled={formDisabled}
        draft={draft}
        fieldError={classifierMessage}
        keywordsPending={keywordsPending}
        persistedBaseUrl={persistedBaseUrl}
        onAddedKeysChange={setAddedKeys}
        onPatch={patch}
      />
      <CategoriesSection config={draft.config} disabled={formDisabled} onPatch={patch} />
      <KeywordsSection
        config={draft.config}
        disabled={formDisabled}
        fieldError={fieldError?.field === 'keywords' ? fieldError : null}
        importText={importText}
        onImportTextChange={setImportText}
        onPatch={patch}
      />
      <CacheSection
        canManage={canManage}
        clearing={clearingCache}
        config={draft.config}
        disabled={formDisabled}
        onClearCache={handleClearCache}
        onPatch={patch}
      />
      <AutoBanSection
        config={draft.config}
        disabled={formDisabled}
        onEnableChange={handleAutoBanToggle}
        onPatch={patch}
      />
      <RecordsSection config={draft.config} disabled={formDisabled} onPatch={patch} />

      {issues.length > 0 ? (
        <Alert
          showIcon
          data-testid="moderation-settings-issues"
          message={t(`contentModeration.errors.${issues[0].key}` as never, issues[0].params)}
          type="warning"
        />
      ) : null}
    </Flexbox>
  );
});

SettingsTab.displayName = 'ModerationSettingsTab';

export default SettingsTab;
