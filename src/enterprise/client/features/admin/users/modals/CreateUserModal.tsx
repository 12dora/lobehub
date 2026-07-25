'use client';

import { CopyButton, Input, InputPassword, Text } from '@lobehub/ui';
import {
  Button,
  createModal,
  type ModalInstance,
  toast,
  useModalContext,
} from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
import { generatePassword } from './generatePassword';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  credentialRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding-block: 6px;
    padding-inline: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
  `,
  credentialValue: css`
    font-family: ${cssVar.fontFamilyCode};
    overflow-wrap: anywhere;
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
  passwordRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  title: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: 600;
  `,
  warning: css`
    color: ${cssVar.colorWarningText};
  `,
}));

/** idle | waiting on reauth popup | server mutation in flight | one-time credentials panel */
export type CreateUserModalPhase = 'idle' | 'reauthing' | 'mutating' | 'success';

// Client-side mirrors of `adminUsersCreateInputSchema` bounds (server remains authoritative).
const EMAIL_MAX = 255;
const FULL_NAME_MAX = 100;
const USERNAME_MAX = 64;
const USERNAME_PATTERN = /^[\w.-]+$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;
/**
 * Mirror of zod v3's `.email()` regex (server schema uses zod): ASCII local part, no
 * leading dot / consecutive dots, dotted domain with 2+ letter TLD. A looser client
 * pattern would let inputs through that the server rejects as BAD_REQUEST.
 */
const EMAIL_PATTERN = /^(?!\.)(?!.+\.\.)[\w'+\-.]*[\w+-]@(?:[A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

/**
 * Shared between content and openCreateUserModal's onOpenChange: base-ui's
 * `maskClosable: false` only suppresses `outside-press` dismissals — Escape still
 * closes — so onOpenChange needs the live phase to veto framework-initiated closes
 * while a create is in flight or the one-time credentials panel is showing.
 */
export interface CreateUserModalDismissGuard {
  /** True once Cancel / Done ran `close()` — vetoes must not resurrect the modal. */
  closedExplicitly: boolean;
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
    const [phase, setPhase] = useState<CreateUserModalPhase>('idle');
    /** One-time credentials — lives only in modal state, cleared on close/unmount. */
    const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(
      null,
    );

    /** Live phase for non-React listeners (Escape blocker) — synced before re-render. */
    const phaseRef = useRef<CreateUserModalPhase>('idle');

    const syncPhaseRefs = useCallback(
      (next: CreateUserModalPhase) => {
        // Refs sync synchronously so a dismissal arriving before the re-render
        // (Escape right after Confirm) already sees the new phase.
        phaseRef.current = next;
        if (dismissGuardRef) dismissGuardRef.current.phase = next;
      },
      [dismissGuardRef],
    );

    const setPhaseBoth = useCallback(
      (next: CreateUserModalPhase) => {
        syncPhaseRefs(next);
        setPhase(next);
        onPhaseChange?.(next);
      },
      [onPhaseChange, syncPhaseRefs],
    );

    // Catch-all: keep refs in sync with any phase update that bypassed setPhaseBoth.
    useEffect(() => {
      phaseRef.current = phase;
      if (dismissGuardRef) dismissGuardRef.current.phase = phase;
    }, [dismissGuardRef, phase]);

    // Dismissal guard (Escape): base-ui's Dialog dismisses on a bubble-phase document
    // `keydown` listener and `maskClosable: false` only suppresses outside-press.
    // Swallow Escape at document capture phase while the mutation is in flight or the
    // one-time credentials panel is showing — losing either is unrecoverable (there is
    // no admin password reset). openCreateUserModal's onOpenChange is the safety net
    // for any dismissal path that still commits a close.
    useEffect(() => {
      const blockEscape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        const current = phaseRef.current;
        if (current !== 'mutating' && current !== 'success') return;
        event.stopImmediatePropagation();
        event.stopPropagation();
      };
      document.addEventListener('keydown', blockEscape, true);
      return () => document.removeEventListener('keydown', blockEscape, true);
    }, []);

    const resetBusyPhase = useCallback(() => {
      setPhase((p) => (p === 'mutating' || p === 'reauthing' ? 'idle' : p));
    }, []);

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

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedFullName = fullName.trim();
    const trimmedUsername = username.trim();

    const emailInvalid =
      trimmedEmail.length > 0 &&
      (trimmedEmail.length > EMAIL_MAX || !EMAIL_PATTERN.test(trimmedEmail));
    const fullNameInvalid = trimmedFullName.length > FULL_NAME_MAX;
    const usernameInvalid =
      trimmedUsername.length > 0 &&
      (trimmedUsername.length > USERNAME_MAX || !USERNAME_PATTERN.test(trimmedUsername));
    const passwordInvalid =
      password.length > 0 && (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX);

    const formValid =
      trimmedEmail.length > 0 &&
      !emailInvalid &&
      trimmedFullName.length > 0 &&
      !fullNameInvalid &&
      !usernameInvalid &&
      password.length >= PASSWORD_MIN &&
      password.length <= PASSWORD_MAX;

    const locked = phase !== 'idle';
    const canSubmit = formValid && phase === 'idle';

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
            <>
              <Text as="h2" className={styles.title}>
                {t('users.modals.create.successTitle')}
              </Text>
              <Text className={styles.warning} role="alert">
                {t('users.modals.create.successWarning')}
              </Text>
              <div className={styles.field}>
                <Text strong>{t('users.modals.create.credentialEmail')}</Text>
                <div className={styles.credentialRow}>
                  <Text className={styles.credentialValue}>{credentials.email}</Text>
                  <CopyButton
                    content={credentials.email}
                    size="small"
                    title={t('users.modals.create.copy')}
                  />
                </div>
              </div>
              <div className={styles.field}>
                <Text strong>{t('users.modals.create.credentialPassword')}</Text>
                <div className={styles.credentialRow}>
                  <Text className={styles.credentialValue} data-testid="created-user-password">
                    {credentials.password}
                  </Text>
                  <CopyButton
                    content={credentials.password}
                    size="small"
                    title={t('users.modals.create.copy')}
                  />
                </div>
              </div>
              <div className={styles.footer}>
                <Button type="primary" onClick={handleDone}>
                  {t('users.modals.create.done')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Text as="h2" className={styles.title}>
                {t('users.modals.create.title')}
              </Text>
              <Text type="secondary">{t('users.modals.create.desc')}</Text>
              <div className={styles.field}>
                <Text strong>{t('users.modals.create.emailLabel')}</Text>
                <Input
                  aria-label={t('users.modals.create.emailLabel')}
                  autoComplete="off"
                  disabled={locked}
                  maxLength={EMAIL_MAX}
                  status={emailInvalid ? 'error' : undefined}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                {emailInvalid ? (
                  <Text className={styles.error}>{t('users.modals.create.emailInvalid')}</Text>
                ) : null}
              </div>
              <div className={styles.field}>
                <Text strong>{t('users.modals.create.fullNameLabel')}</Text>
                <Input
                  aria-label={t('users.modals.create.fullNameLabel')}
                  autoComplete="off"
                  disabled={locked}
                  maxLength={FULL_NAME_MAX}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <Text strong>{t('users.modals.create.usernameLabel')}</Text>
                <Input
                  aria-label={t('users.modals.create.usernameLabel')}
                  autoComplete="off"
                  disabled={locked}
                  maxLength={USERNAME_MAX}
                  status={usernameInvalid ? 'error' : undefined}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                {usernameInvalid ? (
                  <Text className={styles.error}>{t('users.modals.create.usernameInvalid')}</Text>
                ) : null}
              </div>
              <div className={styles.field}>
                <Text strong>{t('users.modals.create.passwordLabel')}</Text>
                <div className={styles.passwordRow}>
                  <InputPassword
                    aria-label={t('users.modals.create.passwordLabel')}
                    autoComplete="new-password"
                    disabled={locked}
                    maxLength={PASSWORD_MAX}
                    status={passwordInvalid ? 'error' : undefined}
                    style={{ flex: 1 }}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button disabled={locked} onClick={handleGenerate}>
                    {t('users.modals.create.generate')}
                  </Button>
                </div>
                <Text type="secondary">{t('users.modals.create.passwordHint')}</Text>
                {passwordInvalid ? (
                  <Text className={styles.error}>{t('users.modals.create.passwordInvalid')}</Text>
                ) : null}
              </div>
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
                  loading={phase === 'mutating' || phase === 'reauthing'}
                  type="primary"
                  onClick={() => void handleSubmit()}
                >
                  {t('users.modals.create.confirm')}
                </Button>
              </div>
            </>
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
    current: { closedExplicitly: false, phase: 'idle' },
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
      const { closedExplicitly, phase } = dismissGuardRef.current;
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
      // Escape / dismiss / close — abort immediately, do not wait for unmount.
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    },
  });

  return instance;
};
