'use client';

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import type {
  AdminBrandingGetOutput,
  AdminBrandingSaveInput,
  AdminBrandingUploadAssetInput,
} from '@/enterprise/client/services/adminBranding';
import { adminBrandingService } from '@/enterprise/client/services/adminBranding';

import { readFileBase64 } from '../primitives/readFileBase64';
import { runAdminMutation } from '../primitives/runAdminMutation';
import { isValidPrimaryColor } from './PrimaryColorField';
import { hasBrandingChanges, useBrandingEditorStore } from './store';
import type { useFetchAdminBranding } from './useAdminBranding';

export interface UseBrandingPageActionsParams {
  authMethod?: AdminReauthAuthMethod | null;
  canSave: boolean;
  data: AdminBrandingGetOutput | undefined;
  mutate: ReturnType<typeof useFetchAdminBranding>['mutate'];
  noteObservedSnapshot: (revision: number, token: string) => void;
}

export interface UseBrandingPageActionsResult {
  actionError: string | null;
  actionNotice: string | null;
  busy: boolean;
  conflict: boolean;
  dirty: boolean;
  formatError: (cause: unknown) => string;
  refreshWarning: string | null;
  reload: () => Promise<void>;
  reloadFailed: boolean;
  retryingLoad: boolean;
  retryingRefresh: boolean;
  retryLoad: () => Promise<void>;
  retryRefresh: () => Promise<void>;
  save: () => Promise<void>;
  upload: (kind: AdminBrandingUploadAssetInput['kind'], file: File) => Promise<void>;
  valid: boolean;
}

export const useBrandingPageActions = ({
  authMethod,
  canSave,
  data,
  mutate,
  noteObservedSnapshot,
}: UseBrandingPageActionsParams): UseBrandingPageActionsResult => {
  const { t } = useTranslation('admin');
  const platform = useEnterprisePlatform();
  const {
    adopt,
    baseline,
    branding,
    editorState,
    markConflict,
    patch,
    patchDesktop,
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
  const conflict = editorState === 'conflict';
  const busy = editorState === 'saving';
  const changed = hasBrandingChanges(branding, baseline);
  const dirty = editorState === 'dirty' && changed;
  const valid =
    Boolean(branding?.name) && isValidPrimaryColor(branding?.themeDefaults.primaryColor ?? null);

  const formatError = useCallback(
    (cause: unknown): string => {
      const mapped = mapEnterpriseError(cause);
      return mapped ? t(mapped.i18nKey as never) : t('branding.errors.generic');
    },
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
      noteObservedSnapshot(latest.revision, latest.token);
      setReloadFailed(false);
    } catch {
      setReloadFailed(true);
    }
  }, [adopt, mutate, noteObservedSnapshot]);

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
      authMethod,
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
        if (adopted) noteObservedSnapshot(result.revision, result.token);
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
    adopt,
    authMethod,
    branding,
    busy,
    canSave,
    conflict,
    dirty,
    formatError,
    markConflict,
    mutate,
    noteObservedSnapshot,
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
        authMethod,
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
      authMethod,
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

  return {
    actionError,
    actionNotice,
    busy,
    conflict,
    dirty,
    formatError,
    refreshWarning,
    reload,
    reloadFailed,
    retryLoad,
    retryRefresh,
    retryingLoad,
    retryingRefresh,
    save,
    upload,
    valid,
  };
};
