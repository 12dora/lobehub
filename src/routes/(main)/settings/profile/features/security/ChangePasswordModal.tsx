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
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { changePassword, requestPasswordReset } from '@/libs/better-auth/auth-client';

import { authErrorMessageKey } from './authErrorMessage';
import PasswordField from './PasswordField';
import {
  type ChangePasswordErrors,
  type ChangePasswordFormValues,
  hasChangePasswordErrors,
  isChangePasswordComplete,
  mapChangePasswordError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateChangePassword,
} from './passwordValidation';
import { securityStyles } from './styles';

const styles = createStaticStyles(({ css }) => ({
  emailReset: css`
    padding-inline: 0;
    font-size: ${cssVar.fontSizeSM};
  `,
}));

const EMPTY_FORM: ChangePasswordFormValues = {
  confirmPassword: '',
  currentPassword: '',
  newPassword: '',
};

interface ChangePasswordContentProps {
  email?: string;
}

export const ChangePasswordContent = memo<ChangePasswordContentProps>(({ email }) => {
  const { t: tAuth } = useTranslation('auth');
  const { close } = useModalContext();

  const [form, setForm] = useState<ChangePasswordFormValues>(EMPTY_FORM);
  const [errors, setErrors] = useState<ChangePasswordErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [sendingResetEmail, setSendingResetEmail] = useState(false);

  const busy = submitting || sendingResetEmail;
  const canSubmit = isChangePasswordComplete(form) && !busy;
  // Better Auth's default is to keep other sessions alive; a password change is most often
  // a response to "someone may have this" so the safe answer is preselected — and still
  // the user's to undo.
  const [revokeOthers, setRevokeOthers] = useState(true);

  const setField = useCallback(
    (field: keyof ChangePasswordFormValues) => (value: string) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      // Clear only this field's message — leaving a stale "not correct" under an input the
      // user has since retyped is the worst kind of wrong.
      setErrors((prev) => (prev[field] === undefined ? prev : { ...prev, [field]: undefined }));
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    if (!isChangePasswordComplete(form) || busy) return;

    const localErrors = validateChangePassword(form);
    if (hasChangePasswordErrors(localErrors)) {
      setErrors(localErrors);
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
        revokeOtherSessions: revokeOthers,
      });

      if (error) {
        const fieldErrors = mapChangePasswordError(error);
        if (fieldErrors) {
          setErrors(fieldErrors);
          return;
        }
        // Not attributable to a field (server / network) — a toast is the honest surface,
        // carrying our copy for the code rather than Better Auth's developer English.
        const key = authErrorMessageKey(error);
        toast.error(key ? tAuth(key) : tAuth('profile.resetPasswordError'));
        return;
      }

      toast.success(tAuth('profile.security.password.success'));
      close();
    } catch (error) {
      console.error('Failed to change password:', error);
      toast.error(tAuth('profile.resetPasswordError'));
    } finally {
      setSubmitting(false);
    }
  }, [busy, close, form, revokeOthers, tAuth]);

  // The in-app form needs the *current* password, which is exactly what a user who has
  // forgotten it cannot supply. The email path stays reachable from here rather than
  // disappearing when the row gained a real form.
  const handleEmailReset = useCallback(async () => {
    if (!email || busy) return;

    setSendingResetEmail(true);
    try {
      const { error } = await requestPasswordReset({
        email,
        redirectTo: `/reset-password?email=${encodeURIComponent(email)}`,
      });
      if (error) {
        const key = authErrorMessageKey(error);
        toast.error(key ? tAuth(key) : tAuth('profile.resetPasswordError'));
        return;
      }
      toast.success(tAuth('profile.resetPasswordSent'));
      close();
    } catch (error) {
      console.error('Failed to send reset password email:', error);
      toast.error(tAuth('profile.resetPasswordError'));
    } finally {
      setSendingResetEmail(false);
    }
  }, [busy, close, email, tAuth]);

  const lengthRule = useMemo(
    () => tAuth('profile.security.password.rule', { min: PASSWORD_MIN_LENGTH }),
    [tAuth],
  );

  return (
    <div className={securityStyles.body}>
      <Text as="h2" className={securityStyles.title}>
        {tAuth('profile.security.password.title')}
      </Text>

      {/* The three inputs are one unit — a tighter stack than the gaps around the block. */}
      <div className={securityStyles.fields}>
        <PasswordField
          autoFocus
          autoComplete="current-password"
          disabled={busy}
          error={errors.currentPassword ? tAuth('profile.security.password.incorrect') : undefined}
          label={tAuth('profile.security.password.currentLabel')}
          maxLength={PASSWORD_MAX_LENGTH}
          value={form.currentPassword}
          onChange={setField('currentPassword')}
        />

        <PasswordField
          autoComplete="new-password"
          disabled={busy}
          hint={lengthRule}
          hintIsError={errors.newPassword === 'rule'}
          label={tAuth('profile.security.password.newLabel')}
          maxLength={PASSWORD_MAX_LENGTH}
          value={form.newPassword}
          error={
            errors.newPassword === 'reuse' ? tAuth('profile.security.password.reuse') : undefined
          }
          onChange={setField('newPassword')}
        />

        <PasswordField
          autoComplete="new-password"
          disabled={busy}
          error={errors.confirmPassword ? tAuth('profile.security.password.mismatch') : undefined}
          label={tAuth('profile.security.password.confirmLabel')}
          maxLength={PASSWORD_MAX_LENGTH}
          value={form.confirmPassword}
          onChange={setField('confirmPassword')}
          onEnter={() => void handleSubmit()}
        />
      </div>

      <Checkbox checked={revokeOthers} disabled={busy} onChange={setRevokeOthers}>
        {tAuth('profile.security.password.revokeOthers')}
      </Checkbox>

      {/* The escape hatch shares the action row instead of claiming a line of its own. */}
      <div className={securityStyles.footerSpread}>
        {email ? (
          <Button
            className={styles.emailReset}
            disabled={busy}
            loading={sendingResetEmail}
            size="small"
            type="link"
            onClick={() => void handleEmailReset()}
          >
            {tAuth('profile.security.password.useEmailReset')}
          </Button>
        ) : (
          <span />
        )}
        <div className={securityStyles.footer}>
          <Button disabled={busy} onClick={close}>
            {tAuth('profile.security.close')}
          </Button>
          <Button
            disabled={!canSubmit}
            loading={submitting}
            type="primary"
            onClick={() => void handleSubmit()}
          >
            {tAuth('profile.security.password.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
});

ChangePasswordContent.displayName = 'ChangePasswordContent';

/**
 * `title: null` deliberately suppresses the base-ui header (and its close button): the
 * content owns its heading and its own explicit Close, so a half-typed password cannot be
 * discarded by a stray click on the chrome.
 */
export const openChangePasswordModal = (options: { email?: string } = {}): ModalInstance =>
  createModal({
    content: <ChangePasswordContent email={options.email} />,
    footer: null,
    maskClosable: false,
    title: null,
    width: 'min(92vw, 420px)',
  });
