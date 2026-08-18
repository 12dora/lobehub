'use client';

import { Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { twoFactor } from '@/libs/better-auth/auth-client';

import { authErrorMessageKey } from '../authErrorMessage';
import PasswordField from '../PasswordField';
import { PASSWORD_MAX_LENGTH } from '../passwordValidation';
import { securityStyles } from '../styles';

interface DisableTotpViewProps {
  onCancel: () => void;
  onDone: () => void;
}

/**
 * Turning two-step verification off is destructive and quiet — nothing visibly breaks, the
 * account simply gets weaker — so the screen leads with what stops working before it asks
 * for anything. The password is Better Auth's own contract for `twoFactor.disable`, not an
 * extra gate stacked on top of it.
 */
const DisableTotpView = memo<DisableTotpViewProps>(({ onCancel, onDone }) => {
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation('common');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleDisable = useCallback(async () => {
    if (!password || busy) return;

    setBusy(true);
    setError(null);
    try {
      const { error: disableError } = await twoFactor.disable({ password });

      if (disableError) {
        if (disableError.code === 'INVALID_PASSWORD') {
          setError(t('profile.security.password.incorrect'));
          return;
        }
        const key = authErrorMessageKey(disableError);
        toast.error(key ? t(key) : tCommon('unknownError'));
        return;
      }

      toast.success(t('profile.security.twoFactor.totp.disabled'));
      onDone();
    } catch (caught) {
      console.error('Failed to disable two-factor:', caught);
      toast.error(tCommon('unknownError'));
    } finally {
      setBusy(false);
    }
  }, [busy, onDone, password, t, tCommon]);

  return (
    <>
      <Text as="h3" className={securityStyles.title}>
        {t('profile.security.twoFactor.totp.disableTitle')}
      </Text>
      <Text className={securityStyles.desc}>
        {t('profile.security.twoFactor.totp.disableDesc')}
      </Text>
      <PasswordField
        autoFocus
        autoComplete="current-password"
        disabled={busy}
        error={error ?? undefined}
        label={t('profile.security.password.currentLabel')}
        maxLength={PASSWORD_MAX_LENGTH}
        value={password}
        onEnter={() => void handleDisable()}
        onChange={(value) => {
          setPassword(value);
          setError(null);
        }}
      />
      <div className={securityStyles.footer}>
        <Button disabled={busy} onClick={onCancel}>
          {t('profile.security.close')}
        </Button>
        <Button
          danger
          disabled={!password || busy}
          loading={busy}
          type="primary"
          onClick={() => void handleDisable()}
        >
          {t('profile.security.twoFactor.totp.disableConfirm')}
        </Button>
      </div>
    </>
  );
});

DisableTotpView.displayName = 'DisableTotpView';

export default DisableTotpView;
