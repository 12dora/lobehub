'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button, confirmModal } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { adminBrandingService } from '@/enterprise/client/services/adminBranding';
import type {
  AdminBrandingPublishInput,
  AdminBrandingRollbackInput,
  AdminBrandingSaveDraftInput,
  AdminBrandingUploadAssetInput,
} from '@/server/enterprise/contracts/adminBranding';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import RevisionBanner from '../primitives/RevisionBanner';
import { openReasonModal } from '../users/modals/openReasonModal';
import { BrandingFields } from './BrandingFields';
import { BrandingPreview } from './BrandingPreview';
import { createBrandingNavigationDecision } from './navigationDecision';
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

const readFileBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FILE_READ_FAILED'));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      const comma = value.indexOf(',');
      if (comma < 0) return reject(new Error('FILE_READ_FAILED'));
      resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });

const BrandingPage = memo(() => {
  const { t } = useTranslation('admin');
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
    markConflict,
    patch,
    reset,
    setEditorState,
    syncServer,
  } = useBrandingEditorStore();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const observedServerSnapshot = useRef<string | null>(null);
  const leaveModal = useRef<ReturnType<typeof confirmModal> | null>(null);
  const dirty = editorState === 'dirty';
  const conflict = editorState === 'conflict';

  useEffect(() => {
    if (!data) return;
    const snapshotKey = `${data.baseRevision}:${data.draftToken}:${data.published?.revision ?? ''}`;
    // After unmount/StrictMode cleanup the store is reset but this ref can still hold the
    // same snapshot key (mark-before-hydrate). Always rehydrate when draft is empty so
    // Inputs refill after leave→re-enter, HMR, or StrictMode double-invoke.
    if (!draft) {
      observedServerSnapshot.current = snapshotKey;
      hydrate(data);
      return;
    }
    if (observedServerSnapshot.current === snapshotKey) return;
    observedServerSnapshot.current = snapshotKey;
    if (data.draftToken !== draftToken || data.baseRevision !== baseRevision) {
      if (editorState === 'idle') hydrate(data);
      else markConflict();
    }
  }, [baseRevision, data, draft, draftToken, editorState, hydrate, markConflict]);

  const blocker = useBlocker(dirty);
  const blockerProceed = blocker.proceed;
  const blockerReset = blocker.reset;
  const blockerState = blocker.state;
  useEffect(() => {
    if (blockerState !== 'blocked') {
      leaveModal.current?.close();
      leaveModal.current = null;
      return;
    }
    if (leaveModal.current) return;
    const decision = createBrandingNavigationDecision({
      onCancel: () => {
        leaveModal.current = null;
        blockerReset?.();
      },
      onProceed: () => {
        leaveModal.current = null;
        blockerProceed?.();
      },
    });
    leaveModal.current = confirmModal({
      cancelText: t('branding.unsaved.stay'),
      content: t('branding.unsaved.description'),
      okText: t('branding.unsaved.leave'),
      onCancel: decision.cancel,
      onOk: decision.proceed,
      title: t('branding.unsaved.title'),
    });
  }, [blockerProceed, blockerReset, blockerState, t]);

  useEffect(
    () => () => {
      leaveModal.current?.destroy();
      // Clear observation so a remount with the same SWR snapshot can hydrate again
      // even if the module-level store was already emptied by reset().
      observedServerSnapshot.current = null;
      reset();
    },
    [reset],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const labels = useMemo(
    () =>
      Object.fromEntries(
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
          'upload',
        ].map((key) => [key, t(`branding.fields.${key}` as never)]),
      ),
    [t],
  );

  const refreshAuthoritative = useCallback(async () => {
    setActionError(null);
    setActionNotice(null);
    const refreshed = await mutate();
    if (refreshed) hydrate(refreshed);
  }, [hydrate, mutate]);

  const save = useCallback(() => {
    if (!draft || !canUpdate || !dirty || conflict) return;
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
          syncServer(result);
          setActionError(null);
          setActionNotice(t('branding.status.draftSaved'));
          void mutate();
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
    canUpdate,
    conflict,
    dirty,
    draft,
    draftToken,
    formatError,
    markConflict,
    mutate,
    setEditorState,
    syncServer,
    t,
  ]);

  const publish = useCallback(() => {
    if (!draft || !canPublish || dirty || conflict) return;
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
          await adminBrandingService.publish(payload as AdminBrandingPublishInput);
          setActionError(null);
          setActionNotice(t('branding.status.published'));
          const [brandingRefresh] = await Promise.allSettled([mutate(), platform.refresh()]);
          if (brandingRefresh.status === 'fulfilled' && brandingRefresh.value) {
            hydrate(brandingRefresh.value);
          } else {
            setEditorState('idle');
          }
        } catch (cause) {
          setActionError(formatError(cause));
          setEditorState('idle');
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
    conflict,
    dirty,
    draft,
    draftToken,
    formatError,
    hydrate,
    mutate,
    platform,
    setEditorState,
    t,
  ]);

  const rollback = useCallback(
    (targetRevision: number) => {
      if (!canPublish || !draft || dirty || conflict) return;
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
            void mutate();
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
      conflict,
      dirty,
      draft,
      draftToken,
      formatError,
      hydrate,
      markConflict,
      mutate,
      t,
    ],
  );

  const upload = useCallback(
    async (kind: AdminBrandingUploadAssetInput['kind'], file: File) => {
      if (!canUpdate || !data?.storageConfigured) return;
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
    [canUpdate, data?.storageConfigured, draft, formatError, patch, t],
  );

  if (isLoading || (!data && !error)) {
    return <Text role="status">{t('branding.loading')}</Text>;
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
  const pendingPublish = !dirty && !conflict && !draftMatchesPublished && Boolean(draft.name);
  return (
    <AdminPageTemplate
      description={t('branding.description', { platformName: branding.name })}
      title={t('branding.title', { platformName: branding.name })}
      actions={
        <div className={styles.actions}>
          <Button disabled={!canUpdate || !dirty || conflict || busy} onClick={save}>
            {t('branding.actions.save')}
          </Button>
          <Button
            disabled={!canPublish || dirty || conflict || busy || !draft.name}
            type="primary"
            onClick={publish}
          >
            {t('branding.actions.publish')}
          </Button>
        </div>
      }
      banner={
        <RevisionBanner
          conflict={conflict}
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
      {!canUpdate ? <Alert showIcon message={t('branding.readOnly')} type="info" /> : null}
      {pendingPublish ? (
        <Alert showIcon message={t('branding.status.pendingPublish')} type="info" />
      ) : null}
      {actionNotice ? <Alert showIcon message={actionNotice} type="success" /> : null}
      {actionError ? <Alert showIcon message={actionError} type="error" /> : null}
      <div className={styles.content}>
        <div className={styles.editor}>
          <BrandingFields
            disabled={!canUpdate || conflict || busy}
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
                    !canPublish || dirty || conflict || busy || revision.revision === baseRevision
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
