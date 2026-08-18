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

import {
  isPasskeyRemovalOptional,
  resolveCredentialRecoveryCopy,
  resolveCredentialRecoveryVariant,
  resolveRemovePasskeys,
} from '../../credentialRecovery';
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
  /**
   * Whether the target actually has an authenticator. False for a passkey-only
   * account, where the modal must not mention two-step verification at all.
   */
  twoFactorEnabled: boolean;
  userId: string;
}

/**
 * Clears a user's second factors so an admin can get them back in.
 *
 * Three shapes, three readings — see `credentialRecovery.ts`. The passkey-only one
 * is not a corner case: it is what every passkey user without an authenticator
 * looks like, and the only lockout an admin can resolve for them.
 */
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
    twoFactorEnabled,
    userId,
  }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();

    const variant = resolveCredentialRecoveryVariant({ twoFactorEnabled });
    const copy = (slot: Parameters<typeof resolveCredentialRecoveryCopy>[1]) => {
      const { defaultValue, key } = resolveCredentialRecoveryCopy(variant, slot);
      return { defaultValue, key: key as never };
    };
    const titleCopy = copy('title');
    const descCopy = copy('desc');
    const submitCopy = copy('submit');

    const passkeyRemovalIsOptional = isPasskeyRemovalOptional({ passkeyCount, twoFactorEnabled });
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
        removePasskeys: resolveRemovePasskeys({
          optIn: removePasskeys,
          passkeyCount,
          twoFactorEnabled,
        }),
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
          const success = resolveCredentialRecoveryCopy(variant, 'success');
          toast.success(
            t(success.key as never, { defaultValue: success.defaultValue }) as unknown as string,
          );
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
      twoFactorEnabled,
      userId,
      variant,
    ]);

    return (
      <div className={styles.body}>
        <Text as="h2" className={styles.title}>
          {t(titleCopy.key, { defaultValue: titleCopy.defaultValue })}
        </Text>
        <Text type="secondary">
          {t(descCopy.key, {
            defaultValue: descCopy.defaultValue,
            name: targetLabel,
            num: passkeyCount,
          })}
        </Text>
        <Text>
          <strong>{t('users.modals.target')}</strong> {targetLabel}
        </Text>
        {/* The server always advances the security epoch here — say so up front. */}
        <Text type="secondary">{t('users.modals.revoke.impactOther')}</Text>
        {isSelf ? (
          <Text type="danger">{t('users.modals.revoke.includeCurrentWarning')}</Text>
        ) : null}
        {passkeyRemovalIsOptional ? (
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
            {t(submitCopy.key, { defaultValue: submitCopy.defaultValue })}
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
