'use client';

import { Alert, Flexbox, Text, TextArea } from '@lobehub/ui';
import { Button, Switch, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockerFunction } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { MAX_WIDTH } from '@/const/layoutTokens';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminAuthSettingsService } from '@/enterprise/client/services/adminAuthSettings';
import {
  isValidEmailDomainPattern,
  normalizeEmailDomainAllowlist,
} from '@/types/platform/authSettings';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import {
  decideGeneralSettingsHydration,
  fingerprintGeneralSettingsDraft,
} from './generalSettingsHydration';
import {
  clearGeneralSettingsLocalDraft,
  loadGeneralSettingsLocalDraft,
  saveGeneralSettingsLocalDraft,
} from './localDraftStorage';
import { useFetchAdminAuthSettings } from './useAdminAuthSettings';

const styles = createStaticStyles(({ css }) => ({
  allowlistReveal: css`
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows ${cssVar.motionDurationMid} ${cssVar.motionEaseInOut},
      opacity ${cssVar.motionDurationMid} ${cssVar.motionEaseInOut};

    &[data-open='true'] {
      grid-template-rows: 1fr;
      opacity: 1;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  allowlistRevealInner: css`
    overflow: hidden;
    min-height: 0;
  `,
  card: css`
    display: flex;
    flex-direction: column;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  divider: css`
    height: 1px;
    margin: 0;
    border: none;
    background: ${cssVar.colorBorderSecondary};
  `,
  footer: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: flex-end;
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: flex-start;
    justify-content: space-between;

    padding: 16px;
  `,
  rowText: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;

    min-width: 220px;
  `,
}));

interface GeneralSettingsDraft {
  emailDomainAllowlistEnabled: boolean;
  emailDomainText: string;
  openRegistration: boolean;
}

const GeneralSettingsPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const canView = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_READ);
  const canUpdate = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_UPDATE);

  const { data, error, isLoading, mutate } = useFetchAdminAuthSettings(canView);

  const [draft, setDraft] = useState<GeneralSettingsDraft | null>(null);
  const [baseline, setBaseline] = useState<GeneralSettingsDraft | null>(null);
  /** CAS token from last accepted server snapshot — required on update. */
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /** Server snapshot advanced while local edits are dirty — keep draft, require refresh/discard. */
  const [serverStale, setServerStale] = useState(false);
  /** CAS mismatch on save — force refresh/discard before retrying. */
  const [revisionConflict, setRevisionConflict] = useState(false);
  /** Pending local recovery offer (revision-keyed, non-secret). */
  const [recoveryOffer, setRecoveryOffer] = useState<GeneralSettingsDraft | null>(null);
  const baselineFpRef = useRef<string | null>(null);
  const draftFpRef = useRef<string | null>(null);
  const recoveryCheckedRevisionRef = useRef<number | null>(null);

  const toDraft = useCallback(
    (source: {
      emailDomainAllowlist: string[];
      emailDomainAllowlistEnabled: boolean;
      openRegistration: boolean;
    }): GeneralSettingsDraft => ({
      emailDomainAllowlistEnabled: source.emailDomainAllowlistEnabled,
      emailDomainText: source.emailDomainAllowlist.join('\n'),
      openRegistration: source.openRegistration,
    }),
    [],
  );

  // Keep refs in sync for the data-effect without re-subscribing on every keystroke.
  useEffect(() => {
    baselineFpRef.current = baseline
      ? fingerprintGeneralSettingsDraft({
          ...baseline,
          emailDomainText: normalizeEmailDomainAllowlist(baseline.emailDomainText).join('\n'),
        })
      : null;
  }, [baseline]);
  useEffect(() => {
    draftFpRef.current = draft
      ? fingerprintGeneralSettingsDraft({
          ...draft,
          emailDomainText: normalizeEmailDomainAllowlist(draft.emailDomainText).join('\n'),
        })
      : null;
  }, [draft]);

  useEffect(() => {
    if (!data) return;
    const nextRaw = toDraft(data);
    const next = {
      ...nextRaw,
      emailDomainText: normalizeEmailDomainAllowlist(nextRaw.emailDomainText).join('\n'),
    };
    const decision = decideGeneralSettingsHydration({
      baselineFp: baselineFpRef.current,
      draftFp: draftFpRef.current,
      next,
      saving,
    });
    if (decision.action === 'accept') {
      const accepted = {
        ...decision.next,
        // Preserve multi-line display form from server allowlist when accepting.
        emailDomainText: toDraft(data).emailDomainText,
      };
      const fp = fingerprintGeneralSettingsDraft(next);
      setBaseline(accepted);
      setDraft(accepted);
      setBaseRevision(data.revision);
      setServerStale(false);
      setRevisionConflict(false);
      baselineFpRef.current = fp;
      draftFpRef.current = fp;

      // Offer revision-keyed recovery once per server revision after hydrate.
      if (recoveryCheckedRevisionRef.current !== data.revision) {
        recoveryCheckedRevisionRef.current = data.revision;
        const local = loadGeneralSettingsLocalDraft(data.revision);
        if (
          local &&
          fingerprintGeneralSettingsDraft(local.draft) !== fingerprintGeneralSettingsDraft(accepted)
        ) {
          setRecoveryOffer(local.draft);
        } else {
          setRecoveryOffer(null);
        }
      }
      return;
    }
    if (decision.markStale) setServerStale(true);
  }, [data, saving, toDraft]);

  const dirty = useMemo(() => {
    if (!baseline || !draft) return false;
    return (
      fingerprintGeneralSettingsDraft({
        ...draft,
        emailDomainText: normalizeEmailDomainAllowlist(draft.emailDomainText).join('\n'),
      }) !==
      fingerprintGeneralSettingsDraft({
        ...baseline,
        emailDomainText: normalizeEmailDomainAllowlist(baseline.emailDomainText).join('\n'),
      })
    );
  }, [baseline, draft]);

  // Persist non-secret dirty drafts for crash/reload recovery.
  useEffect(() => {
    if (!dirty || !draft || baseRevision === null || serverStale || revisionConflict) return;
    saveGeneralSettingsLocalDraft({
      baseRevision,
      draft,
      savedAt: new Date().toISOString(),
    });
  }, [baseRevision, dirty, draft, revisionConflict, serverStale]);

  // Block real route exits and, when embedded under SecurityAuth tabs, same-path `?tab=`
  // switches that unmount this dirty page. Standalone navigation that only tweaks other
  // search params is still allowed.
  const shouldBlockPageExit = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => {
      if (!dirty) return false;
      if (currentLocation.pathname !== nextLocation.pathname) return true;
      if (!embedded) return false;
      return currentLocation.search !== nextLocation.search;
    },
    [dirty, embedded],
  );
  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('generalSettings.unsaved.stay'),
      content: t('generalSettings.unsaved.description'),
      okText: t('generalSettings.unsaved.leave'),
      title: t('generalSettings.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({
    enabled: dirty,
    messages: unsavedMessages,
    shouldBlock: shouldBlockPageExit,
  });

  const patch = (next: Partial<GeneralSettingsDraft>) =>
    setDraft((current) => (current ? { ...current, ...next } : current));

  const handleSave = async () => {
    if (!draft || !canUpdate || saving || serverStale || revisionConflict) return;
    if (baseRevision === null) {
      toast.error(t('generalSettings.saveError'));
      return;
    }
    const domains = normalizeEmailDomainAllowlist(draft.emailDomainText);
    const invalid = domains.find((entry) => !isValidEmailDomainPattern(entry));
    if (invalid) {
      toast.error(t('generalSettings.emailAllowlist.invalid', { domain: invalid }));
      return;
    }

    setSaving(true);
    try {
      const saved = await adminAuthSettingsService.update({
        emailDomainAllowlist: domains,
        emailDomainAllowlistEnabled: draft.emailDomainAllowlistEnabled,
        expectedRevision: baseRevision,
        openRegistration: draft.openRegistration,
      });
      await mutate(saved, { revalidate: false });
      const next = toDraft(saved);
      const nextFp = fingerprintGeneralSettingsDraft({
        ...next,
        emailDomainText: normalizeEmailDomainAllowlist(next.emailDomainText).join('\n'),
      });
      setBaseline(next);
      setDraft(next);
      setBaseRevision(saved.revision);
      setServerStale(false);
      setRevisionConflict(false);
      baselineFpRef.current = nextFp;
      draftFpRef.current = nextFp;
      clearGeneralSettingsLocalDraft(baseRevision);
      if (saved.revision !== baseRevision) clearGeneralSettingsLocalDraft(saved.revision);
      setRecoveryOffer(null);
      toast.success(t('generalSettings.saved'));
    } catch (cause) {
      if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
        setRevisionConflict(true);
        toast.error(t('generalSettings.conflict'));
        // Pull latest so discard has a current base; keep local draft until user confirms.
        await mutate().catch(() => undefined);
      } else {
        toast.error(t('generalSettings.saveError'));
      }
    } finally {
      setSaving(false);
    }
  };

  const applyServerSnapshot = useCallback(
    (source: {
      emailDomainAllowlist: string[];
      emailDomainAllowlistEnabled: boolean;
      openRegistration: boolean;
      revision: number;
    }) => {
      const next = toDraft(source);
      const nextFp = fingerprintGeneralSettingsDraft({
        ...next,
        emailDomainText: normalizeEmailDomainAllowlist(next.emailDomainText).join('\n'),
      });
      setBaseline(next);
      setDraft(next);
      setBaseRevision(source.revision);
      setServerStale(false);
      setRevisionConflict(false);
      baselineFpRef.current = nextFp;
      draftFpRef.current = nextFp;
    },
    [toDraft],
  );

  /**
   * Discard local edits only after an authoritative refresh succeeds.
   * On rejection / empty result keep the draft + conflict locks — never adopt a
   * stale pre-conflict SWR snapshot that would clear CAS state against an old revision.
   */
  const discardAndRefresh = () => {
    void mutate()
      .then((fresh) => {
        if (fresh) {
          if (baseRevision !== null) clearGeneralSettingsLocalDraft(baseRevision);
          setRecoveryOffer(null);
          applyServerSnapshot(fresh);
          return;
        }
        // Keep serverStale / revisionConflict and the alert + Retry affordance (XT-006).
        toast.error(t('generalSettings.stale.refreshFailed'));
      })
      .catch(() => {
        toast.error(t('generalSettings.stale.refreshFailed'));
      });
  };

  const acceptRecovery = () => {
    if (!recoveryOffer) return;
    setDraft(recoveryOffer);
    const fp = fingerprintGeneralSettingsDraft({
      ...recoveryOffer,
      emailDomainText: normalizeEmailDomainAllowlist(recoveryOffer.emailDomainText).join('\n'),
    });
    draftFpRef.current = fp;
    setRecoveryOffer(null);
  };

  const discardRecovery = () => {
    if (baseRevision !== null) clearGeneralSettingsLocalDraft(baseRevision);
    setRecoveryOffer(null);
  };

  const renderLoaded = () => {
    if (!draft) return <Loading debugId="AdminGeneralSettings > Hydrate" />;
    const disabled = !canUpdate || serverStale || revisionConflict;

    return (
      <AdminPageTemplate
        description={t('generalSettings.desc')}
        hideTitle={embedded}
        maxWidth={MAX_WIDTH}
        title={t('generalSettings.title')}
      >
        {disabled && !serverStale && !revisionConflict ? (
          <Alert showIcon message={t('generalSettings.readOnly')} type="info" />
        ) : null}
        {recoveryOffer && !serverStale && !revisionConflict ? (
          <Alert
            showIcon
            description={t('generalSettings.recovery.description')}
            message={t('generalSettings.recovery.title')}
            type="info"
            extra={
              <Flexbox horizontal gap={8}>
                <Button type="primary" onClick={acceptRecovery}>
                  {t('generalSettings.recovery.restore')}
                </Button>
                <Button onClick={discardRecovery}>{t('generalSettings.recovery.discard')}</Button>
              </Flexbox>
            }
          />
        ) : null}
        {serverStale || revisionConflict ? (
          <Alert
            showIcon
            type="warning"
            description={
              revisionConflict
                ? t('generalSettings.conflict.description')
                : t('generalSettings.stale.description')
            }
            extra={
              <Button onClick={discardAndRefresh}>{t('generalSettings.stale.refresh')}</Button>
            }
            message={
              revisionConflict
                ? t('generalSettings.conflict.title')
                : t('generalSettings.stale.title')
            }
          />
        ) : null}

        <section className={styles.card}>
          {/* Open registration */}
          <div className={styles.row}>
            <div className={styles.rowText}>
              <Text strong>{t('generalSettings.openRegistration.title')}</Text>
              <Text type="secondary">{t('generalSettings.openRegistration.desc')}</Text>
            </div>
            <Switch
              checked={draft.openRegistration}
              disabled={disabled}
              onChange={(checked) => patch({ openRegistration: checked })}
            />
          </div>

          <hr className={styles.divider} />

          {/* Email domain allowlist */}
          <div className={styles.row}>
            <div className={styles.rowText}>
              <Text strong>{t('generalSettings.emailAllowlist.title')}</Text>
              <Text type="secondary">{t('generalSettings.emailAllowlist.desc')}</Text>
              <div
                aria-hidden={!draft.emailDomainAllowlistEnabled}
                className={styles.allowlistReveal}
                data-open={draft.emailDomainAllowlistEnabled}
              >
                <div className={styles.allowlistRevealInner}>
                  <Flexbox gap={6} style={{ paddingTop: 8 }}>
                    <TextArea
                      disabled={disabled || !draft.emailDomainAllowlistEnabled}
                      placeholder={t('generalSettings.emailAllowlist.placeholder')}
                      rows={4}
                      value={draft.emailDomainText}
                      onChange={(event) => patch({ emailDomainText: event.target.value })}
                    />
                    <span className={styles.hint}>{t('generalSettings.emailAllowlist.hint')}</span>
                  </Flexbox>
                </div>
              </div>
            </div>
            <Switch
              checked={draft.emailDomainAllowlistEnabled}
              disabled={disabled}
              onChange={(checked) => patch({ emailDomainAllowlistEnabled: checked })}
            />
          </div>
        </section>

        {canUpdate ? (
          <div className={styles.footer}>
            <Button
              disabled={!dirty || serverStale || revisionConflict || baseRevision === null}
              loading={saving}
              type="primary"
              onClick={() => void handleSave()}
            >
              {t('generalSettings.save')}
            </Button>
          </div>
        ) : null}
      </AdminPageTemplate>
    );
  };

  return (
    <AsyncBoundary
      data={data}
      error={error}
      errorVariant="page"
      isLoading={isLoading}
      loading={<Loading debugId="AdminGeneralSettings" />}
      onRetry={() => void mutate()}
    >
      {data ? renderLoaded() : null}
    </AsyncBoundary>
  );
});

GeneralSettingsPage.displayName = 'GeneralSettingsPage';

export default GeneralSettingsPage;
