'use client';

import {
  confirmModal,
  createModal,
  type ModalInstance,
  toast,
  useModalContext,
} from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import i18next from 'i18next';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useModalPhaseGuard } from '@/enterprise/client/features/admin/primitives/useModalPhaseGuard';
import {
  type AdminReauthBusyPhase,
  useReauthMutation,
} from '@/enterprise/client/features/admin/primitives/useReauthMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminUsersCreateInput,
  AdminUsersCreateOutput,
} from '@/enterprise/client/services/adminUsers';

import { CREATE_USER_AUTO_REASON } from '../auditReasonCodes';
import { getAdminUsersCreateErrorKey } from '../utils';
import { CreateUserCredentialsPanel } from './createUser/CreateUserCredentialsPanel';
import { CreateUserForm } from './createUser/CreateUserForm';
import { validateCreateUserForm } from './createUser/validation';
import { generatePassword } from './generatePassword';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
}));

/** idle | waiting on reauth popup | server mutation in flight | one-time credentials panel */
export type CreateUserModalPhase = 'idle' | 'reauthing' | 'mutating' | 'success';

/**
 * Shared between content and openCreateUserModal's onOpenChange: base-ui's
 * `maskClosable: false` only suppresses `outside-press` dismissals — Escape still
 * closes — so onOpenChange needs the live phase to veto framework-initiated closes
 * while a create is in flight or the one-time credentials panel is showing.
 */
export interface CreateUserModalDismissGuard {
  /** True once Cancel / Done ran `close()` — vetoes must not resurrect the modal. */
  closedExplicitly: boolean;
  dirty: boolean;
  discardPromptOpen: boolean;
  phase: CreateUserModalPhase;
}

export interface CreateUserModalContentProps {
  /**
   * Shared abort controller for this modal instance.
   * openCreateUserModal wires onOpenChange(false) to abort immediately (Escape/close).
   */
  abortControllerRef?: React.MutableRefObject<AbortController | null>;
  authMethod?: AdminReauthAuthMethod;
  /** Shared dismissal guard — see {@link CreateUserModalDismissGuard}. */
  dismissGuardRef?: React.MutableRefObject<CreateUserModalDismissGuard>;
  /** Called when phase changes (tests / parent). */
  onPhaseChange?: (phase: CreateUserModalPhase) => void;
  onSubmit: (input: AdminUsersCreateInput) => Promise<AdminUsersCreateOutput>;
}

export const CreateUserModalContent = memo<CreateUserModalContentProps>(
  ({ abortControllerRef, authMethod, dismissGuardRef, onPhaseChange, onSubmit }) => {
    const { t } = useTranslation('admin');
    const reduceMotion = useReducedMotion();
    const { close } = useModalContext();

    const [email, setEmail] = useState('');
    const [fullName, setFullName] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    /** One-time credentials — lives only in modal state, cleared on close/unmount. */
    const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(
      null,
    );

    // Dismissal guard (Escape): base-ui's Dialog dismisses on a bubble-phase document
    // `keydown` listener and `maskClosable: false` only suppresses outside-press.
    // Swallow Escape at document capture phase while the mutation is in flight or the
    // one-time credentials panel is showing — losing either is unrecoverable (there is
    // no admin password reset). openCreateUserModal's onOpenChange is the safety net
    // for any dismissal path that still commits a close.
    const {
      phase,
      setPhase: setPhaseBoth,
      setPhaseState,
    } = useModalPhaseGuard<CreateUserModalPhase>({
      blockEscapeWhen: ['mutating', 'success'],
      dismissGuardRef,
      initialPhase: 'idle',
      onPhaseChange,
    });

    const resetBusyPhase = useCallback(() => {
      setPhaseState((p) => (p === 'mutating' || p === 'reauthing' ? 'idle' : p));
    }, [setPhaseState]);

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
      // CreateUser phases are a superset; busy path only emits idle|reauthing|mutating.
      setPhase: (next: AdminReauthBusyPhase) => setPhaseBoth(next),
    });

    const {
      emailInvalid,
      formValid,
      passwordInvalid,
      trimmedEmail,
      trimmedFullName,
      trimmedUsername,
      usernameInvalid,
    } = validateCreateUserForm({ email, fullName, password, username });

    const locked = phase !== 'idle';
    const canSubmit = formValid && phase === 'idle';
    const dirty = Boolean(email || fullName || username || password);

    useEffect(() => {
      if (dismissGuardRef) dismissGuardRef.current.dirty = dirty;
    }, [dirty, dismissGuardRef]);

    const clearSecrets = useCallback(() => {
      setPassword('');
      setCredentials(null);
      clearCanonical();
    }, [clearCanonical]);

    const handleClose = useCallback(() => {
      // Immediate abort — Escape/close must not wait for unmount cleanup.
      if (dismissGuardRef) dismissGuardRef.current.closedExplicitly = true;
      abortActive();
      clearSecrets();
      close();
    }, [abortActive, clearSecrets, close, dismissGuardRef]);

    const handleCancelReauth = useCallback(() => {
      cancelReauth(phase);
    }, [cancelReauth, phase]);

    const handleGenerate = useCallback(() => {
      setPassword(generatePassword());
      setErrorKeySafe(null);
    }, [setErrorKeySafe]);

    const handleSubmit = useCallback(async () => {
      if (phase !== 'idle' || !formValid) return;

      const input: AdminUsersCreateInput = {
        email: trimmedEmail,
        fullName: trimmedFullName,
        password,
        reason: CREATE_USER_AUTO_REASON,
        ...(trimmedUsername ? { username: trimmedUsername } : {}),
      };

      await runReauthedSubmit({
        authMethod,
        mapError: getAdminUsersCreateErrorKey,
        payload: input,
        onSubmit: async (attemptPayload) => {
          await onSubmit(attemptPayload);
        },
        onSuccess: () => {
          // One-time panel: keep the password in modal state only until Done/close.
          setCredentials({ email: trimmedEmail, password });
          setPhaseBoth('success');
          toast.success(t('users.toast.createSuccess'));
        },
      });
    }, [
      authMethod,
      formValid,
      onSubmit,
      password,
      phase,
      runReauthedSubmit,
      setPhaseBoth,
      t,
      trimmedEmail,
      trimmedFullName,
      trimmedUsername,
    ]);

    const handleDone = useCallback(() => {
      // Do NOT clear credentials here: base-ui keeps content mounted through the exit
      // animation, and clearing first would flash the empty create form. State (and the
      // canonical snapshot via unmount cleanup) is discarded when the modal unmounts.
      if (dismissGuardRef) dismissGuardRef.current.closedExplicitly = true;
      close();
    }, [close, dismissGuardRef]);

    const phaseKey = phase === 'success' && credentials ? 'success' : 'form';

    return (
      <AnimatePresence initial={false} mode="wait">
        <m.div
          animate={{ opacity: 1, y: 0 }}
          className={styles.body}
          exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          key={phaseKey}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
        >
          {phaseKey === 'success' && credentials ? (
            <CreateUserCredentialsPanel credentials={credentials} onDone={handleDone} />
          ) : (
            <CreateUserForm
              canSubmit={canSubmit}
              email={email}
              emailInvalid={emailInvalid}
              errorKey={errorKey}
              fullName={fullName}
              locked={locked}
              password={password}
              passwordInvalid={passwordInvalid}
              phase={phase}
              username={username}
              usernameInvalid={usernameInvalid}
              onCancelReauth={handleCancelReauth}
              onClose={handleClose}
              onEmailChange={setEmail}
              onFullNameChange={setFullName}
              onGenerate={handleGenerate}
              onPasswordChange={setPassword}
              onSubmit={() => void handleSubmit()}
              onUsernameChange={setUsername}
            />
          )}
        </m.div>
      </AnimatePresence>
    );
  },
);

CreateUserModalContent.displayName = 'AdminUsersCreateUserModalContent';

export const openCreateUserModal = (props: CreateUserModalContentProps): ModalInstance => {
  // Shared abort ref: onOpenChange(false) aborts before unmount/animation.
  const abortControllerRef: { current: AbortController | null } = { current: null };
  const dismissGuardRef: { current: CreateUserModalDismissGuard } = {
    current: { closedExplicitly: false, dirty: false, discardPromptOpen: false, phase: 'idle' },
  };

  const instance = createModal({
    content: (
      <CreateUserModalContent
        {...props}
        abortControllerRef={abortControllerRef}
        dismissGuardRef={dismissGuardRef}
      />
    ),
    footer: null,
    // Never mask-closable: an accidental outside click must not lose the form
    // mid-mutation or dismiss the one-time credentials panel.
    maskClosable: false,
    title: null,
    width: 'min(92vw, 520px)',
    onOpenChange: (open) => {
      if (open) return;
      const guard = dismissGuardRef.current;
      const { closedExplicitly, phase } = guard;
      // base-ui commits the close (closeModal) BEFORE this callback for every
      // framework dismissal (Escape included, despite maskClosable: false). While a
      // create is in flight or the one-time credentials panel is showing, veto by
      // re-opening synchronously — same event batch, so the closed state never
      // renders. Explicit Cancel/Done use useModalContext().close(), which skips
      // onOpenChange entirely; closedExplicitly keeps a late dismissal during the
      // exit animation from resurrecting the modal.
      if (!closedExplicitly && (phase === 'mutating' || phase === 'success')) {
        instance.update({ open: true });
        return;
      }
      if (!closedExplicitly && phase === 'idle' && guard.dirty) {
        // base-ui has already committed the Escape close. Restore the form in the same
        // event batch, then require an explicit destructive choice.
        instance.update({ open: true });
        if (guard.discardPromptOpen) return;
        guard.discardPromptOpen = true;
        confirmModal({
          cancelText: i18next.t('users.modals.create.unsaved.stay', { ns: 'admin' }),
          content: i18next.t('users.modals.create.unsaved.description', { ns: 'admin' }),
          okButtonProps: { danger: true },
          okText: i18next.t('users.modals.create.unsaved.discard', { ns: 'admin' }),
          title: i18next.t('users.modals.create.unsaved.title', { ns: 'admin' }),
          onCancel: () => {
            guard.discardPromptOpen = false;
          },
          onOk: () => {
            guard.closedExplicitly = true;
            guard.dirty = false;
            guard.discardPromptOpen = false;
            abortControllerRef.current?.abort();
            abortControllerRef.current = null;
            instance.close();
          },
        });
        return;
      }
      // Escape / dismiss / close — abort immediately, do not wait for unmount.
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    },
  });

  return instance;
};
