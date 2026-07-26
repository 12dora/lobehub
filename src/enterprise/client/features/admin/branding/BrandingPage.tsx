'use client';

import { Alert, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { adminBrandingService } from '@/enterprise/client/services/adminBranding';
import type {
  AdminBrandingDraft,
  AdminBrandingPublishInput,
  AdminBrandingRollbackInput,
  AdminBrandingSaveDraftInput,
  AdminBrandingUploadAssetInput,
} from '@/server/enterprise/contracts/adminBranding';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { readFileBase64 } from '../primitives/readFileBase64';
import RevisionBanner from '../primitives/RevisionBanner';
import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import { openReasonModal } from '../users/modals/openReasonModal';
import { BrandingFields } from './BrandingFields';
import { BrandingPreview } from './BrandingPreview';
import {
  clearBrandingLocalDraft,
  loadBrandingLocalDraft,
  saveBrandingLocalDraft,
} from './localDraftStorage';
import { useBrandingEditorStore } from './store';
import { useFetchAdminBranding } from './useAdminBranding';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
  content: css`
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
    gap: 16px;
    align-items: start;

    @media (width <= 960px) {
      grid-template-columns: 1fr;
    }
  `,
  editor: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  `,
  history: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  historyRow: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  preview: css`
    position: sticky;
    inset-block-start: 16px;

    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  status: css`
    color: ${cssVar.colorTextSecondary};
  `,
}));

const BrandingPage = memo(() => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const branding = useBranding();
  const formatError = useCallback(
    (cause: unknown): string => {
      const mapped = mapEnterpriseError(cause);
      return mapped ? t(mapped.i18nKey as never) : t('branding.errors.generic');
    },
    [t],
  );
  const admin = useAdminAccess();
  const platform = useEnterprisePlatform();
  const canRead = admin.permissions.includes(PLATFORM_PERMISSIONS.BRANDING_READ);
  const canUpdate = admin.permissions.includes(PLATFORM_PERMISSIONS.BRANDING_UPDATE);
  const canPublish = admin.permissions.includes(PLATFORM_PERMISSIONS.BRANDING_PUBLISH);
  const { data, error, isLoading, mutate } = useFetchAdminBranding({
    adminAllowed: admin.status === 'allowed',
    canRead,
  });
  const {
    baseRevision,
    draft,
    draftMatchesPublished,
    draftToken,
    editorState,
    hydrate,
    markCommittedRefresh,
    markConflict,
    patch,
    reset,
    setEditorState,
    syncServer,
  } = useBrandingEditorStore();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [runtimeRefreshPending, setRuntimeRefreshPending] = useState(false);
  const [recoveryOffer, setRecoveryOffer] = useState<AdminBrandingDraft | null>(null);
  const committedPublishRevisionRef = useRef<number | null>(null);
  const observedServerSnapshot = useRef<string | null>(null);
  const recoveryCheckedRevisionRef = useRef<number | null>(null);
  const dirty = editorState === 'dirty';
  const conflict = editorState === 'conflict';
  const committedRefresh = editorState === 'committedRefresh';
  /** Mutations stay locked on CAS conflict and after a committed publish whose refresh failed. */
  const mutationLocked = conflict || committedRefresh || runtimeRefreshPending;

  useEffect(() => {
    if (!data) return;
    const snapshotKey = `${data.baseRevision}:${data.draftToken}:${data.published?.revision ?? ''}`;
    if (draft && observedServerSnapshot.current === snapshotKey) return;
    const committedPublishRevision = committedPublishRevisionRef.current;
    if (
      committedPublishRevision !== null &&
      (data.baseRevision < committedPublishRevision ||
        (data.published?.revision ?? 0) < committedPublishRevision)
    ) {
      // A fulfilled SWR update can still be an older cached snapshot. Keep the editor
      // locked until both authoritative pointers have reached the committed publish.
      observedServerSnapshot.current = snapshotKey;
      if (editorState !== 'committedRefresh') markCommittedRefresh();
      return;
    }
    // After unmount/StrictMode cleanup the store is reset but this ref can still hold the
    // same snapshot key (mark-before-hydrate). Always rehydrate when draft is empty so
    // Inputs refill after leave→re-enter, HMR, or StrictMode double-invoke.
    if (!draft) {
      observedServerSnapshot.current = snapshotKey;
      hydrate(data);
      if (recoveryCheckedRevisionRef.current !== data.baseRevision) {
        recoveryCheckedRevisionRef.current = data.baseRevision;
        const local = loadBrandingLocalDraft(data.baseRevision);
        if (
          local &&
          local.draftToken === data.draftToken &&
          JSON.stringify(local.draft) !== JSON.stringify(data.draft)
        ) {
          setRecoveryOffer(local.draft);
        } else {
          setRecoveryOffer(null);
        }
      }
      return;
    }
    observedServerSnapshot.current = snapshotKey;
    if (data.draftToken !== draftToken || data.baseRevision !== baseRevision) {
      if (editorState === 'idle' || editorState === 'committedRefresh') {
        hydrate(data);
        setRecoveryOffer(null);
      } else if (editorState !== 'conflict') markConflict();
    }
  }, [
    baseRevision,
    data,
    draft,
    draftToken,
    editorState,
    hydrate,
    markCommittedRefresh,
    markConflict,
  ]);

  // Persist non-secret dirty drafts for crash/reload recovery (store resets on unmount).
  useEffect(() => {
    if (!dirty || !draft || mutationLocked) return;
    saveBrandingLocalDraft({
      baseRevision,
      draft,
      draftToken,
      savedAt: new Date().toISOString(),
    });
  }, [baseRevision, dirty, draft, draftToken, mutationLocked]);

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('branding.unsaved.stay'),
      content: t('branding.unsaved.description'),
      okText: t('branding.unsaved.leave'),
      title: t('branding.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({ enabled: dirty, messages: unsavedMessages });

  useEffect(
    () => () => {
      // Clear observation so a remount with the same SWR snapshot can hydrate again
      // even if the module-level store was already emptied by reset().
      observedServerSnapshot.current = null;
      reset();
    },
    [reset],
  );

  const labels = useMemo(() => {
    // English fallbacks for keys not yet in the locale pack (i18n batch fills zh-CN / en-US).
    const defaults: Record<string, string> = {
      theme: 'Theme',
    };
    return Object.fromEntries(
      [
        'assets',
        'defaultAgentDisplayName',
        'desktop',
        'desktopIcon',
        'desktopProductName',
        'effectiveCurrent',
        'email',
        'emailFrom',
        'emailSenderName',
        'faviconUrl',
        'homeUrl',
        'iconUrl',
        'identity',
        'immediate',
        'legalName',
        'links',
        'logoUrl',
        'name',
        'ogImageUrl',
        'pageTitleTemplate',
        'primaryColor',
        'privacyUrl',
        'rebuildRequired',
        'shortName',
        'supportUrl',
        'termsUrl',
        'theme',
        'upload',
      ].map((key) => [
        key,
        t(`branding.fields.${key}` as never, {
          defaultValue: defaults[key],
        }),
      ]),
    );
  }, [t]);

  const refreshAuthoritative = useCallback(async () => {
    setActionError(null);
    setActionNotice(null);
    const [adminRefresh, runtimeRefresh] = await Promise.allSettled([mutate(), platform.refresh()]);
    const committedPublishRevision = committedPublishRevisionRef.current;
    const refreshed = adminRefresh.status === 'fulfilled' ? adminRefresh.value : undefined;
    const adminRefreshAuthoritative =
      refreshed !== undefined &&
      (committedPublishRevision === null ||
        (refreshed.baseRevision >= committedPublishRevision &&
          (refreshed.published?.revision ?? 0) >= committedPublishRevision));
    if (adminRefreshAuthoritative) {
      hydrate(refreshed);
    } else {
      markCommittedRefresh();
    }
    if (!adminRefreshAuthoritative || runtimeRefresh.status === 'rejected') {
      if (runtimeRefresh.status === 'rejected') setRuntimeRefreshPending(true);
      setRefreshWarning(
        committedPublishRevision !== null && !adminRefreshAuthoritative
          ? t('branding.refresh.committedFailed')
          : t('branding.refresh.postCommitFailed'),
      );
      return;
    }
    committedPublishRevisionRef.current = null;
    setRuntimeRefreshPending(false);
    setRefreshWarning(null);
  }, [hydrate, markCommittedRefresh, mutate, platform, t]);

  const save = useCallback(() => {
    if (!draft || !canUpdate || !dirty || mutationLocked) return;
    openReasonModal({
      buildPayload: (reason) => ({
        draft,
        expectedDraftToken: draftToken,
        reason,
        requestId: crypto.randomUUID(),
      }),
      description: t('branding.save.description'),
      onSubmit: async (payload) => {
        setEditorState('saving');
        try {
          const result = await adminBrandingService.saveDraft(
            payload as AdminBrandingSaveDraftInput,
          );
          clearBrandingLocalDraft(baseRevision);
          syncServer(result);
          setRecoveryOffer(null);
          setActionError(null);
          setActionNotice(t('branding.status.draftSaved'));
          try {
            const refreshed = await mutate();
            if (!refreshed) throw new Error('BRANDING_REFRESH_EMPTY');
            if (
              refreshed.baseRevision < result.baseRevision ||
              refreshed.draftToken !== result.draftToken
            ) {
              throw new Error('BRANDING_REFRESH_STALE');
            }
            hydrate(refreshed);
            setRefreshWarning(null);
          } catch (refreshError) {
            console.error('Branding post-save refresh failed', refreshError);
            setRefreshWarning(t('branding.refresh.postCommitFailed'));
          }
        } catch (cause) {
          const isConflict = mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT';
          if (isConflict) markConflict();
          setActionError(formatError(cause));
          if (!isConflict) setEditorState('dirty');
          throw cause;
        }
      },
      submitLabel: t('branding.actions.save'),
      targetLabel: t('branding.title'),
      title: t('branding.save.title'),
    });
  }, [
    baseRevision,
    canUpdate,
    dirty,
    draft,
    draftToken,
    formatError,
    hydrate,
    markConflict,
    mutate,
    mutationLocked,
    setEditorState,
    syncServer,
    t,
  ]);

  const publish = useCallback(() => {
    if (!draft || !canPublish || dirty || mutationLocked) return;
    openReasonModal({
      authMethod: admin.authMethod,
      buildPayload: (reason) => ({
        expectedDraftToken: draftToken,
        expectedRevision: baseRevision,
        reason,
        requestId: crypto.randomUUID(),
      }),
      description: t('branding.publish.description'),
      impact: t('branding.publish.impact'),
      onSubmit: async (payload) => {
        setEditorState('publishing');
        try {
          const result = await adminBrandingService.publish(payload as AdminBrandingPublishInput);
          committedPublishRevisionRef.current = result.revision;
          clearBrandingLocalDraft(baseRevision);
          setRecoveryOffer(null);
          setActionError(null);
          setActionNotice(t('branding.status.published'));
          const [brandingRefresh, runtimeRefresh] = await Promise.allSettled([
            mutate(),
            platform.refresh(),
          ]);
          const refreshed =
            brandingRefresh.status === 'fulfilled' ? brandingRefresh.value : undefined;
          const adminRefreshAuthoritative =
            refreshed !== undefined &&
            refreshed.baseRevision >= result.revision &&
            (refreshed.published?.revision ?? 0) >= result.revision;
          if (adminRefreshAuthoritative) {
            hydrate(refreshed);
          } else {
            // Publish already committed — lock mutations until an authoritative refresh lands.
            markCommittedRefresh();
          }
          if (!adminRefreshAuthoritative || runtimeRefresh.status === 'rejected') {
            if (runtimeRefresh.status === 'rejected') setRuntimeRefreshPending(true);
            setRefreshWarning(
              !adminRefreshAuthoritative
                ? t('branding.refresh.committedFailed')
                : t('branding.refresh.postCommitFailed'),
            );
          } else {
            committedPublishRevisionRef.current = null;
            setRuntimeRefreshPending(false);
            setRefreshWarning(null);
          }
        } catch (cause) {
          const isConflict = mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT';
          if (isConflict) markConflict();
          else setEditorState('idle');
          setActionError(formatError(cause));
          throw cause;
        }
      },
      submitLabel: t('branding.actions.publish'),
      targetLabel: draft.name ?? t('branding.title'),
      title: t('branding.publish.title'),
    });
  }, [
    admin.authMethod,
    baseRevision,
    canPublish,
    dirty,
    draft,
    draftToken,
    formatError,
    hydrate,
    markCommittedRefresh,
    markConflict,
    mutate,
    mutationLocked,
    platform,
    setEditorState,
    t,
  ]);

  const rollback = useCallback(
    (targetRevision: number) => {
      if (!canPublish || !draft || dirty || mutationLocked) return;
      openReasonModal({
        authMethod: admin.authMethod,
        buildPayload: (reason) => ({
          expectedDraftToken: draftToken,
          expectedRevision: baseRevision,
          reason,
          requestId: crypto.randomUUID(),
          targetRevision,
        }),
        danger: true,
        description: t('branding.rollback.description', { revision: targetRevision }),
        impact: t('branding.rollback.impact'),
        onSubmit: async (payload) => {
          try {
            const result = await adminBrandingService.rollback(
              payload as AdminBrandingRollbackInput,
            );
            hydrate({ ...result, draftMatchesPublished: false });
            setActionError(null);
            setActionNotice(t('branding.status.restoredDraft'));
            try {
              const refreshed = await mutate();
              if (!refreshed) throw new Error('BRANDING_REFRESH_EMPTY');
              if (
                refreshed.baseRevision < result.baseRevision ||
                refreshed.draftToken !== result.draftToken
              ) {
                throw new Error('BRANDING_REFRESH_STALE');
              }
              hydrate(refreshed);
              setRefreshWarning(null);
            } catch (refreshError) {
              console.error('Branding post-rollback refresh failed', refreshError);
              setRefreshWarning(t('branding.refresh.postCommitFailed'));
            }
          } catch (cause) {
            if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') markConflict();
            setActionError(formatError(cause));
            throw cause;
          }
        },
        submitLabel: t('branding.actions.restoreDraft'),
        targetLabel: `#${targetRevision}`,
        title: t('branding.rollback.title'),
      });
    },
    [
      admin.authMethod,
      baseRevision,
      canPublish,
      dirty,
      draft,
      draftToken,
      formatError,
      hydrate,
      markConflict,
      mutate,
      mutationLocked,
      t,
    ],
  );

  const upload = useCallback(
    async (kind: AdminBrandingUploadAssetInput['kind'], file: File) => {
      if (!canUpdate || mutationLocked || !data?.storageConfigured) return;
      try {
        const bytesBase64 = await readFileBase64(file);
        openReasonModal({
          buildPayload: (reason) => ({
            bytesBase64,
            fileName: file.name,
            kind,
            reason,
            requestId: crypto.randomUUID(),
          }),
          description: t('branding.upload.description'),
          onSubmit: async (payload) => {
            try {
              const result = await adminBrandingService.uploadAsset(
                payload as AdminBrandingUploadAssetInput,
              );
              if (kind === 'desktopIcon') {
                patch({ desktop: { ...draft!.desktop, iconUrl: result.url } });
              } else {
                const field = {
                  favicon: 'faviconUrl',
                  icon: 'iconUrl',
                  logo: 'logoUrl',
                  ogImage: 'ogImageUrl',
                }[kind] as 'faviconUrl' | 'iconUrl' | 'logoUrl' | 'ogImageUrl';
                patch({ [field]: result.url });
              }
              setActionError(null);
              setActionNotice(t('branding.status.assetUploaded'));
            } catch (cause) {
              setActionError(formatError(cause));
              throw cause;
            }
          },
          submitLabel: t('branding.actions.upload'),
          targetLabel: file.name,
          title: t('branding.upload.title'),
        });
      } catch (cause) {
        setActionError(formatError(cause));
      }
    },
    [canUpdate, data?.storageConfigured, draft, formatError, mutationLocked, patch, t],
  );

  if (isLoading || (!data && !error)) {
    return (
      <div aria-label={t('branding.loading')} role="status">
        <Skeleton title active={!reduceMotion} paragraph={{ rows: 8 }} />
      </div>
    );
  }
  if (error) {
    return (
      <Alert
        showIcon
        extra={<Button onClick={() => void mutate()}>{t('branding.actions.retry')}</Button>}
        message={formatError(error)}
        type="error"
      />
    );
  }
  if (!data || !draft) return <Text>{t('branding.empty')}</Text>;

  const busy = editorState === 'saving' || editorState === 'publishing';
  const pendingPublish = !dirty && !mutationLocked && !draftMatchesPublished && Boolean(draft.name);
  return (
    <AdminPageTemplate
      description={t('branding.description', { platformName: branding.name })}
      title={t('branding.title', { platformName: branding.name })}
      actions={
        <div className={styles.actions}>
          <Button disabled={!canUpdate || !dirty || mutationLocked || busy} onClick={save}>
            {t('branding.actions.save')}
          </Button>
          <Button
            disabled={!canPublish || dirty || mutationLocked || busy || !draft.name}
            type="primary"
            onClick={publish}
          >
            {t('branding.actions.publish')}
          </Button>
        </div>
      }
      banner={
        <RevisionBanner
          conflict={conflict || committedRefresh}
          draftRevision={baseRevision}
          publishedRevision={data.published?.revision ?? null}
          status={
            dirty ? 'draft' : pendingPublish ? 'pending' : data.published ? 'published' : 'draft'
          }
          onRefresh={() => void refreshAuthoritative()}
        />
      }
    >
      {!data.storageConfigured ? (
        <Alert showIcon message={t('branding.storageUnavailable')} type="warning" />
      ) : null}
      {recoveryOffer && !mutationLocked ? (
        <Alert
          showIcon
          description={t('branding.recovery.description')}
          message={t('branding.recovery.title')}
          type="info"
          extra={
            <div className={styles.actions}>
              <Button
                type="primary"
                onClick={() => {
                  if (!recoveryOffer) return;
                  hydrate({
                    baseRevision,
                    draft: recoveryOffer,
                    draftMatchesPublished: false,
                    draftToken,
                  });
                  setEditorState('dirty');
                  setRecoveryOffer(null);
                }}
              >
                {t('branding.recovery.restore')}
              </Button>
              <Button
                onClick={() => {
                  clearBrandingLocalDraft(baseRevision);
                  setRecoveryOffer(null);
                }}
              >
                {t('branding.recovery.discard')}
              </Button>
            </div>
          }
        />
      ) : null}
      {!canUpdate ? <Alert showIcon message={t('branding.readOnly')} type="info" /> : null}
      {committedRefresh || refreshWarning ? (
        <Alert
          extraIsolate
          showIcon
          description={refreshWarning}
          message={t('branding.refresh.committedTitle')}
          type="warning"
          extra={
            <Button onClick={() => void refreshAuthoritative()}>
              {t('branding.refresh.retry', { defaultValue: 'Retry refresh' })}
            </Button>
          }
        />
      ) : null}
      {pendingPublish ? (
        <Alert showIcon message={t('branding.status.pendingPublish')} type="info" />
      ) : null}
      {actionNotice ? <Alert showIcon message={actionNotice} type="success" /> : null}
      {actionError ? <Alert showIcon message={actionError} type="error" /> : null}
      <div className={styles.content}>
        <div className={styles.editor}>
          <BrandingFields
            disabled={!canUpdate || mutationLocked || busy}
            draft={draft}
            effective={branding}
            labels={labels}
            storageConfigured={data.storageConfigured}
            onPatch={patch}
            onUpload={(kind, file) => void upload(kind, file)}
          />
          <section className={styles.history}>
            <Text as="h2">{t('branding.history.title')}</Text>
            {data.revisions.length === 0 ? (
              <Text type="secondary">{t('branding.history.empty')}</Text>
            ) : null}
            {data.revisions.map((revision) => (
              <div className={styles.historyRow} key={revision.revision}>
                <div>
                  <Text>#{revision.revision}</Text>
                  <div className={styles.status}>
                    {revision.reason ?? t('branding.history.noReason')}
                  </div>
                </div>
                <Button
                  danger
                  size="small"
                  disabled={
                    !canPublish ||
                    dirty ||
                    mutationLocked ||
                    busy ||
                    revision.revision === baseRevision
                  }
                  onClick={() => rollback(revision.revision)}
                >
                  {t('branding.actions.restoreDraft')}
                </Button>
              </div>
            ))}
          </section>
        </div>
        <aside className={styles.preview}>
          <Text as="h2">{t('branding.preview.title')}</Text>
          <Text type="secondary">{t('branding.preview.description')}</Text>
          <BrandingPreview
            draft={draft}
            effective={branding}
            title={t('branding.preview.frameTitle')}
            copy={{
              defaultAgent: t('branding.preview.defaultAgent'),
              defaultName: t('branding.preview.defaultName'),
              signIn: t('branding.preview.signIn'),
              workspace: t('branding.preview.workspace'),
            }}
          />
        </aside>
      </div>
    </AdminPageTemplate>
  );
});

BrandingPage.displayName = 'BrandingPage';

export default BrandingPage;
