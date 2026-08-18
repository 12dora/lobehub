'use client';

import { Alert, InputPassword, Text } from '@lobehub/ui';
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
import type { AdminUsersSetPasswordInput } from '@/enterprise/client/services/adminUsers';

import { getAdminUsersMutationErrorKey } from '../../utils';
import { PASSWORD_MAX, PASSWORD_MIN, validateSetPasswordForm } from './setPasswordValidation';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
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
export type SetPasswordModalPhase = 'idle' | 'reauthing' | 'mutating';

export interface SetPasswordModalDismissGuard {
  closedExplicitly: boolean;
  phase: SetPasswordModalPhase;
}

export interface SetPasswordModalContentProps {
  /** Shared abort controller — the opener aborts on Escape/close before unmount. */
  abortControllerRef?: React.MutableRefObject<AbortController | null>;
  authMethod?: AdminReauthAuthMethod;
  dismissGuardRef?: React.MutableRefObject<SetPasswordModalDismissGuard>;
  /** Called when phase changes (tests / parent). */
  onPhaseChange?: (phase: SetPasswordModalPhase) => void;
  onSubmit: (input: AdminUsersSetPasswordInput) => Promise<unknown>;
  /** Human-readable target — the admin must see whose password this is. */
  targetLabel: string;
  userId: string;
}

export const SetPasswordModalContent = memo<SetPasswordModalContentProps>(
  ({
    abortControllerRef,
    authMethod,
    dismissGuardRef,
    onPhaseChange,
    onSubmit,
    targetLabel,
    userId,
  }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();

    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    // Default on: an admin-set password should not leave old sessions authenticated.
    const [revokeSessions, setRevokeSessions] = useState(true);

    // base-ui dismisses on Escape even with maskClosable: false — swallow it while the
    // server mutation is in flight so the admin does not lose the result/error state.
    const { phase, setPhase: syncPhase } = useModalPhaseGuard<SetPasswordModalPhase>({
      blockEscapeWhen: ['mutating'],
      dismissGuardRef,
      initialPhase: 'idle',
      onPhaseChange,
    });

    const resetBusyPhase = useCallback(() => {
      syncPhase('idle');
    }, [syncPhase]);

    const {
      abortActive,
      cancelReauth,
      clearCanonical,
      errorKey,
      runReauthedSubmit,
      setErrorKeySafe,
    } = useReauthMutation({
      abortControllerRef,
      resetBusyPhase,
      setPhase: (next: AdminReauthBusyPhase) => {
        syncPhase(next);
      },
    });

    const { confirmInvalid, formValid, passwordInvalid } = validateSetPasswordForm({
      confirmPassword,
      newPassword,
    });

    const locked = phase !== 'idle';
    const canSubmit = formValid && phase === 'idle';

    const handleClose = useCallback(() => {
      if (dismissGuardRef) dismissGuardRef.current.closedExplicitly = true;
      // Immediate abort — Escape/close must not wait for unmount cleanup.
      abortActive();
      clearCanonical();
      setNewPassword('');
      setConfirmPassword('');
      close();
    }, [abortActive, clearCanonical, close, dismissGuardRef]);

    const handleCancelReauth = useCallback(() => {
      cancelReauth(phase);
    }, [cancelReauth, phase]);

    const handleSubmit = useCallback(async () => {
      if (phase !== 'idle' || !formValid) return;

      const input: AdminUsersSetPasswordInput = { newPassword, revokeSessions, userId };

      await runReauthedSubmit({
        authMethod,
        mapError: getAdminUsersMutationErrorKey,
        payload: input,
        onSubmit: async (attemptPayload) => {
          await onSubmit(attemptPayload);
        },
        onSuccess: () => {
          // Explicit success close — not an Escape dismissal.
          if (dismissGuardRef) dismissGuardRef.current.closedExplicitly = true;
          toast.success(t('users.security.password.success'));
          close();
        },
      });
    }, [
      authMethod,
      close,
      dismissGuardRef,
      formValid,
      newPassword,
      onSubmit,
      phase,
      revokeSessions,
      runReauthedSubmit,
      t,
      userId,
    ]);

    return (
      <div className={styles.body}>
        <Text as="h2" className={styles.title}>
          {t('users.security.password.title', { name: targetLabel })}
        </Text>
        <Text>
          <strong>{t('users.modals.target')}</strong> {targetLabel}
        </Text>
        {/* The user is never notified — the admin owns handing the password over. */}
        <Alert showIcon message={t('users.security.password.warning')} type="warning" />
        <div className={styles.field}>
          <Text strong>{t('users.security.password.newLabel')}</Text>
          <InputPassword
            aria-label={t('users.security.password.newLabel')}
            autoComplete="new-password"
            disabled={locked}
            maxLength={PASSWORD_MAX}
            status={passwordInvalid ? 'error' : undefined}
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setErrorKeySafe(null);
            }}
          />
          <Text type="secondary">{t('users.security.password.rule', { min: PASSWORD_MIN })}</Text>
        </div>
        <div className={styles.field}>
          <Text strong>{t('users.security.password.confirmLabel')}</Text>
          <InputPassword
            aria-label={t('users.security.password.confirmLabel')}
            autoComplete="new-password"
            disabled={locked}
            maxLength={PASSWORD_MAX}
            status={confirmInvalid ? 'error' : undefined}
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setErrorKeySafe(null);
            }}
          />
          {confirmInvalid ? (
            <Text className={styles.error}>{t('users.security.password.mismatch')}</Text>
          ) : null}
        </div>
        <label className={styles.option}>
          <Checkbox
            checked={revokeSessions}
            disabled={locked}
            onChange={(checked) => setRevokeSessions(Boolean(checked))}
          />
          <span>{t('users.security.password.revokeSessions')}</span>
        </label>
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
            disabled={!canSubmit}
            loading={phase !== 'idle'}
            type="primary"
            onClick={() => void handleSubmit()}
          >
            {t('users.security.password.submit')}
          </Button>
        </div>
      </div>
    );
  },
);

SetPasswordModalContent.displayName = 'AdminUsersSetPasswordModalContent';

export const openSetPasswordModal = (props: SetPasswordModalContentProps): ModalInstance => {
  const abortControllerRef: { current: AbortController | null } = { current: null };
  const dismissGuardRef: { current: SetPasswordModalDismissGuard } = {
    current: { closedExplicitly: false, phase: 'idle' },
  };

  const instance = createModal({
    content: (
      <SetPasswordModalContent
        {...props}
        abortControllerRef={abortControllerRef}
        dismissGuardRef={dismissGuardRef}
      />
    ),
    footer: null,
    // Never mask-closable: an accidental outside click must not drop a password
    // mid-flight, and the admin cannot tell from the outside whether it landed.
    maskClosable: false,
    title: null,
    width: 'min(92vw, 480px)',
    onOpenChange: (open) => {
      if (open) return;
      const { closedExplicitly, phase } = dismissGuardRef.current;
      // base-ui commits the Escape close before this callback fires. While the
      // mutation is in flight, veto by re-opening in the same event batch.
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
