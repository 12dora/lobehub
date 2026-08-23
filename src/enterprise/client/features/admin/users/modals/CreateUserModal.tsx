'use client';

import { createModal, type ModalInstance } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { AnimatePresence, m } from 'motion/react';
import { memo } from 'react';

import { CreateUserCredentialsPanel } from './createUser/CreateUserCredentialsPanel';
import { createCreateUserDismissHandler } from './createUser/createUserDismissGuard';
import { CreateUserForm } from './createUser/CreateUserForm';
import type { CreateUserModalContentProps, CreateUserModalDismissGuard } from './createUser/types';
import { useCreateUserModalController } from './createUser/useCreateUserModalController';

export type {
  CreateUserModalContentProps,
  CreateUserModalDismissGuard,
  CreateUserModalPhase,
} from './createUser/types';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
}));

export const CreateUserModalContent = memo<CreateUserModalContentProps>((props) => {
  const {
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
    phaseKey,
    reduceMotion,
    setEmail,
    setFullName,
    setPassword,
    setUsername,
    username,
    usernameInvalid,
  } = useCreateUserModalController(props);

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
});

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
    onOpenChange: createCreateUserDismissHandler({
      abortControllerRef,
      dismissGuardRef,
      getInstance: () => instance,
    }),
  });

  return instance;
};
