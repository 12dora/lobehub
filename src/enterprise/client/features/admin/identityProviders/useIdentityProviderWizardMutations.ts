'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { copyToClipboard } from '@lobehub/ui';
import { toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { IDENTITY_PROVIDER_AUTO_REASON } from '@/enterprise/client/features/admin/audit/shared/auditReasonCodes';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import { openReasonModal } from '../users/modals/openReasonModal';
import { openIdentityProviderTestPopup } from './controller';
import {
  canPersistIdentityProviderDraft,
  type IdentityProviderPersistRequest,
  type IdentityProviderPersistResult,
  resolveIdentityProviderSecretMutation,
  shouldSkipIdentityProviderPersist,
  toWritableIdentityProviderFields,
} from './persist';
import type { EditableDraft } from './steps';
import { useIdentityProviderAutosave } from './useIdentityProviderAutosave';
import { resolveIdentityProviderWizardErrorMessage } from './wizardErrorMessage';

interface UseIdentityProviderWizardMutationsInput {
  authMethod: AdminReauthAuthMethod;
  canCreate: boolean;
  canUpdate: boolean;
  captureBlockedReason: string | null;
  clearSecret: boolean;
  contentDirty: boolean;
  dirty: boolean;
  draft: EditableDraft;
  draftWorkflowReady: boolean;
  invalidJson: boolean;
  lastProviderRevisionRef: MutableRefObject<number | undefined>;
  onRefresh: () => Promise<unknown>;
  onSaved: (saved?: PlatformIdentityProviderDraft) => Promise<unknown>;
  persistRef?: { current: (() => Promise<IdentityProviderPersistResult>) | null };
  preserveDraftOnRefreshRef: MutableRefObject<boolean>;
  provider?: PlatformIdentityProviderDraft;
  providerKeyError: string | null;
  providerRef: MutableRefObject<PlatformIdentityProviderDraft | undefined>;
  resetWait: () => void;
  secret: string;
  secretDirty: boolean;
  setAttempt: Dispatch<SetStateAction<{ id: string; revision: number; startedAt: number } | null>>;
  setBusy: Dispatch<SetStateAction<string | null>>;
  setCaptureAttemptId: Dispatch<SetStateAction<string | null>>;
  setClearSecret: Dispatch<SetStateAction<boolean>>;
  setConflict: Dispatch<SetStateAction<boolean>>;
  setConflictRefreshFailed: Dispatch<SetStateAction<boolean>>;
  setDiscovery: Dispatch<
    SetStateAction<Awaited<ReturnType<typeof adminIdentityProvidersService.discover>> | null>
  >;
  setLastAutoSavedAt: Dispatch<SetStateAction<Date | null>>;
  setNetworkValid: Dispatch<SetStateAction<boolean>>;
  setSecret: Dispatch<SetStateAction<string>>;
  setTestPolling: Dispatch<SetStateAction<boolean>>;
  setTestWaitMessage: Dispatch<SetStateAction<string | null>>;
  t: TFunction<'admin'>;
  testPopupRef: MutableRefObject<Window | null>;
  testSucceeded: boolean;
}

export const useIdentityProviderWizardMutations = ({
  authMethod,
  canCreate,
  canUpdate,
  captureBlockedReason,
  clearSecret,
  contentDirty,
  dirty,
  draft,
  draftWorkflowReady,
  invalidJson,
  lastProviderRevisionRef,
  onRefresh,
  onSaved,
  persistRef,
  preserveDraftOnRefreshRef,
  provider,
  providerKeyError,
  providerRef,
  resetWait,
  secret,
  secretDirty,
  setAttempt,
  setBusy,
  setCaptureAttemptId,
  setClearSecret,
  setConflict,
  setConflictRefreshFailed,
  setDiscovery,
  setLastAutoSavedAt,
  setNetworkValid,
  setSecret,
  setTestPolling,
  setTestWaitMessage,
  t,
  testPopupRef,
  testSucceeded,
}: UseIdentityProviderWizardMutationsInput) => {
  const { enqueuePersist, scheduleAutosave, setPersist } = useIdentityProviderAutosave({
    persistRef,
  });

  const friendlyError = (cause: unknown): string =>
    resolveIdentityProviderWizardErrorMessage(cause, t);

  const refreshConflict = async () => {
    setConflictRefreshFailed(false);
    try {
      await onRefresh();
    } catch {
      setConflictRefreshFailed(true);
    }
  };

  const handleRevisionConflict = async (cause: unknown): Promise<boolean> => {
    if (mapEnterpriseError(cause)?.code !== 'PLATFORM_REVISION_CONFLICT') return false;
    setConflict(true);
    preserveDraftOnRefreshRef.current = true;
    await refreshConflict();
    return true;
  };

  const run = async (name: string, action: () => Promise<void>, propagate = true) => {
    setBusy(name);
    try {
      await action();
    } catch (cause) {
      await handleRevisionConflict(cause);
      // Surface all operation failures as a toast; the wizard body stays about the form.
      toast.error(friendlyError(cause));
      if (propagate) throw cause;
    } finally {
      setBusy(null);
    }
  };

  const copyUrl = async (url: string) => {
    if (!url) return;
    try {
      await copyToClipboard(url);
      toast.success(t('identityProviders.callback.copied'));
    } catch {
      toast.error(t('identityProviders.callback.copyFailed'));
    }
  };

  const persistDraft = async (
    input: IdentityProviderPersistRequest,
  ): Promise<IdentityProviderPersistResult> => {
    const currentProvider = providerRef.current;
    const canWrite = currentProvider ? canUpdate : canCreate;
    if (
      !canWrite ||
      !canPersistIdentityProviderDraft({
        displayName: draft.displayName,
        invalidJson,
        providerKey: draft.providerKey,
        providerKeyError,
      })
    ) {
      if (!input.silent) {
        toast.error(providerKeyError ?? t('identityProviders.errors.required'));
      }
      return 'blocked';
    }
    // Never call update when neither content nor an explicit secret mutation is dirty.
    if (
      shouldSkipIdentityProviderPersist({
        contentDirty,
        includeSecret: input.includeSecret,
        secretDirty,
      })
    ) {
      return 'clean';
    }

    const writable = toWritableIdentityProviderFields(draft);
    const secretMutation = input.includeSecret
      ? resolveIdentityProviderSecretMutation({
          clearSecret,
          isCreate: !currentProvider,
          secret,
        })
      : resolveIdentityProviderSecretMutation({
          clearSecret: false,
          isCreate: !currentProvider,
          secret: '',
        });

    try {
      // Preserve local keystrokes that arrive while this request is in flight.
      preserveDraftOnRefreshRef.current = true;
      let saved: PlatformIdentityProviderDraft;
      if (currentProvider) {
        saved = await adminIdentityProvidersService.update({
          ...writable,
          expectedRevision: lastProviderRevisionRef.current ?? currentProvider.revision,
          id: currentProvider.id,
          secret: secretMutation,
        });
      } else {
        saved = await adminIdentityProvidersService.create({
          ...writable,
          secret: secretMutation.operation === 'keep' ? { operation: 'clear' } : secretMutation,
        });
      }
      lastProviderRevisionRef.current = saved.revision;
      providerRef.current = saved;
      if (input.includeSecret) {
        setSecret('');
        setClearSecret(false);
      }
      setConflict(false);
      await onSaved(saved);
      if (input.silent) {
        setLastAutoSavedAt(new Date());
      } else {
        toast.success(t('identityProviders.save.success'));
      }
      return 'saved';
    } catch (cause) {
      const conflicted = await handleRevisionConflict(cause);
      toast.error(friendlyError(cause));
      return conflicted ? 'conflict' : 'error';
    }
  };

  setPersist(persistDraft);

  const save = () => {
    void (async () => {
      setBusy('save');
      try {
        await enqueuePersist({ includeSecret: true, silent: false });
      } finally {
        setBusy(null);
      }
    })();
  };

  // Discover alone validates network + endpoints; do not also call validateNetwork
  // (that would preflight the same discovery URL a second time).
  const discover = () =>
    void run(
      'discover',
      async () => {
        const metadata = await adminIdentityProvidersService.discover({
          issuer: draft.issuer,
          type: draft.type,
        });
        setDiscovery(metadata);
        setNetworkValid(true);
      },
      false,
    );

  /**
   * One DingTalk/OIDC login round-trip against the isolated test callback.
   *
   * `intent: 'capture'` is the DingTalk organisation-capture entry point in the policy step:
   * the admin authorizes in DingTalk, picks the enterprise there, and the server reports the
   * resulting corpId back — administrators never type one. `intent: 'test'` is the existing
   * pre-publish safe-login test. Both are the same server flow and the same attempt record.
   */
  const startTest = (intent: 'capture' | 'test' = 'test') => {
    if (!provider) return;
    if (!draftWorkflowReady) {
      toast.error(t('identityProviders.workflow.draftRequired'));
      return;
    }
    if (intent === 'capture' && captureBlockedReason) {
      toast.error(captureBlockedReason);
      return;
    }
    // No reason prompt: this writes no configuration — it opens an isolated login window and
    // records a claim preview. The audit still captures who started it and the outcome.
    void run(
      intent === 'capture' ? 'capture' : 'test',
      async () => {
        resetWait();
        setTestWaitMessage(null);
        const { popup, result } = await openIdentityProviderTestPopup(() =>
          adminIdentityProvidersService.testStart({
            expectedRevision: provider.revision,
            id: provider.id,
          }),
        );
        testPopupRef.current = popup;
        setAttempt({
          id: result.attemptId,
          revision: provider.revision,
          startedAt: Date.now(),
        });
        setCaptureAttemptId(intent === 'capture' ? result.attemptId : null);
        setTestPolling(true);
      },
      false,
    );
  };

  const publish = () => {
    if (!provider) return;
    if (!draftWorkflowReady) {
      toast.error(t('identityProviders.workflow.draftRequired'));
      return;
    }
    if (!testSucceeded) {
      toast.error(t('identityProviders.workflow.testRequired'));
      return;
    }
    if (dirty) {
      toast.error(t('identityProviders.unsaved'));
      return;
    }
    openReasonModal({
      authMethod,
      autoReason: IDENTITY_PROVIDER_AUTO_REASON.publish,
      buildPayload: (reason) => ({ reason }),
      hideReason: true,
      impact: t('identityProviders.publish.impact'),
      onSubmit: async (payload) =>
        run('publish', async () => {
          const published = await adminIdentityProvidersService.publish({
            expectedRevision: provider.revision,
            id: provider.id,
            reason: (payload as { reason: string }).reason,
            requestId: crypto.randomUUID(),
          });
          await onSaved(published);
          toast.success(t('identityProviders.publish.success'));
        }),
      submitLabel: t('identityProviders.actions.publish'),
      targetLabel: provider.displayName,
      title: t('identityProviders.publish.title'),
    });
  };

  return {
    copyUrl,
    discover,
    publish,
    refreshConflict,
    save,
    scheduleAutosave,
    startTest,
  };
};
