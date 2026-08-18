'use client';

import { Text } from '@lobehub/ui';
import {
  Button,
  Checkbox,
  createModal,
  type ModalInstance,
  toast,
  useModalContext,
} from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useModalPhaseGuard } from '@/enterprise/client/features/admin/primitives/useModalPhaseGuard';
import {
  type AdminReauthBusyPhase,
  useReauthMutation,
} from '@/enterprise/client/features/admin/primitives/useReauthMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminUsersDisableTwoFactorInput } from '@/enterprise/client/services/adminUsers';

import { getAdminUsersMutationErrorKey } from '../../utils';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  `,
  option: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
  `,
  title: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: 600;
  `,
}));

/** idle | waiting on reauth popup | server mutation in flight */
export type DisableTwoFactorModalPhase = 'idle' | 'reauthing' | 'mutating';

export interface DisableTwoFactorModalDismissGuard {
  closedExplicitly: boolean;
  phase: DisableTwoFactorModalPhase;
}

export interface DisableTwoFactorModalContentProps {
  /** Shared abort controller — the opener aborts on Escape/close before unmount. */
  abortControllerRef?: React.MutableRefObject<AbortController | null>;
  authMethod?: AdminReauthAuthMethod;
  dismissGuardRef?: React.MutableRefObject<DisableTwoFactorModalDismissGuard>;
  /** Server-computed self flag — disabling own 2FA signs the actor out. */
  isSelf?: boolean;
  /** Called when phase changes (tests / parent). */
  onPhaseChange?: (phase: DisableTwoFactorModalPhase) => void;
  onSubmit: (input: AdminUsersDisableTwoFactorInput) => Promise<unknown>;
  /** Count of the target's passkeys — the opt-in checkbox is hidden at 0. */
  passkeyCount: number;
  targetLabel: string;
  userId: string;
}

export const DisableTwoFactorModalContent = memo<DisableTwoFactorModalContentProps>(
  ({
    abortControllerRef,
    authMethod,
    dismissGuardRef,
    isSelf,
    onPhaseChange,
    onSubmit,
    passkeyCount,
    targetLabel,
    userId,
  }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();

    // Opt-in: removing passkeys is a second, separate loss of access.
    const [removePasskeys, setRemovePasskeys] = useState(false);

    const { phase, setPhase: syncPhase } = useModalPhaseGuard<DisableTwoFactorModalPhase>({
      blockEscapeWhen: ['mutating'],
      dismissGuardRef,
      initialPhase: 'idle',
      onPhaseChange,
    });

    const resetBusyPhase = useCallback(() => {
      syncPhase('idle');
    }, [syncPhase]);

    const { abortActive, cancelReauth, clearCanonical, errorKey, runReauthedSubmit } =
      useReauthMutation({
        abortControllerRef,
        resetBusyPhase,
        setPhase: (next: AdminReauthBusyPhase) => {
          syncPhase(next);
        },
      });

    const handleClose = useCallback(() => {
      if (dismissGuardRef) dismissGuardRef.current.closedExplicitly = true;
      abortActive();
      clearCanonical();
      close();
    }, [abortActive, clearCanonical, close, dismissGuardRef]);

    const handleCancelReauth = useCallback(() => {
      cancelReauth(phase);
    }, [cancelReauth, phase]);

    const handleSubmit = useCallback(async () => {
      if (phase !== 'idle') return;

      const input: AdminUsersDisableTwoFactorInput = {
        removePasskeys: passkeyCount > 0 ? removePasskeys : false,
        userId,
      };

      await runReauthedSubmit({
        authMethod,
        mapError: getAdminUsersMutationErrorKey,
        payload: input,
        onSubmit: async (attemptPayload) => {
          await onSubmit(attemptPayload);
        },
        onSuccess: () => {
          if (dismissGuardRef) dismissGuardRef.current.closedExplicitly = true;
          toast.success(t('users.security.twoFactor.success'));
          close();
        },
      });
    }, [
      authMethod,
      close,
      dismissGuardRef,
      onSubmit,
      passkeyCount,
      phase,
      removePasskeys,
      runReauthedSubmit,
      t,
      userId,
    ]);

    return (
      <div className={styles.body}>
        <Text as="h2" className={styles.title}>
          {t('users.security.twoFactor.title')}
        </Text>
        <Text type="secondary">{t('users.security.twoFactor.desc', { name: targetLabel })}</Text>
        <Text>
          <strong>{t('users.modals.target')}</strong> {targetLabel}
        </Text>
        {/* The server always advances the security epoch here — say so up front. */}
        <Text type="secondary">{t('users.modals.revoke.impactOther')}</Text>
        {isSelf ? (
          <Text type="danger">{t('users.modals.revoke.includeCurrentWarning')}</Text>
        ) : null}
        {passkeyCount > 0 ? (
          <label className={styles.option}>
            <Checkbox
              checked={removePasskeys}
              disabled={phase !== 'idle'}
              onChange={(checked) => setRemovePasskeys(Boolean(checked))}
            />
            <span>{t('users.security.twoFactor.removePasskeys', { num: passkeyCount })}</span>
          </label>
        ) : null}
        {phase === 'reauthing' ? (
          <Text role="status" type="secondary">
            {t('users.reauth.inProgress')}
          </Text>
        ) : null}
        {errorKey ? (
          <Text className={styles.error} role="alert">
            {t(errorKey as never)}
          </Text>
        ) : null}
        <div className={styles.footer}>
          {phase === 'reauthing' ? (
            <Button type="default" onClick={handleCancelReauth}>
              {t('users.reauth.cancel')}
            </Button>
          ) : (
            <Button disabled={phase === 'mutating'} onClick={handleClose}>
              {t('users.modals.cancel')}
            </Button>
          )}
          <Button
            danger
            disabled={phase !== 'idle'}
            loading={phase !== 'idle'}
            type="primary"
            onClick={() => void handleSubmit()}
          >
            {t('users.security.twoFactor.submit')}
          </Button>
        </div>
      </div>
    );
  },
);

DisableTwoFactorModalContent.displayName = 'AdminUsersDisableTwoFactorModalContent';

export const openDisableTwoFactorModal = (
  props: DisableTwoFactorModalContentProps,
): ModalInstance => {
  const abortControllerRef: { current: AbortController | null } = { current: null };
  const dismissGuardRef: { current: DisableTwoFactorModalDismissGuard } = {
    current: { closedExplicitly: false, phase: 'idle' },
  };

  const instance = createModal({
    content: (
      <DisableTwoFactorModalContent
        {...props}
        abortControllerRef={abortControllerRef}
        dismissGuardRef={dismissGuardRef}
      />
    ),
    footer: null,
    maskClosable: false,
    title: null,
    width: 'min(92vw, 480px)',
    onOpenChange: (open) => {
      if (open) return;
      const { closedExplicitly, phase } = dismissGuardRef.current;
      if (!closedExplicitly && phase === 'mutating') {
        instance.update({ open: true });
        return;
      }
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    },
  });

  return instance;
};
