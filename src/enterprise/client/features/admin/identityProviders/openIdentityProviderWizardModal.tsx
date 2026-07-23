'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { confirmModal, createModal, toast, useModalContext } from '@lobehub/ui/base-ui';
import i18next from 'i18next';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import {
  createIdentityProviderDraftFromTemplate,
  type IdentityProviderCreateDraftSeed,
  type IdentityProviderCreateTemplateId,
} from './controller';
import IdentityProviderTypePicker from './IdentityProviderTypePicker';
import IdentityProviderWizard from './IdentityProviderWizard';
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
}

/**
 * Hosts the identity-provider wizard inside a modal. Create mode opens on the
 * type picker, then the wizard; the first save persists a draft (which appears
 * in the table) and closes — the admin reopens that row to test and publish.
 * Edit mode opens the wizard directly and keeps the modal open across saves,
 * feeding it the live provider from the shared cache so its revision stays
 * fresh for the next test/publish.
 */
const IdentityProviderWizardModalContent = memo<ContentProps>(
  ({ authMethod, canCreate, canPublish, canTest, canUpdate, dirtyRef, onChanged, provider }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const callbacks = useIdentityProviderCallbacks(true);
    const isEdit = Boolean(provider);
    // Share the page's SWR cache so a save/publish revalidation flows the new
    // revision back into the wizard (avoids a stale-expectedRevision conflict).
    const providers = useIdentityProviders(isEdit);
    const liveProvider = isEdit
      ? (providers.data?.items.find((item) => item.id === provider!.id) ?? provider)
      : undefined;
    const [seed, setSeed] = useState<IdentityProviderCreateDraftSeed | null>(null);

    const handleSaved = useCallback(async () => {
      await onChanged();
      // Creating: the draft now exists in the table — reopen it to continue.
      if (!isEdit) {
        dirtyRef.current = false;
        toast.success(t('identityProviders.save.draftSaved'));
        close();
      }
    }, [close, dirtyRef, isEdit, onChanged, t]);

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
        provider={liveProvider}
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
  // confirm before discarding unsaved input (including a write-only secret).
  const dirtyRef = { current: false };
  const instance = createModal({
    content: <IdentityProviderWizardModalContent {...props} dirtyRef={dirtyRef} />,
    footer: null,
    maskClosable: false,
    styles: { content: { maxHeight: '80vh', overflow: 'auto' } },
    title: props.provider
      ? i18next.t('identityProviders.editProvider', { ns: 'admin' })
      : i18next.t('identityProviders.actions.create', { ns: 'admin' }),
    width: 'min(94vw, 820px)',
    // Only user-initiated closes fire this; programmatic close() (save/discard) does not.
    onOpenChange: (open) => {
      if (open || !dirtyRef.current) return;
      // base-ui already flipped the modal closed — keep it open and confirm first.
      instance.update({ open: true });
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
    },
  });
  return instance;
};
