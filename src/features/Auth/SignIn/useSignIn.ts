import { Form } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import type { CheckUserResponseData } from '@/app/(backend)/api/auth/check-user/route';
import type { ResolveUsernameResponseData } from '@/app/(backend)/api/auth/resolve-username/route';
import { useBusinessSignin } from '@/business/client/hooks/useBusinessSignin';
import { message } from '@/components/AntdStaticMethods';
import { useAuthServerConfigStore } from '@/features/AuthShell';
import { trackLoginOrSignupClicked } from '@/features/User/UserLoginOrSignup/trackLoginOrSignupClicked';
import { requestPasswordReset, signIn, twoFactor } from '@/libs/better-auth/auth-client';
import { isBuiltinProvider, normalizeProviderId } from '@/libs/better-auth/utils/client';
import { buildOnboardingRedirectUrl, sanitizeRedirectPath } from '@/utils/onboardingRedirect';
import { isPasskeySupported as detectPasskeySupport } from '@/utils/passkeySupport';

import { EMAIL_REGEX, USERNAME_REGEX } from './validation';

const LAST_AUTH_PROVIDER_KEY = 'lobehub:auth:last-provider:v1';

type Step = 'email' | 'password' | 'emailSent' | 'twoFactor';

type SentEmailType = 'magicLink' | 'resetPassword';

/**
 * The challenge screen shows one of two credentials at a time: the rolling
 * authenticator code, or a one-time recovery code for the phone-is-gone case.
 */
export type TwoFactorMode = 'totp' | 'backupCode';

interface SentEmailInfo {
  email: string;
  type: SentEmailType;
}

interface SignInFormValues {
  code: string;
  email: string;
  password: string;
}

/**
 * `signIn.email` answers with this shape (HTTP 200, no session) when the
 * account has two-step verification switched on.
 */
interface TwoFactorRedirectData {
  twoFactorMethods?: string[];
  twoFactorRedirect?: boolean;
}

export interface TwoFactorFormValues {
  code: string;
}

/**
 * A cancelled WebAuthn ceremony (user dismissed the OS sheet, or a newer
 * ceremony aborted the speculative autofill one) is a no-op, not a failure to
 * report.
 */
const isPasskeyCeremonyCancelled = (error: { code?: string; status: number }) =>
  error.code === 'AUTH_CANCELLED' || error.code === 'ERROR_CEREMONY_ABORTED';

interface ResolvedEmailResult {
  email: string;
  identifierType: 'email' | 'username';
}

export const useSignIn = () => {
  // `authError` carries the shared better-auth error codes (e.g. rate limiting),
  // same as the sign-up form.
  const { t } = useTranslation(['auth', 'authError']);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const enableMagicLink = useAuthServerConfigStore((s) => s.serverConfig.enableMagicLink || false);
  const disableEmailPassword = useAuthServerConfigStore(
    (s) => s.serverConfig.disableEmailPassword || false,
  );
  const enableBusinessFeatures = useAuthServerConfigStore(
    (s) => s.serverConfig.enableBusinessFeatures || false,
  );
  const [form] = Form.useForm<SignInFormValues>();
  const [loading, setLoading] = useState(false);
  // Locks the email-dispatch actions (magic link / password reset / resend) so a
  // slow network can't be double-clicked into multiple emails.
  const [sending, setSending] = useState(false);
  const [socialLoading, setSocialLoading] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [sentInfo, setSentInfo] = useState<SentEmailInfo | null>(null);
  const [isSocialOnly, setIsSocialOnly] = useState(false);
  const [twoFactorMode, setTwoFactorMode] = useState<TwoFactorMode>('totp');
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  // Covers both "this browser has no WebAuthn" and "this runtime can never
  // complete a ceremony for our RP" (the desktop renderer) — see detectPasskeySupport.
  const [isPasskeySupported] = useState(detectPasskeySupport);
  // Conditional-UI autofill is speculative and must run at most once per mount.
  const passkeyAutoFillStarted = useRef(false);
  const [lastAuthProvider] = useState(() => {
    try {
      return localStorage.getItem(LAST_AUTH_PROVIDER_KEY);
    } catch {
      return null;
    }
  });
  const serverConfigInit = useAuthServerConfigStore((s) => s.serverConfigInit);
  const oAuthSSOProviders = useAuthServerConfigStore((s) => s.serverConfig.oAuthSSOProviders) || [];
  const oAuthSSOProviderMetadata =
    useAuthServerConfigStore((s) => s.serverConfig.oAuthSSOProviderMetadata) || [];
  const { getAdditionalData, preSocialSigninCheck, ssoProviders } = useBusinessSignin();

  useEffect(() => {
    const emailParam = searchParams.get('email');
    if (emailParam) form.setFieldValue('email', emailParam);
  }, [searchParams, form]);

  const handleSendMagicLink = async (targetEmail?: string): Promise<boolean> => {
    if (sending) return false;
    try {
      const emailValue =
        targetEmail ||
        (await form
          .validateFields(['email'])
          .then((v) => v.email as string)
          .catch(() => null));
      if (!emailValue) return false;

      setSending(true);
      const callbackUrl = searchParams.get('callbackUrl') || '/';
      const { error } = await signIn.magicLink({
        callbackURL: callbackUrl,
        email: emailValue,
        // First-time magic-link users are signups — land them on onboarding first
        newUserCallbackURL: buildOnboardingRedirectUrl(callbackUrl),
      });
      if (error) {
        message.error(error.message || t('betterAuth.signin.magicLinkError'));
        return false;
      }
      // Success is a forward step, not a fleeting toast: land on a persistent
      // "check your inbox" screen (ux Act §3.5).
      setSentInfo({ email: emailValue, type: 'magicLink' });
      setStep('emailSent');
      return true;
    } catch (error) {
      if (!(error as any)?.errorFields) {
        console.error('Magic link error:', error);
        message.error(t('betterAuth.signin.magicLinkError'));
      }
      return false;
    } finally {
      setSending(false);
    }
  };

  const resolveEmailFromIdentifier = async (
    identifier: string,
  ): Promise<ResolvedEmailResult | null> => {
    const trimmedIdentifier = identifier.trim();
    if (!trimmedIdentifier) return null;

    const isEmailIdentifier = EMAIL_REGEX.test(trimmedIdentifier);
    if (isEmailIdentifier)
      return { email: trimmedIdentifier.toLowerCase(), identifierType: 'email' };

    if (!USERNAME_REGEX.test(trimmedIdentifier)) {
      message.error(t('betterAuth.errors.emailInvalid'));
      return null;
    }

    try {
      const response = await fetch('/api/auth/resolve-username', {
        body: JSON.stringify({ username: trimmedIdentifier }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const data: ResolveUsernameResponseData = await response.json();
      if (!response.ok || !data.exists || !data.email) {
        message.error(t('betterAuth.errors.usernameNotRegistered'));
        return null;
      }
      return { email: data.email, identifierType: 'username' };
    } catch (error) {
      console.error('Error resolving username:', error);
      message.error(t('betterAuth.signin.error'));
      return null;
    }
  };

  const handleCheckUser = async (values: Pick<SignInFormValues, 'email'>) => {
    setLoading(true);
    await trackLoginOrSignupClicked({ spm: 'signin.email_step.submit' });

    try {
      const resolvedEmail = await resolveEmailFromIdentifier(values.email);
      if (!resolvedEmail) return;

      const { email: targetEmail, identifierType } = resolvedEmail;
      const response = await fetch('/api/auth/check-user', {
        body: JSON.stringify({ email: targetEmail }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const data: CheckUserResponseData = await response.json();

      if (!data.exists) {
        if (identifierType === 'username') {
          message.error(t('betterAuth.errors.usernameNotRegistered'));
          return;
        }
        const callbackUrl = searchParams.get('callbackUrl') || '/';
        const signupParams = new URLSearchParams();
        signupParams.set('email', targetEmail);
        signupParams.set('callbackUrl', callbackUrl);
        const utmSource = searchParams.get('utm_source');
        if (utmSource) signupParams.set('utm_source', utmSource);
        const referral = searchParams.get('referral');
        if (referral) signupParams.set('referral', referral);
        navigate(`/signup?${signupParams.toString()}`);
        return;
      }

      setEmail(targetEmail);
      if (data.hasPassword) {
        setStep('password');
        return;
      }

      if (enableMagicLink) {
        await handleSendMagicLink(targetEmail);
        return;
      }

      // User has no password and magic link is disabled, they can only sign in via social
      setIsSocialOnly(true);
    } catch (error) {
      console.error('Error checking user:', error);
      message.error(t('betterAuth.signin.error'));
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async (values: Pick<SignInFormValues, 'password'>) => {
    setLoading(true);
    await trackLoginOrSignupClicked({ spm: 'signin.password_step.submit' });

    try {
      const callbackUrl = searchParams.get('callbackUrl') || '/';
      const result = await signIn.email(
        { callbackURL: callbackUrl, email, password: values.password },
        {
          onError: (ctx) => {
            console.error('Sign in error:', ctx.error);
            if (ctx.error.status === 403) {
              navigate(
                `/verify-email?email=${encodeURIComponent(email)}&callbackUrl=${encodeURIComponent(callbackUrl)}`,
              );
            }
          },
          // callbackUrl targets the main app, outside this auth SPA — full page load required
          onSuccess: (ctx) => {
            // A two-step challenge answers HTTP 200 with `{ twoFactorRedirect: true }`
            // and no session, so better-fetch still fires onSuccess. Redirecting here
            // would navigate away before the challenge step can render — which would
            // silently defeat two-step verification.
            if ((ctx?.data as TwoFactorRedirectData | undefined)?.twoFactorRedirect) return;
            window.location.href = sanitizeRedirectPath(callbackUrl);
          },
        },
      );

      if ((result.data as TwoFactorRedirectData | undefined)?.twoFactorRedirect) {
        // Always start on the authenticator code; the recovery path stays one
        // visible tap away for the phone-is-gone case.
        setTwoFactorMode('totp');
        form.resetFields(['code']);
        setStep('twoFactor');
        return;
      }

      if (result.error && result.error.status !== 403) {
        // Wrong password is the most common sign-in failure. Keep the error
        // pinned inline on the field (persistent, with retry context) rather
        // than a toast that vanishes in 3s (ux Read §1.1 / Same-Page Error).
        form.setFields([
          {
            errors: [result.error.message || t('betterAuth.signin.error')],
            name: 'password',
          },
        ]);
      }
    } catch (error) {
      console.error('Sign in error:', error);
      message.error(t('betterAuth.signin.error'));
    } finally {
      setLoading(false);
    }
  };

  const handleTwoFactorVerify = async (values: TwoFactorFormValues) => {
    setLoading(true);
    await trackLoginOrSignupClicked({ spm: 'signin.two_factor_step.submit' });

    try {
      const callbackUrl = searchParams.get('callbackUrl') || '/';
      const code = (values.code || '').trim();

      // `trustDevice` is deliberately never passed: a trusted-device record
      // outlives a 2FA disable/re-enrol cycle (see SignInTwoFactorStep), which
      // would turn the convenience into a password-only bypass of the new
      // authenticator. Omitting it keeps better-auth's default of false.
      const { error } =
        twoFactorMode === 'backupCode'
          ? await twoFactor.verifyBackupCode({ code })
          : await twoFactor.verifyTotp({ code });

      if (error) {
        // The intermediate challenge cookie is short-lived. Once it lapses no
        // code can ever work, so send the user back to re-enter the password
        // instead of leaving them typing into a dead field.
        if (error.code === 'INVALID_TWO_FACTOR_COOKIE') {
          setTwoFactorMode('totp');
          form.resetFields(['code']);
          setStep('password');
          message.error(t('betterAuth.signin.error'));
          return;
        }

        // Rate limiting must read as "too many attempts", never as a wrong code —
        // otherwise the user burns their remaining codes chasing a phantom typo.
        const errorText =
          error.status === 429
            ? t('authError:codes.RATE_LIMIT_EXCEEDED')
            : t('betterAuth.signin.twoFactor.error');

        // Same precedent as the password step: pin the failure inline on the
        // field being retried rather than a toast that vanishes in 3s.
        form.setFields([{ errors: [errorText], name: 'code' }]);
        return;
      }

      // callbackUrl targets the main app, outside this auth SPA — full page load required
      window.location.href = sanitizeRedirectPath(callbackUrl);
    } catch (error) {
      console.error('Two-factor verification error:', error);
      message.error(t('betterAuth.signin.twoFactor.error'));
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTwoFactorMode = () => {
    setTwoFactorMode((mode) => (mode === 'totp' ? 'backupCode' : 'totp'));
    // The two credentials have different shapes — carrying the typed value (and
    // its inline error) across would only look broken.
    form.resetFields(['code']);
  };

  // Leaves the challenge without stranding the user: the password field keeps
  // its value, so re-submitting issues a fresh challenge in one tap.
  const handleBackToPassword = () => {
    setTwoFactorMode('totp');
    form.resetFields(['code']);
    setStep('password');
  };

  const handlePasskeySignIn = async () => {
    if (passkeyLoading) return;
    setPasskeyLoading(true);
    await trackLoginOrSignupClicked({ provider: 'passkey', spm: 'signin.passkey.click' });

    try {
      const callbackUrl = searchParams.get('callbackUrl') || '/';
      const result = await signIn.passkey();

      if (result?.error) {
        if (isPasskeyCeremonyCancelled(result.error)) return;
        console.error('Passkey sign in error:', result.error);
        message.error(t('betterAuth.signin.passkey.error'));
        return;
      }
      if (!result?.data) return;

      // callbackUrl targets the main app, outside this auth SPA — full page load required
      window.location.href = sanitizeRedirectPath(callbackUrl);
    } catch (error) {
      console.error('Passkey sign in error:', error);
      message.error(t('betterAuth.signin.passkey.error'));
    } finally {
      setPasskeyLoading(false);
    }
  };

  /**
   * Browser-autofill ("conditional UI") passkey offer. Entirely speculative: the
   * user never asked for it, so every failure — including no conditional-UI
   * support and the abort fired when the explicit button starts its own
   * ceremony — stays silent.
   */
  const handlePasskeyAutoFill = async () => {
    if (!isPasskeySupported || passkeyAutoFillStarted.current) return;

    try {
      const conditionalMediation =
        await window.PublicKeyCredential?.isConditionalMediationAvailable?.();
      if (!conditionalMediation) return;

      passkeyAutoFillStarted.current = true;
      const callbackUrl = searchParams.get('callbackUrl') || '/';
      const result = await signIn.passkey({ autoFill: true });
      if (!result?.data) return;

      window.location.href = sanitizeRedirectPath(callbackUrl);
    } catch {
      // Speculative by design — never surface this to the user.
    }
  };

  const handleSocialSignIn = async (provider: string) => {
    setSocialLoading(provider);
    const normalizedProvider = normalizeProviderId(provider);
    await trackLoginOrSignupClicked({
      provider: normalizedProvider,
      spm: 'signin.social.click',
    });

    try {
      if (enableBusinessFeatures && !(await preSocialSigninCheck())) {
        setSocialLoading(null);
        return;
      }

      try {
        localStorage.setItem(LAST_AUTH_PROVIDER_KEY, provider);
      } catch {
        // Ignore localStorage errors (e.g., quota exceeded, private mode)
      }

      const callbackUrl = searchParams.get('callbackUrl') || '/';
      // First-time OAuth users are signups — land them on onboarding first
      // (skipped for admin reauth — keep the reauth-complete callback intact).
      const isAdminReauth = searchParams.get('reauth') === '1';
      const newUserCallbackURL = isAdminReauth
        ? callbackUrl
        : buildOnboardingRedirectUrl(callbackUrl);
      const businessAdditionalData = await getAdditionalData();
      // Narrow reauth=1 → additionalData so generic OAuth applies prompt=login/max_age=0.
      // Normal sign-in is unchanged (no reauth flag).
      const additionalData = isAdminReauth
        ? {
            ...businessAdditionalData,
            max_age: '0',
            prompt: 'login',
            reauth: true,
          }
        : businessAdditionalData;
      const signInWithAdditionalData = async () =>
        isBuiltinProvider(normalizedProvider)
          ? await signIn.social({
              additionalData,
              callbackURL: callbackUrl,
              newUserCallbackURL,
              provider: normalizedProvider,
            })
          : await signIn.oauth2({
              additionalData,
              callbackURL: callbackUrl,
              newUserCallbackURL,
              providerId: normalizedProvider,
            });

      const result = await signInWithAdditionalData();

      if (result && 'error' in result && result.error) throw result.error;
    } catch (error) {
      console.error(`${normalizedProvider} sign in error:`, error);
      message.error(t('betterAuth.signin.socialError'));
    } finally {
      setSocialLoading(null);
    }
  };

  const handleBackToEmail = () => {
    setStep('email');
    setEmail('');
    setIsSocialOnly(false);
    // Drop the previous account's password + any inline error. The form
    // instance is shared across steps and defaults to preserve, so without this
    // the next email's password step remounts pre-filled with the stale value.
    form.resetFields(['password']);
    // The pending challenge (and any typed code) belongs to the previous email.
    form.resetFields(['code']);
    setTwoFactorMode('totp');
  };

  const handleGoToSignup = () => {
    const currentEmail = form.getFieldValue('email');
    const callbackUrl = searchParams.get('callbackUrl') || '/';
    const params = new URLSearchParams();
    if (currentEmail) params.set('email', currentEmail);
    params.set('callbackUrl', callbackUrl);
    const utmSource = searchParams.get('utm_source');
    if (utmSource) params.set('utm_source', utmSource);
    const referral = searchParams.get('referral');
    if (referral) params.set('referral', referral);
    void trackLoginOrSignupClicked({ spm: 'signin.go_to_signup.click' }).finally(() => {
      navigate(`/signup?${params.toString()}`);
    });
  };

  // Fire the password-reset email. Returns true on success. Shared by the
  // "forgot password" entry and the resend action on the sent screen.
  const dispatchPasswordReset = async (targetEmail: string): Promise<boolean> => {
    if (sending) return false;
    setSending(true);
    try {
      await requestPasswordReset({
        email: targetEmail,
        redirectTo: `/reset-password?email=${encodeURIComponent(targetEmail)}`,
      });
      return true;
    } catch {
      message.error(t('betterAuth.signin.forgotPasswordError'));
      return false;
    } finally {
      setSending(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email || sending) return;
    const ok = await dispatchPasswordReset(email);
    if (!ok) return;
    setSentInfo({ email, type: 'resetPassword' });
    setStep('emailSent');
  };

  const handleResendEmail = async () => {
    if (!sentInfo || sending) return;
    const ok =
      sentInfo.type === 'magicLink'
        ? await handleSendMagicLink(sentInfo.email)
        : await dispatchPasswordReset(sentInfo.email);
    if (ok) message.success(t('betterAuth.signin.emailSent.resent'));
  };

  // "Use a different email" — always drop back to the email entry so the label
  // matches the action (returning to the password step would keep the same email).
  const handleBackFromSent = () => {
    setSentInfo(null);
    handleBackToEmail();
  };

  const resolvedProviders = enableBusinessFeatures ? ssoProviders : oAuthSSOProviders;
  // The startup artifact owns DB-provider order. Preserve it exactly so login does not
  // silently reshuffle a controlled work-account entry based on browser history.
  const orderedArtifactProviders = [...oAuthSSOProviderMetadata].sort((a, b) => a.order - b.order);
  const artifactProviderIds = orderedArtifactProviders.map((provider) => provider.id);
  const providersInArtifactOrder = artifactProviderIds.length
    ? [
        ...artifactProviderIds,
        ...resolvedProviders.filter((provider) => !artifactProviderIds.includes(provider)),
      ]
    : resolvedProviders;
  const sortedProviders =
    lastAuthProvider && artifactProviderIds.length === 0
      ? [...providersInArtifactOrder].sort((a, b) => {
          if (a === lastAuthProvider) return -1;
          if (b === lastAuthProvider) return 1;
          return 0;
        })
      : providersInArtifactOrder;

  return {
    disableEmailPassword,
    email,
    form,
    handleBackFromSent,
    handleBackToEmail,
    handleBackToPassword,
    handleCheckUser,
    handleForgotPassword,
    handleGoToSignup,
    handlePasskeyAutoFill,
    handlePasskeySignIn,
    handleResendEmail,
    handleSignIn,
    handleSocialSignIn,
    handleToggleTwoFactorMode,
    handleTwoFactorVerify,
    isPasskeySupported,
    isSocialOnly,
    lastAuthProvider,
    loading,
    passkeyLoading,
    oAuthSSOProviders: sortedProviders,
    oAuthSSOProviderMetadata: orderedArtifactProviders,
    sending,
    sentInfo,
    serverConfigInit: enableBusinessFeatures ? true : serverConfigInit,
    socialLoading,
    step,
    twoFactorMode,
  };
};
