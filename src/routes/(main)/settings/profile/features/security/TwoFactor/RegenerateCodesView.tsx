'use client';

import { Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { twoFactor } from '@/libs/better-auth/auth-client';

import PasswordField from '../PasswordField';
import { PASSWORD_MAX_LENGTH } from '../passwordValidation';
import { securityStyles } from '../styles';
import BackupCodes from './BackupCodes';

interface RegenerateCodesViewProps {
  onCancel: () => void;
  onDone: () => void;
  /** Raised once fresh codes are on screen — they are shown exactly once. */
  onLockChange: (locked: boolean) => void;
}

/**
 * Minting a fresh set of recovery codes. The old set dies the moment the new one is
 * created, so the hint says that up front, and the resulting codes get the same
 * not-dismissible treatment as the ones handed out during enrolment.
 */
const RegenerateCodesView = memo<RegenerateCodesViewProps>(({ onCancel, onDone, onLockChange }) => {
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation('common');
  const branding = useBranding();

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const locked = codes !== null;
  useEffect(() => {
    onLockChange(locked);
    return () => onLockChange(false);
  }, [locked, onLockChange]);

  const handleGenerate = useCallback(async () => {
    if (!password || busy) return;

    setBusy(true);
    setError(null);
    try {
      const { data, error: generateError } = await twoFactor.generateBackupCodes({ password });

      if (generateError) {
        if (generateError.code === 'INVALID_PASSWORD') {
          setError(t('profile.security.password.incorrect'));
          return;
        }
        toast.error(generateError.message || tCommon('unknownError'));
        return;
      }

      setCodes(data?.backupCodes ?? []);
    } catch (caught) {
      console.error('Failed to regenerate backup codes:', caught);
      toast.error(tCommon('unknownError'));
    } finally {
      setBusy(false);
    }
  }, [busy, password, t, tCommon]);

  return (
    <>
      <Text as="h3" className={securityStyles.title}>
        {t('profile.security.twoFactor.backupCodes.title')}
      </Text>

      {codes ? (
        <>
          <BackupCodes codes={codes} downloadName={branding.shortName || branding.name} />
          <div className={securityStyles.footer}>
            <Button type="primary" onClick={onDone}>
              {t('profile.security.twoFactor.backupCodes.done')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Text className={securityStyles.desc}>
            {t('profile.security.twoFactor.backupCodes.regenerateHint')}
          </Text>
          <PasswordField
            autoFocus
            autoComplete="current-password"
            disabled={busy}
            error={error ?? undefined}
            label={t('profile.security.password.currentLabel')}
            maxLength={PASSWORD_MAX_LENGTH}
            value={password}
            onEnter={() => void handleGenerate()}
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
              disabled={!password || busy}
              loading={busy}
              type="primary"
              onClick={() => void handleGenerate()}
            >
              {t('profile.security.twoFactor.backupCodes.regenerate')}
            </Button>
          </div>
        </>
      )}
    </>
  );
});

RegenerateCodesView.displayName = 'RegenerateCodesView';

export default RegenerateCodesView;
