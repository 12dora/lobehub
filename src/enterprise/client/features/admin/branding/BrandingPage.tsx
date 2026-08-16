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
import {
  type AdminBrandingSaveInput,
  adminBrandingService,
  type AdminBrandingUploadAssetInput,
} from '@/enterprise/client/services/adminBranding';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { readFileBase64 } from '../primitives/readFileBase64';
import { runAdminMutation } from '../primitives/runAdminMutation';
import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import { BrandingFields } from './BrandingFields';
import { BrandingPreview } from './BrandingPreview';
import { isValidPrimaryColor } from './PrimaryColorField';
import { usePruneLegacyBrandingDrafts } from './pruneLegacyBrandingDrafts';
import { hasBrandingChanges, useBrandingEditorStore } from './store';
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
  const runtimeBranding = useBranding();
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
  /** Saving is publishing now — both write permissions are required to change anything. */
  const canSave = canUpdate && canPublish;
  usePruneLegacyBrandingDrafts();
  const { data, error, isLoading, mutate } = useFetchAdminBranding({
    adminAllowed: admin.status === 'allowed',
    canRead,
  });
  const {
    adopt,
    baseline,
    branding,
    editorState,
    markConflict,
    patch,
    patchDesktop,
    reset,
    revision,
    setEditorState,
    token,
  } = useBrandingEditorStore();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [reloadFailed, setReloadFailed] = useState(false);
  const [retryingLoad, setRetryingLoad] = useState(false);
  const [retryingRefresh, setRetryingRefresh] = useState(false);
  const observedServerSnapshot = useRef<string | null>(null);
  const conflict = editorState === 'conflict';
  const busy = editorState === 'saving';
  const changed = hasBrandingChanges(branding, baseline);
  const dirty = editorState === 'dirty' && changed;
  const valid =
    Boolean(branding?.name) && isValidPrimaryColor(branding?.themeDefaults.primaryColor ?? null);

  useEffect(() => {
    if (!data) return;
    const snapshotKey = `${data.revision}:${data.token}`;
    // After unmount/StrictMode cleanup the store is reset while this ref can still hold the
    // same snapshot key. Always rehydrate when the form is empty so inputs refill.
    if (!branding) {
      observedServerSnapshot.current = snapshotKey;
      adopt(data);
      return;
    }
    if (observedServerSnapshot.current === snapshotKey) return;
    observedServerSnapshot.current = snapshotKey;
    if (data.token === token && data.revision === revision) return;
    // Revisions only ever move forward: a fulfilled read that is older than what we already
    // hold is a stale cache, never an authority to roll the editor back.
    if (data.revision < revision) return;
    // Someone else saved. An editor with nothing of its own simply follows; unsaved edits and
    // in-flight saves are never overwritten.
    if (!changed && editorState !== 'saving') adopt(data);
    else if (editorState !== 'conflict') markConflict(data.revision);
  }, [adopt, branding, changed, data, editorState, markConflict, revision, token]);

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('branding.unsaved.stay'),
      content: t('branding.unsaved.description'),
      okText: t('branding.unsaved.leave'),
      title: t('branding.unsaved.title'),
    }),
    [t],
  );
  // Armed by the values themselves, not by save eligibility: edits are just as losable while
  // a save is in flight or the editor is conflicted.
  useUnsavedChangesGuard({ enabled: changed, messages: unsavedMessages });

  useEffect(
    () => () => {
      // Clear observation so a remount with the same SWR snapshot can hydrate again
      // even if the module-level store was already emptied by reset().
      observedServerSnapshot.current = null;
      reset();
    },
    [reset],
  );

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
          'nameRequired',
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
        ].map((key) => [key, t(`branding.fields.${key}` as never)]),
      ),
    [t],
  );

  /**
   * Someone else saved first — nothing of ours committed. Load the live values and only then
   * drop the local edits: on a failed reload the old values are all we have, so keep them
   * (and the retry) instead of claiming the latest ones loaded.
   */
  const reload = useCallback(async () => {
    setActionError(null);
    setActionNotice(null);
    try {
      const latest = await mutate();
      if (!latest) throw new Error('BRANDING_LATEST_UNAVAILABLE');
      // A cached read older than what we already observed is not the live state either.
      if (!adopt(latest)) throw new Error('BRANDING_LATEST_STALE');
      observedServerSnapshot.current = `${latest.revision}:${latest.token}`;
      setReloadFailed(false);
    } catch {
      setReloadFailed(true);
    }
  }, [adopt, mutate]);

  const retryLoad = useCallback(async () => {
    setRetryingLoad(true);
    try {
      await mutate();
    } catch {
      // The load error alert already carries the failure; a rejected retry must not escape.
    } finally {
      setRetryingLoad(false);
    }
  }, [mutate]);

  const retryRefresh = useCallback(async () => {
    setRetryingRefresh(true);
    try {
      await platform.refresh();
      setRefreshWarning(null);
    } catch {
      setRefreshWarning(t('branding.refresh.postCommitFailed'));
    } finally {
      setRetryingRefresh(false);
    }
  }, [platform, t]);

  const save = useCallback(async () => {
    if (!branding || !canSave || !dirty || !valid || busy || conflict) return;
    // Freeze the exact payload (branding + CAS + idempotency key) before the write so a reauth
    // retry replays the same request instead of a newer, half-edited one.
    const payload: AdminBrandingSaveInput = {
      branding,
      expectedRevision: revision,
      expectedToken: token,
      requestId: crypto.randomUUID(),
    };
    setEditorState('saving');
    await runAdminMutation({
      authMethod: admin.authMethod,
      onError: (cause) => {
        const isConflict = mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT';
        if (isConflict) markConflict();
        else setEditorState('dirty');
        setActionError(formatError(cause));
      },
      run: async () => {
        const result = await adminBrandingService.save(payload);
        // A response that lands after a newer revision was already observed is history:
        // it committed, but it must not roll the editor or the cache back over the newer one.
        const adopted = adopt(result);
        if (adopted) observedServerSnapshot.current = `${result.revision}:${result.token}`;
        else markConflict(result.revision);
        setActionError(null);
        setActionNotice(t('branding.status.saved'));
        // The save response is authoritative — only the runtime snapshot still needs a refresh.
        const [runtimeRefresh] = await Promise.allSettled([
          platform.refresh(),
          adopted
            ? mutate(
                (current) =>
                  !current || current.revision > result.revision
                    ? current
                    : { ...current, ...result },
                { revalidate: false },
              )
            : Promise.resolve(),
        ]);
        setRefreshWarning(
          runtimeRefresh.status === 'rejected' ? t('branding.refresh.postCommitFailed') : null,
        );
      },
    });
  }, [
    admin.authMethod,
    adopt,
    branding,
    busy,
    canSave,
    conflict,
    dirty,
    formatError,
    markConflict,
    mutate,
    platform,
    revision,
    setEditorState,
    t,
    token,
    valid,
  ]);

  const upload = useCallback(
    async (kind: AdminBrandingUploadAssetInput['kind'], file: File) => {
      if (!canSave || conflict || busy || !data?.storageConfigured) return;
      let payload: AdminBrandingUploadAssetInput;
      try {
        payload = {
          bytesBase64: await readFileBase64(file),
          fileName: file.name,
          kind,
          requestId: crypto.randomUUID(),
        };
      } catch (cause) {
        setActionError(formatError(cause));
        return;
      }
      await runAdminMutation({
        authMethod: admin.authMethod,
        onError: (cause) => setActionError(formatError(cause)),
        run: async () => {
          const result = await adminBrandingService.uploadAsset(payload);
          // Merge against the current values: a newer snapshot may have hydrated during
          // the file read and the upload itself.
          if (kind === 'desktopIcon') {
            patchDesktop({ iconUrl: result.url });
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
        },
      });
    },
    [
      admin.authMethod,
      busy,
      canSave,
      conflict,
      data?.storageConfigured,
      formatError,
      patch,
      patchDesktop,
      t,
    ],
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
        extraIsolate
        showIcon
        message={formatError(error)}
        type="error"
        extra={
          <Button loading={retryingLoad} onClick={() => void retryLoad()}>
            {t('branding.actions.retry')}
          </Button>
        }
      />
    );
  }
  if (!data || !branding) return <Text>{t('branding.empty')}</Text>;

  return (
    <AdminPageTemplate
      description={t('branding.description', { platformName: runtimeBranding.name })}
      title={t('branding.title', { platformName: runtimeBranding.name })}
      actions={
        <div className={styles.actions}>
          <Button
            disabled={!canSave || !dirty || !valid || busy || conflict}
            loading={busy}
            type="primary"
            onClick={() => void save()}
          >
            {t('branding.actions.save')}
          </Button>
        </div>
      }
      banner={
        conflict ? (
          <Alert
            extraIsolate
            showIcon
            extra={<Button onClick={() => void reload()}>{t('branding.conflict.reload')}</Button>}
            message={t('branding.conflict.title')}
            type="warning"
            description={
              reloadFailed
                ? t('branding.conflict.reloadFailed')
                : t('branding.conflict.description')
            }
          />
        ) : null
      }
      notice={
        data.updatedAt ? (
          <span className={styles.status}>
            {t('branding.lastSaved', { time: new Date(data.updatedAt).toLocaleString() })}
          </span>
        ) : null
      }
    >
      {!data.storageConfigured ? (
        <Alert showIcon message={t('branding.storageUnavailable')} type="warning" />
      ) : null}
      {!canSave ? <Alert showIcon message={t('branding.readOnly')} type="info" /> : null}
      {refreshWarning ? (
        <Alert
          extraIsolate
          showIcon
          message={refreshWarning}
          type="warning"
          extra={
            <Button loading={retryingRefresh} onClick={() => void retryRefresh()}>
              {t('branding.refresh.retry')}
            </Button>
          }
        />
      ) : null}
      {actionNotice ? <Alert showIcon message={actionNotice} type="success" /> : null}
      {actionError ? <Alert showIcon message={actionError} type="error" /> : null}
      <div className={styles.content}>
        <div className={styles.editor}>
          <BrandingFields
            branding={branding}
            disabled={!canSave || conflict || busy}
            effective={runtimeBranding}
            labels={labels}
            storageConfigured={data.storageConfigured}
            onPatch={patch}
            onUpload={(kind, file) => void upload(kind, file)}
          />
        </div>
        <aside className={styles.preview}>
          <Text as="h2">{t('branding.preview.title')}</Text>
          <Text type="secondary">{t('branding.preview.description')}</Text>
          <BrandingPreview
            branding={branding}
            effective={runtimeBranding}
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
