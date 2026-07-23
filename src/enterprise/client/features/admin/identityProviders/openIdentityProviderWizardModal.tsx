'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { createModal, toast, useModalContext } from '@lobehub/ui/base-ui';
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
import { useIdentityProviderCallbacks } from './useIdentityProviders';

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

/**
 * Hosts the identity-provider wizard inside a modal. Create mode opens on the
 * type picker, then the wizard; the first save persists a draft (which appears
 * in the table) and closes — the admin reopens that row to test and publish.
 * Edit mode opens the wizard directly and keeps the modal open across saves.
 */
const IdentityProviderWizardModalContent = memo<IdentityProviderWizardModalProps>(
  ({ authMethod, canCreate, canPublish, canTest, canUpdate, onChanged, provider }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const callbacks = useIdentityProviderCallbacks(true);
    const isEdit = Boolean(provider);
    const [seed, setSeed] = useState<IdentityProviderCreateDraftSeed | null>(null);

    const handleSaved = useCallback(async () => {
      await onChanged();
      // Creating: the draft now exists in the table — reopen it to continue.
      if (!isEdit) {
        toast.success(t('identityProviders.save.draftSaved'));
        close();
      }
    }, [close, isEdit, onChanged, t]);

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
        provider={provider}
        onDirtyChange={() => undefined}
        onDiscard={close}
        onRefresh={onChanged}
        onSaved={handleSaved}
      />
    );
  },
);

IdentityProviderWizardModalContent.displayName = 'IdentityProviderWizardModalContent';

export const openIdentityProviderWizardModal = (props: IdentityProviderWizardModalProps) =>
  createModal({
    content: <IdentityProviderWizardModalContent {...props} />,
    footer: null,
    maskClosable: false,
    styles: { content: { maxHeight: '80vh', overflow: 'auto' } },
    title: props.provider
      ? i18next.t('identityProviders.editProvider', { ns: 'admin' })
      : i18next.t('identityProviders.actions.create', { ns: 'admin' }),
    width: 'min(94vw, 820px)',
  });
