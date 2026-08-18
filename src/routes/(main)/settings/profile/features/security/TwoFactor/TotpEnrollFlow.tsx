'use client';

import { copyToClipboard, Text } from '@lobehub/ui';
import { Button, InputOTP, toast } from '@lobehub/ui/base-ui';
import { QRCode } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { twoFactor } from '@/libs/better-auth/auth-client';

import { authErrorMessageKey } from '../authErrorMessage';
import PasswordField from '../PasswordField';
import { PASSWORD_MAX_LENGTH } from '../passwordValidation';
import { securityStyles } from '../styles';
import { extractTotpSecret, rewriteTotpBrand } from '../totpUri';
import BackupCodes from './BackupCodes';
import StepIndicator from './StepIndicator';

const CODE_LENGTH = 6;

const styles = createStaticStyles(({ css }) => ({
  codeField: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  codeLabel: css`
    font-size: ${cssVar.fontSizeSM};
    font-weight: 500;
  `,
  qr: css`
    display: flex;
    justify-content: center;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  secret: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px;
    padding-inline: 12px;
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorFillQuaternary};
  `,
  secretValue: css`
    user-select: all;

    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSize};
    letter-spacing: 0.08em;
    overflow-wrap: anywhere;
  `,
}));

type Step = 'password' | 'scan' | 'confirm' | 'save';

const STEP_ORDER: Step[] = ['password', 'scan', 'confirm', 'save'];

interface TotpEnrollFlowProps {
  /** Leave enrolment without turning anything on (the pending secret stays inert). */
  onCancel: () => void;
  /** Enrolment finished and acknowledged — back to the overview. */
  onDone: () => void;
  /**
   * Raised for the recovery-code step. Losing those codes locks the user out, so the
   * modal must stop being dismissible by backdrop click or Escape until acknowledged.
   */
  onLockChange: (locked: boolean) => void;
}

/**
 * Staged authenticator enrolment: confirm password → scan → enter code → save recovery
 * codes. Each stage is its own screen with an explicit forward action, because the two
 * failure modes here (the app never got the secret, or the user walks away before saving
 * the recovery codes) are both silent and both end in a locked-out account.
 *
 * The server runs with `skipVerificationOnEnable: false`, so nothing is switched on until
 * step 3 accepts a code the authenticator actually produced.
 */
const TotpEnrollFlow = memo<TotpEnrollFlowProps>(({ onCancel, onDone, onLockChange }) => {
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation('common');
  const branding = useBranding();

  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totpUri, setTotpUri] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  const codeFieldId = useId();
  const codeLabelId = useId();
  const codeErrorId = useId();

  const stepLabels = useMemo(
    () => [
      t('profile.security.twoFactor.totp.step.password'),
      t('profile.security.twoFactor.totp.step.scan'),
      t('profile.security.twoFactor.totp.step.confirm'),
      t('profile.security.twoFactor.totp.step.save'),
    ],
    [t],
  );

  // The issuer baked into the URI is the build-time brand; show the runtime one instead.
  const brandedUri = useMemo(
    () => rewriteTotpBrand(totpUri, branding.name),
    [totpUri, branding.name],
  );
  const secret = useMemo(() => extractTotpSecret(brandedUri), [brandedUri]);

  const locked = step === 'save';
  useEffect(() => {
    onLockChange(locked);
    return () => onLockChange(false);
  }, [locked, onLockChange]);

  const handleEnable = useCallback(async () => {
    if (!password || busy) return;

    setBusy(true);
    setPasswordError(null);
    try {
      const { data, error } = await twoFactor.enable({ password });

      if (error) {
        if (error.code === 'INVALID_PASSWORD') {
          // Inline on the field that caused it, not a toast (useSignIn.ts precedent).
          setPasswordError(t('profile.security.password.incorrect'));
          return;
        }
        // `error.message` is Better Auth's own developer-facing English; the stable code
        // behind it is what we translate, and anything unmapped falls back to generic copy.
        const key = authErrorMessageKey(error);
        toast.error(key ? t(key) : tCommon('unknownError'));
        return;
      }

      setTotpUri(data?.totpURI ?? '');
      setBackupCodes(data?.backupCodes ?? []);
      setStep('scan');
    } catch (error) {
      console.error('Failed to start two-factor enrolment:', error);
      toast.error(tCommon('unknownError'));
    } finally {
      setBusy(false);
    }
  }, [busy, password, t, tCommon]);

  const handleVerify = useCallback(async () => {
    if (code.length !== CODE_LENGTH || busy) return;

    setBusy(true);
    setCodeError(null);
    try {
      const { error } = await twoFactor.verifyTotp({ code });

      if (error) {
        setCodeError(t('profile.security.twoFactor.totp.invalidCode'));
        return;
      }

      setStep('save');
    } catch (error) {
      console.error('Failed to verify the authenticator code:', error);
      toast.error(tCommon('unknownError'));
    } finally {
      setBusy(false);
    }
  }, [busy, code, t, tCommon]);

  const handleCopySecret = useCallback(async () => {
    if (!secret) return;
    await copyToClipboard(secret);
    toast.success(t('profile.security.twoFactor.totp.secretCopied'));
  }, [secret, t]);

  const handleDone = useCallback(() => {
    toast.success(t('profile.security.twoFactor.totp.enabled'));
    onDone();
  }, [onDone, t]);

  return (
    <>
      <StepIndicator current={STEP_ORDER.indexOf(step)} steps={stepLabels} />

      {step === 'password' && (
        <>
          <Text className={securityStyles.desc}>
            {t('profile.security.twoFactor.totp.passwordHint')}
          </Text>
          <PasswordField
            autoFocus
            autoComplete="current-password"
            disabled={busy}
            error={passwordError ?? undefined}
            label={t('profile.security.password.currentLabel')}
            maxLength={PASSWORD_MAX_LENGTH}
            value={password}
            onEnter={() => void handleEnable()}
            onChange={(value) => {
              setPassword(value);
              setPasswordError(null);
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
              onClick={() => void handleEnable()}
            >
              {t('profile.security.twoFactor.totp.setUp')}
            </Button>
          </div>
        </>
      )}

      {step === 'scan' && (
        <>
          <Text className={securityStyles.desc}>
            {t('profile.security.twoFactor.totp.scanHint')}
          </Text>
          {brandedUri && (
            <div className={styles.qr}>
              <QRCode bordered={false} size={168} value={brandedUri} />
            </div>
          )}
          {/* Manual-entry path: not every device can point a camera at its own screen. */}
          {secret && (
            <div className={styles.secret}>
              <div>
                <Text className={securityStyles.desc}>
                  {t('profile.security.twoFactor.totp.secretLabel')}
                </Text>
                <div className={styles.secretValue}>{secret}</div>
              </div>
              <Button size="small" onClick={() => void handleCopySecret()}>
                {t('profile.security.twoFactor.backupCodes.copy')}
              </Button>
            </div>
          )}
          <div className={securityStyles.footerSpread}>
            <Button type="text" onClick={onCancel}>
              {t('profile.security.close')}
            </Button>
            <Button type="primary" onClick={() => setStep('confirm')}>
              {t('profile.security.twoFactor.totp.step.confirm')}
            </Button>
          </div>
        </>
      )}

      {step === 'confirm' && (
        <>
          <Text className={securityStyles.desc}>
            {t('profile.security.twoFactor.totp.codeHint')}
          </Text>
          {/* Label, input and message are one field — not three siblings of the body stack. */}
          <div className={styles.codeField}>
            {/*
              `InputOTP` spreads unknown props onto the base-ui `OTPField.Root`, which keeps
              `id` for itself and hands it to the *first* OTP input — so `htmlFor` makes a
              real native label association with that input. The root itself renders as a
              `div role="group"` that the `id` never lands on, which is why the group is named
              separately through `aria-labelledby` and carries the validation wiring
              (`aria-describedby` / `aria-invalid`) for the field as a whole.
            */}
            <label className={styles.codeLabel} htmlFor={codeFieldId} id={codeLabelId}>
              {t('profile.security.twoFactor.totp.codeLabel')}
            </label>
            <InputOTP
              aria-describedby={codeError ? codeErrorId : undefined}
              aria-invalid={codeError ? true : undefined}
              aria-labelledby={codeLabelId}
              disabled={busy}
              id={codeFieldId}
              length={CODE_LENGTH}
              value={code}
              onChange={(value: string) => {
                setCode(value);
                setCodeError(null);
              }}
            />
            {codeError && (
              <Text className={securityStyles.danger} id={codeErrorId} role="alert">
                {codeError}
              </Text>
            )}
          </div>
          <div className={securityStyles.footerSpread}>
            {/* Back, not cancel: the QR is one tap away if the app never got the secret. */}
            <Button disabled={busy} type="text" onClick={() => setStep('scan')}>
              {t('profile.security.twoFactor.totp.step.scan')}
            </Button>
            <Button
              disabled={code.length !== CODE_LENGTH || busy}
              loading={busy}
              type="primary"
              onClick={() => void handleVerify()}
            >
              {t('profile.security.twoFactor.totp.setUp')}
            </Button>
          </div>
        </>
      )}

      {step === 'save' && (
        <>
          <Text as="h3" className={securityStyles.title}>
            {t('profile.security.twoFactor.backupCodes.title')}
          </Text>
          <BackupCodes
            codes={backupCodes}
            downloadName={branding.shortName || branding.name}
            actions={
              <Button type="primary" onClick={handleDone}>
                {t('profile.security.twoFactor.backupCodes.done')}
              </Button>
            }
          />
        </>
      )}
    </>
  );
});

TotpEnrollFlow.displayName = 'TotpEnrollFlow';

export default TotpEnrollFlow;
