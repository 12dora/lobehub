'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { confirmModal, createModal, useModalContext } from '@lobehub/ui/base-ui';
import i18next from 'i18next';
import { memo, useCallback, useState } from 'react';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import {
  createIdentityProviderDraftFromTemplate,
  type IdentityProviderCreateDraftSeed,
  type IdentityProviderCreateTemplateId,
  resolveIdentityProviderWizardLiveProvider,
} from './controller';
import IdentityProviderTypePicker from './IdentityProviderTypePicker';
import IdentityProviderWizard from './IdentityProviderWizard';
import { type IdentityProviderPersistResult, resolveIdentityProviderWizardClose } from './persist';
import { useIdentityProviderCallbacks, useIdentityProviders } from './useIdentityProviders';

export interface IdentityProviderWizardModalProps {
  authMethod: AdminReauthAuthMethod | null;
  canCreate: boolean;
  canPublish: boolean;
  canTest: boolean;
  canUpdate: boolean;
  /** Refresh the provider table; called after any successful save/publish. */
  onChanged: () => Promise<unknown>;
  /** Present → edit mode; absent → create mode (starts on the type picker). */
  provider?: PlatformIdentityProviderDraft;
}

interface ContentProps extends IdentityProviderWizardModalProps {
  /** Shared with the opener so it can guard an unsaved close (Escape / close button). */
  dirtyRef: { current: boolean };
  /** Silent non-secret persist used when the modal closes mid-edit. */
  persistRef?: { current: (() => Promise<IdentityProviderPersistResult>) | null };
  secretDirtyRef?: { current: boolean };
}

/**
 * Hosts the identity-provider wizard inside a modal. Create mode opens on the
 * type picker, then the wizard. The first save stays in the modal and adopts
 * the returned `{id, revision}` so the admin can continue to test and publish.
 * Edit mode opens the wizard directly and keeps the modal open across saves,
 * feeding it the live provider from the shared cache so its revision stays
 * fresh for the next test/publish.
 */
/** Exported for mounted save→test/publish revision regressions (identity/F8). */
export const IdentityProviderWizardModalContent = memo<ContentProps>(
  ({
    authMethod,
    canCreate,
    canPublish,
    canTest,
    canUpdate,
    dirtyRef,
    onChanged,
    persistRef,
    provider,
    secretDirtyRef,
  }) => {
    const { close } = useModalContext();
    const callbacks = useIdentityProviderCallbacks(true);
    const isEdit = Boolean(provider);
    // Share the page's SWR cache so a save/publish revalidation flows the new
    // revision back into the wizard when the row is on the current page.
    const providers = useIdentityProviders(isEdit);
    // Canonical row for revision CAS: prefer mutation response, then list hit, then prop.
    // List is page-scoped (first page) so providers outside page 1 rely on mutation retention.
    const [canonicalProvider, setCanonicalProvider] = useState<
      PlatformIdentityProviderDraft | undefined
    >(provider);
    const listHit = isEdit
      ? providers.data?.items.find((item) => item.id === provider!.id)
      : undefined;
    // Mutation retention beats a page-scoped list miss (identity/F8).
    const liveProvider = resolveIdentityProviderWizardLiveProvider({
      canonicalProvider,
      isEdit,
      listHit,
      propProvider: provider,
    });
    const [seed, setSeed] = useState<IdentityProviderCreateDraftSeed | null>(null);

    const handleSaved = useCallback(
      async (saved?: PlatformIdentityProviderDraft) => {
        if (saved) setCanonicalProvider(saved);
        await onChanged();
      },
      [onChanged],
    );

    if (!isEdit && !seed) {
      return (
        <IdentityProviderTypePicker
          embedded
          onSelect={(type: IdentityProviderCreateTemplateId) =>
            setSeed(createIdentityProviderDraftFromTemplate(type))
          }
        />
      );
    }

    return (
      <IdentityProviderWizard
        embedded
        authMethod={authMethod}
        callbacks={callbacks.data}
        canCreate={canCreate}
        canPublish={canPublish}
        canTest={canTest}
        canUpdate={canUpdate}
        createSeed={isEdit ? undefined : (seed ?? undefined)}
        persistRef={persistRef}
        provider={liveProvider}
        secretDirtyRef={secretDirtyRef}
        onRefresh={onChanged}
        onSaved={handleSaved}
        onDirtyChange={(dirty) => {
          dirtyRef.current = dirty;
        }}
        onDiscard={() => {
          dirtyRef.current = false;
          close();
        }}
      />
    );
  },
);

IdentityProviderWizardModalContent.displayName = 'IdentityProviderWizardModalContent';

export const openIdentityProviderWizardModal = (props: IdentityProviderWizardModalProps) => {
  // Tracks the wizard's dirty state so a user-initiated close (Escape / X) can
  // persist non-secret fields, then confirm before discarding a write-only secret.
  const dirtyRef = { current: false };
  const persistRef: {
    current: (() => Promise<IdentityProviderPersistResult>) | null;
  } = { current: null };
  const secretDirtyRef = { current: false };
  const instance = createModal({
    content: (
      <IdentityProviderWizardModalContent
        {...props}
        dirtyRef={dirtyRef}
        persistRef={persistRef}
        secretDirtyRef={secretDirtyRef}
      />
    ),
    footer: null,
    maskClosable: false,
    styles: { content: { maxHeight: '80vh', overflow: 'auto', paddingBlockStart: 0 } },
    title: props.provider
      ? i18next.t('identityProviders.editProvider', { ns: 'admin' })
      : i18next.t('identityProviders.actions.create', { ns: 'admin' }),
    width: 'min(94vw, 820px)',
    // Only user-initiated closes fire this; programmatic close() (save/discard) does not.
    onOpenChange: (open) => {
      if (open) return;
      const first = resolveIdentityProviderWizardClose({
        dirty: dirtyRef.current,
        secretDirty: secretDirtyRef.current,
      });
      if (first === 'close') return;
      // base-ui already flipped the modal closed — keep it open while we persist / confirm.
      instance.update({ open: true });
      void (async () => {
        const persist = persistRef.current;
        const persistResult = persist ? await persist() : 'blocked';
        const next = resolveIdentityProviderWizardClose({
          dirty: dirtyRef.current,
          persistResult,
          secretDirty: secretDirtyRef.current,
        });
        if (next === 'stay') return;
        if (next === 'close') {
          dirtyRef.current = false;
          instance.close();
          return;
        }
        confirmModal({
          cancelText: i18next.t('identityProviders.unsaved.stay', { ns: 'admin' }),
          content: i18next.t('identityProviders.unsaved.description', { ns: 'admin' }),
          okText: i18next.t('identityProviders.unsaved.discard', { ns: 'admin' }),
          title: i18next.t('identityProviders.unsaved.title', { ns: 'admin' }),
          onOk: () => {
            dirtyRef.current = false;
            instance.close();
          },
        });
      })();
    },
  });
  return instance;
};
