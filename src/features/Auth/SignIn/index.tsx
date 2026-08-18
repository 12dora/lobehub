'use client';

import { SignInEmailSentStep } from './SignInEmailSentStep';
import { SignInEmailStep } from './SignInEmailStep';
import { SignInPasswordStep } from './SignInPasswordStep';
import { SignInTwoFactorStep } from './SignInTwoFactorStep';
import { useSignIn } from './useSignIn';

const SignIn = () => {
  const {
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
    oAuthSSOProviders,
    oAuthSSOProviderMetadata,
    passkeyLoading,
    sending,
    sentInfo,
    serverConfigInit,
    socialLoading,
    step,
    twoFactorMode,
  } = useSignIn();

  if (step === 'emailSent' && sentInfo)
    return (
      <SignInEmailSentStep
        email={sentInfo.email}
        sending={sending}
        type={sentInfo.type}
        onBack={handleBackFromSent}
        onResend={handleResendEmail}
      />
    );

  if (step === 'twoFactor')
    return (
      <SignInTwoFactorStep
        form={form as any}
        loading={loading}
        mode={twoFactorMode}
        onBack={handleBackToPassword}
        onSubmit={handleTwoFactorVerify}
        onToggleMode={handleToggleTwoFactorMode}
      />
    );

  if (step === 'password')
    return (
      <SignInPasswordStep
        email={email}
        forgotLoading={sending}
        form={form as any}
        loading={loading}
        onBackToEmail={handleBackToEmail}
        onForgotPassword={handleForgotPassword}
        onSubmit={handleSignIn}
      />
    );

  return (
    <SignInEmailStep
      disableEmailPassword={disableEmailPassword}
      form={form as any}
      isPasskeySupported={isPasskeySupported}
      isSocialOnly={isSocialOnly}
      lastAuthProvider={lastAuthProvider}
      loading={loading}
      oAuthSSOProviderMetadata={oAuthSSOProviderMetadata}
      oAuthSSOProviders={oAuthSSOProviders}
      passkeyLoading={passkeyLoading}
      serverConfigInit={serverConfigInit}
      socialLoading={socialLoading}
      onCheckUser={handleCheckUser}
      onGoToSignup={handleGoToSignup}
      onPasskeyAutoFill={handlePasskeyAutoFill}
      onPasskeySignIn={handlePasskeySignIn}
      onResetEmail={handleBackToEmail}
      onSetPassword={handleForgotPassword}
      onSocialSignIn={handleSocialSignIn}
    />
  );
};

export default SignIn;
