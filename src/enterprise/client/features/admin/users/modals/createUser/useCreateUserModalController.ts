'use client';

import { toast, useModalContext } from '@lobehub/ui/base-ui';
import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useModalPhaseGuard } from '@/enterprise/client/features/admin/primitives/useModalPhaseGuard';
import {
  type AdminReauthBusyPhase,
  useReauthMutation,
} from '@/enterprise/client/features/admin/primitives/useReauthMutation';
import type { AdminUsersCreateInput } from '@/enterprise/client/services/adminUsers';

import { CREATE_USER_AUTO_REASON } from '../../../audit/shared/auditReasonCodes';
import { getAdminUsersCreateErrorKey } from '../../utils';
import { generatePassword } from '../generatePassword';
import type { CreateUserModalContentProps, CreateUserModalPhase } from './types';
import { validateCreateUserForm } from './validation';

/**
 * Form state, reauth-wrapped submit and every dismissal handler for the create-user
 * modal. Split out so the content component is only the two panels it swaps between.
 */
export const useCreateUserModalController = ({
  abortControllerRef,
  authMethod,
  dismissGuardRef,
  onPhaseChange,
  onSubmit,
}: CreateUserModalContentProps) => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  const { close } = useModalContext();

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  /** One-time credentials — lives only in modal state, cleared on close/unmount. */
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);

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

  return {
    canSubmit,
    credentials,
    email,
    emailInvalid,
    errorKey,
    fullName,
    handleCancelReauth,
    handleClose,
    handleDone,
    handleGenerate,
    handleSubmit,
    locked,
    password,
    passwordInvalid,
    phase,
    phaseKey: phase === 'success' && credentials ? ('success' as const) : ('form' as const),
    reduceMotion,
    setEmail,
    setFullName,
    setPassword,
    setUsername,
    username,
    usernameInvalid,
  };
};
