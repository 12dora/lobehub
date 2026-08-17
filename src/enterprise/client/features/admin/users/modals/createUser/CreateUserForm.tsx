'use client';

import { Input, InputPassword, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { EMAIL_MAX, FULL_NAME_MAX, PASSWORD_MAX, USERNAME_MAX } from './validation';

const styles = createStaticStyles(({ css }) => ({
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
}));

export interface CreateUserFormProps {
  canSubmit: boolean;
  email: string;
  emailInvalid: boolean;
  errorKey: string | null;
  fullName: string;
  locked: boolean;
  onCancelReauth: () => void;
  onClose: () => void;
  onEmailChange: (value: string) => void;
  onFullNameChange: (value: string) => void;
  onGenerate: () => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onUsernameChange: (value: string) => void;
  password: string;
  passwordInvalid: boolean;
  phase: 'idle' | 'mutating' | 'reauthing' | 'success';
  username: string;
  usernameInvalid: boolean;
}

export const CreateUserForm = memo<CreateUserFormProps>(
  ({
    canSubmit,
    email,
    emailInvalid,
    errorKey,
    fullName,
    locked,
    onCancelReauth,
    onClose,
    onEmailChange,
    onFullNameChange,
    onGenerate,
    onPasswordChange,
    onSubmit,
    onUsernameChange,
    password,
    passwordInvalid,
    phase,
    username,
    usernameInvalid,
  }) => {
    const { t } = useTranslation('admin');

    return (
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
            onChange={(e) => onEmailChange(e.target.value)}
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
            onChange={(e) => onFullNameChange(e.target.value)}
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
            onChange={(e) => onUsernameChange(e.target.value)}
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
              onChange={(e) => onPasswordChange(e.target.value)}
            />
            <Button disabled={locked} onClick={onGenerate}>
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
            <Button type="default" onClick={onCancelReauth}>
              {t('users.reauth.cancel')}
            </Button>
          ) : (
            <Button disabled={phase === 'mutating'} onClick={onClose}>
              {t('users.modals.cancel')}
            </Button>
          )}
          <Button
            disabled={!canSubmit}
            loading={phase === 'mutating' || phase === 'reauthing'}
            type="primary"
            onClick={() => void onSubmit()}
          >
            {t('users.modals.create.confirm')}
          </Button>
        </div>
      </>
    );
  },
);

CreateUserForm.displayName = 'CreateUserForm';
