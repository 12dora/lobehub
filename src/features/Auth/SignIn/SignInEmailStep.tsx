import { Alert, Button, Flexbox, Icon, Input, Text } from '@lobehub/ui';
import { type FormInstance, type InputRef } from 'antd';
import { Badge, Divider, Form } from 'antd';
import { createStaticStyles } from 'antd-style';
import { Fingerprint, Mail } from 'lucide-react';
import { type CSSProperties, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import AuthIcons from '@/components/AuthIcons';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import AuthCard from '@/features/AuthCard';
import { AuthAgreement } from '@/features/AuthShell';
import type { GlobalServerConfig } from '@/types/serverConfig';

import { EMAIL_REGEX, shouldShowLocalEmailForm, USERNAME_REGEX } from './validation';

const styles = createStaticStyles(({ css, cssVar }) => ({
  inlineLink: css`
    cursor: pointer;
    color: ${cssVar.colorPrimary};
    text-decoration: underline;
  `,
}));

export { EMAIL_REGEX, USERNAME_REGEX } from './validation';

// Pin both the provider logo and the loading spinner to the same spot so the
// spinner doesn't jump when a social button enters its loading state.
const PROVIDER_ICON_STYLE: CSSProperties = { left: 12, position: 'absolute', top: 13 };

// Turn a provider id into a display name, e.g. "google" -> "Google".
const getProviderName = (provider: string) =>
  provider.toLowerCase().replaceAll(/(^|[_-])([a-z])/g, (_, __, c) => c.toUpperCase());

export interface SignInEmailStepProps {
  disableEmailPassword?: boolean;
  form: FormInstance<{ email: string }>;
  isPasskeySupported: boolean;
  isSocialOnly: boolean;
  lastAuthProvider?: string | null;
  loading: boolean;
  oAuthSSOProviderMetadata?: NonNullable<GlobalServerConfig['oAuthSSOProviderMetadata']>;
  oAuthSSOProviders: string[];
  onCheckUser: (values: { email: string }) => Promise<void>;
  onGoToSignup: () => void;
  onPasskeyAutoFill: () => void;
  onPasskeySignIn: () => void;
  onResetEmail: () => void;
  onSetPassword: () => void;
  onSocialSignIn: (provider: string) => void;
  passkeyLoading: boolean;
  serverConfigInit: boolean;
  socialLoading: string | null;
}

export const SignInEmailStep = ({
  disableEmailPassword,
  form,
  isPasskeySupported,
  isSocialOnly,
  lastAuthProvider,
  loading,
  oAuthSSOProviders,
  oAuthSSOProviderMetadata = [],
  passkeyLoading,
  serverConfigInit,
  socialLoading,
  onCheckUser,
  onGoToSignup,
  onPasskeyAutoFill,
  onPasskeySignIn,
  onResetEmail,
  onSetPassword,
  onSocialSignIn,
}: SignInEmailStepProps) => {
  const { t } = useTranslation('auth');
  const branding = useBranding();
  // Admin "open registration" toggle (M15) — hide the sign-up link when closed.
  // Defaults to open, so the link stays available when the platform feature is off.
  const openRegistration = useEnterprisePlatform().publicSnapshot.login.openRegistration;
  const emailInputRef = useRef<InputRef>(null);

  // Ref-latched so the speculative passkey offer is kicked off exactly once per
  // mount, without re-running the effect on every parent render.
  const passkeyAutoFillRef = useRef(onPasskeyAutoFill);
  passkeyAutoFillRef.current = onPasskeyAutoFill;

  useEffect(() => {
    emailInputRef.current?.focus();
    // Browser autofill can offer a passkey on the email field itself
    // (autoComplete="username webauthn"), so the user never types anything.
    passkeyAutoFillRef.current();
  }, []);

  const divider = (
    <Divider>
      <Text fontSize={12} type={'secondary'}>
        {t('betterAuth.signin.orContinueWith')}
      </Text>
    </Divider>
  );

  const getProviderLabel = (provider: string) => {
    const configuredLabel = oAuthSSOProviderMetadata.find((item) => item.id === provider)?.label;
    if (configuredLabel) return configuredLabel;
    const normalized = getProviderName(provider);
    const normalizedKey = normalized.replaceAll(/[^\da-z]/gi, '');
    const key = `betterAuth.signin.continueWith${normalizedKey}`;
    return t(key, { defaultValue: `Continue with ${normalized}` });
  };

  const getProviderIcon = (provider: string) => {
    const configured = oAuthSSOProviderMetadata.find((item) => item.id === provider)?.icon;
    const safeConfiguredIcon =
      configured && (configured.startsWith('https://') || configured.startsWith('data:image/'))
        ? configured
        : null;
    // A non-URL configured icon is a built-in icon key (e.g. the DingTalk login method seeds
    // `dingtalk`), so the admin-chosen provider key does not have to double as the icon name.
    // Unknown keys fall back to the generic user glyph inside AuthIcons.
    const iconKey = safeConfiguredIcon ? provider : configured?.trim() || provider;
    return safeConfiguredIcon ? (
      <img alt="" height={18} src={safeConfiguredIcon} style={PROVIDER_ICON_STYLE} width={18} />
    ) : (
      <Icon icon={AuthIcons(iconKey, 18)} style={PROVIDER_ICON_STYLE} />
    );
  };

  // Config is injected synchronously via window.__SERVER_CONFIG__, so the email
  // form is the primary path unless the account is social-only.
  const hasDatabaseProvider = oAuthSSOProviderMetadata.some((provider) => provider.label !== null);
  // Database OIDC augments the local break-glass path; it must never hide it.
  const showEmailForm = shouldShowLocalEmailForm({
    disableEmailPassword,
    hasConfiguredDatabaseProvider: hasDatabaseProvider,
    isSocialOnly,
  });

  return (
    <AuthCard title={t('signin.subtitle', { appName: branding.name })}>
      {serverConfigInit && (oAuthSSOProviders.length > 0 || isPasskeySupported) && (
        <Flexbox gap={12}>
          {oAuthSSOProviders.map((provider) => {
            const button = (
              <Button
                block
                icon={getProviderIcon(provider)}
                iconProps={{ size: 18, style: PROVIDER_ICON_STYLE }}
                key={provider}
                loading={socialLoading === provider}
                size="large"
                onClick={() => onSocialSignIn(provider)}
              >
                {getProviderLabel(provider)}
              </Button>
            );
            const showLastUsed =
              provider === lastAuthProvider &&
              (oAuthSSOProviders.length > 1 ||
                (oAuthSSOProviders.length === 1 && !disableEmailPassword));
            return showLastUsed ? (
              <Badge
                color="var(--ant-color-info)"
                count={t('betterAuth.signin.lastUsed')}
                key={provider}
                styles={{ root: { display: 'block', width: '100%' } }}
              >
                {button}
              </Badge>
            ) : (
              button
            );
          })}
          {/*
            Belongs with the other credential-free entries. Hidden outright when
            WebAuthn is unavailable (no HTTPS / old browser) rather than shown
            dead — every account here also has a password to fall back on.
          */}
          {isPasskeySupported && (
            <Button
              block
              icon={<Icon icon={Fingerprint} style={PROVIDER_ICON_STYLE} />}
              iconProps={{ size: 18, style: PROVIDER_ICON_STYLE }}
              loading={passkeyLoading}
              size="large"
              onClick={onPasskeySignIn}
            >
              {t('betterAuth.signin.passkey.action')}
            </Button>
          )}
          {showEmailForm && divider}
        </Flexbox>
      )}
      {serverConfigInit &&
        disableEmailPassword &&
        !hasDatabaseProvider &&
        oAuthSSOProviders.length === 0 && (
          <Alert showIcon description={t('betterAuth.signin.ssoOnlyNoProviders')} type="warning" />
        )}
      {showEmailForm && (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => onCheckUser(values as { email: string })}
        >
          <Form.Item
            name="email"
            rules={[
              { message: t('betterAuth.errors.emailRequired'), required: true },
              {
                validator: (_, value) => {
                  if (!value) return Promise.resolve();
                  const trimmedValue = (value as string).trim();
                  if (EMAIL_REGEX.test(trimmedValue) || USERNAME_REGEX.test(trimmedValue)) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error(t('betterAuth.errors.emailInvalid')));
                },
              },
            ]}
          >
            <Input
              // "webauthn" opts this field into conditional UI so the browser's
              // autofill dropdown can offer a saved passkey — dropped where no
              // ceremony can complete (no WebAuthn, or the desktop renderer,
              // whose origin the relying party will not accept), so the dropdown
              // never dangles an option that dies on selection.
              autoComplete={isPasskeySupported ? 'username webauthn' : 'username'}
              inputMode="email"
              placeholder={t('betterAuth.signin.emailPlaceholder')}
              prefix={<Icon icon={Mail} style={{ marginInline: 6 }} />}
              ref={emailInputRef}
              size="large"
              style={{ padding: 6 }}
            />
          </Form.Item>
          <Button block htmlType="submit" loading={loading} size="large" type="primary">
            {t('betterAuth.signin.nextStep')}
          </Button>
        </Form>
      )}
      {isSocialOnly && (
        <Alert
          showIcon
          style={{ marginTop: 12 }}
          type="info"
          description={
            <>
              {t('betterAuth.signin.socialOnlyHint')}{' '}
              <a
                className={styles.inlineLink}
                role="button"
                tabIndex={0}
                onClick={onSetPassword}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSetPassword();
                  }
                }}
              >
                {t('betterAuth.signin.setPassword')}
              </a>
            </>
          }
        />
      )}
      {isSocialOnly && (
        <Text align={'center'} fontSize={13} style={{ marginTop: 12 }} type={'secondary'}>
          <a
            className={styles.inlineLink}
            role="button"
            tabIndex={0}
            onClick={onResetEmail}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onResetEmail();
              }
            }}
          >
            {t('betterAuth.signin.emailSent.changeEmail')}
          </a>
        </Text>
      )}
      <AuthAgreement />
      {showEmailForm && openRegistration && (
        <Text align={'center'} fontSize={13} style={{ marginTop: 16 }} type={'secondary'}>
          {t('betterAuth.signin.noAccount')}{' '}
          <a
            className={styles.inlineLink}
            role="button"
            tabIndex={0}
            onClick={onGoToSignup}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onGoToSignup();
              }
            }}
          >
            {t('betterAuth.signin.signupLink')}
          </a>
        </Text>
      )}
    </AuthCard>
  );
};
