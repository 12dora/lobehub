import { Icon, Input, Text } from '@lobehub/ui';
import { Button, Checkbox } from '@lobehub/ui/base-ui';
import { type FormInstance, type InputRef } from 'antd';
import { Form } from 'antd';
import { createStaticStyles } from 'antd-style';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AuthCard from '@/features/AuthCard';

import type { TwoFactorFormValues, TwoFactorMode } from './useSignIn';

const styles = createStaticStyles(({ css, cssVar }) => ({
  inlineLink: css`
    cursor: pointer;
    color: ${cssVar.colorPrimary};
    text-decoration: underline;
  `,
  // A 6-digit code is read back digit by digit — space it out so a mistyped
  // character is findable without counting.
  totpInput: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 18px;
    letter-spacing: 4px;
  `,
}));

// Authenticator codes are digits only; strip anything a paste drags along
// ("123 456", "123-456") instead of failing the user's correct code.
const sanitizeTotpCode = (value: string) => value.replaceAll(/\D/g, '').slice(0, 6);

export interface SignInTwoFactorStepProps {
  form: FormInstance<{ code: string }>;
  loading: boolean;
  mode: TwoFactorMode;
  onBack: () => void;
  onSubmit: (values: TwoFactorFormValues) => Promise<void>;
  onToggleMode: () => void;
}

export const SignInTwoFactorStep = ({
  form,
  loading,
  mode,
  onBack,
  onSubmit,
  onToggleMode,
}: SignInTwoFactorStepProps) => {
  const { t } = useTranslation('auth');
  const codeInputRef = useRef<InputRef>(null);
  // Deliberately local: an unchecked box is the safe default on every fresh
  // challenge, and it must not survive a switch to the recovery-code path.
  const [trustDevice, setTrustDevice] = useState(false);

  const isBackupCode = mode === 'backupCode';

  // Refocus on mount and whenever the credential being asked for changes, so
  // the user can type straight away.
  useEffect(() => {
    codeInputRef.current?.focus();
  }, [mode]);

  return (
    <AuthCard
      footer={
        <Text align={'center'} fontSize={13} style={{ marginTop: 8 }} type={'secondary'}>
          <a
            role="button"
            style={{ color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
            tabIndex={0}
            onClick={onBack}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onBack();
              }
            }}
          >
            {t('betterAuth.signin.twoFactor.backToPassword')}
          </a>
        </Text>
      }
      subtitle={
        isBackupCode
          ? t('betterAuth.signin.twoFactor.backupCode.subtitle')
          : t('betterAuth.signin.twoFactor.subtitle')
      }
      title={
        isBackupCode
          ? t('betterAuth.signin.twoFactor.backupCode.title')
          : t('betterAuth.signin.twoFactor.title')
      }
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => onSubmit({ ...(values as { code: string }), trustDevice })}
      >
        <Form.Item
          name="code"
          normalize={isBackupCode ? (value: string) => value.trim() : sanitizeTotpCode}
          label={
            isBackupCode
              ? t('betterAuth.signin.twoFactor.backupCode.label')
              : t('betterAuth.signin.twoFactor.code.label')
          }
          rules={[
            {
              message: isBackupCode
                ? t('betterAuth.signin.twoFactor.backupCode.placeholder')
                : t('betterAuth.signin.twoFactor.code.placeholder'),
              required: true,
            },
          ]}
        >
          <Input
            // Both paths are one-time credentials — let the OS/browser offer the
            // SMS/authenticator code it already has.
            autoComplete="one-time-code"
            className={isBackupCode ? undefined : styles.totpInput}
            inputMode={isBackupCode ? 'text' : 'numeric'}
            maxLength={isBackupCode ? undefined : 6}
            ref={codeInputRef}
            size="large"
            style={{ padding: 6 }}
            placeholder={
              isBackupCode
                ? t('betterAuth.signin.twoFactor.backupCode.placeholder')
                : t('betterAuth.signin.twoFactor.code.placeholder')
            }
            prefix={
              <Icon icon={isBackupCode ? KeyRound : ShieldCheck} style={{ marginInline: 6 }} />
            }
          />
        </Form.Item>
        <Checkbox checked={trustDevice} style={{ marginBottom: 16 }} onChange={setTrustDevice}>
          {t('betterAuth.signin.twoFactor.trustDevice')}
        </Checkbox>
        <Button block htmlType="submit" loading={loading} size="large" type="primary">
          {t('betterAuth.signin.twoFactor.submit')}
        </Button>
      </Form>
      {/*
        Kept in plain sight, not behind a "having trouble?" disclosure: someone
        on this screen may have just lost the phone holding their authenticator.
      */}
      <Text align={'center'} fontSize={13} style={{ marginTop: 16 }} type={'secondary'}>
        <a
          className={styles.inlineLink}
          role="button"
          tabIndex={0}
          onClick={onToggleMode}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleMode();
            }
          }}
        >
          {isBackupCode
            ? t('betterAuth.signin.twoFactor.useTotp')
            : t('betterAuth.signin.twoFactor.useBackupCode')}
        </a>
      </Text>
    </AuthCard>
  );
};
