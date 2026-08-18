import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSignIn } from './useSignIn';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSearchParamsGet = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockMessageError = vi.hoisted(() => vi.fn());
const mockMessageSuccess = vi.hoisted(() => vi.fn());
const mockSignInSocial = vi.hoisted(() => vi.fn());
const mockSignInOauth2 = vi.hoisted(() => vi.fn());
const mockSignInEmail = vi.hoisted(() => vi.fn());
const mockSignInMagicLink = vi.hoisted(() => vi.fn());
const mockSignInPasskey = vi.hoisted(() => vi.fn());
const mockVerifyTotp = vi.hoisted(() => vi.fn());
const mockVerifyBackupCode = vi.hoisted(() => vi.fn());
const mockRequestPasswordReset = vi.hoisted(() => vi.fn());
const mockBusinessSignin = vi.hoisted(() => ({
  getAdditionalData: vi.fn(async () => ({})),
  preSocialSigninCheck: vi.fn(async () => true),
  ssoProviders: [] as string[],
}));
const mockLocalStorage = vi.hoisted(() => {
  const store = new Map<string, string>();

  return {
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => store.delete(key),
    setItem: (key: string, value: string) => store.set(key, value),
  };
});

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [{ get: mockSearchParamsGet }],
}));

vi.mock('@/components/AntdStaticMethods', () => ({
  message: { error: mockMessageError, success: mockMessageSuccess },
}));

vi.mock('@/libs/better-auth/auth-client', () => ({
  requestPasswordReset: mockRequestPasswordReset,
  signIn: {
    email: mockSignInEmail,
    magicLink: mockSignInMagicLink,
    oauth2: mockSignInOauth2,
    passkey: mockSignInPasskey,
    social: mockSignInSocial,
  },
  twoFactor: {
    verifyBackupCode: mockVerifyBackupCode,
    verifyTotp: mockVerifyTotp,
  },
}));

vi.mock('@/libs/better-auth/utils/client', () => ({
  isBuiltinProvider: (p: string) => ['google', 'github', 'apple'].includes(p),
  normalizeProviderId: (p: string) => p,
}));

vi.mock('@lobechat/business-const', () => ({
  BRANDING_NAME: 'LobeHub',
}));

vi.mock('@/business/client/hooks/useBusinessSignin', () => ({
  useBusinessSignin: () => ({
    getAdditionalData: mockBusinessSignin.getAdditionalData,
    preSocialSigninCheck: mockBusinessSignin.preSocialSigninCheck,
    ssoProviders: mockBusinessSignin.ssoProviders,
  }),
}));

let mockEnableBusinessFeatures = false;
let mockEnableMagicLink = false;
let mockProviderMetadata: Array<{
  icon: string | null;
  id: string;
  label: string | null;
  order: number;
  providerKey: string;
}> = [];
vi.mock('@/features/AuthShell', () => ({
  useAuthServerConfigStore: (selector: (s: any) => any) =>
    selector({
      serverConfig: {
        disableEmailPassword: false,
        enableBusinessFeatures: mockEnableBusinessFeatures,
        enableMagicLink: mockEnableMagicLink,
        oAuthSSOProviderMetadata: mockProviderMetadata,
        oAuthSSOProviders: ['google', 'github'],
      },
      serverConfigInit: true,
    }),
}));

const mockSetFieldValue = vi.fn();
const mockGetFieldValue = vi.fn();
const mockValidateFields = vi.fn();
const mockSetFields = vi.fn();
const mockResetFields = vi.fn();
const mockSubmit = vi.fn();
vi.mock('antd', async () => {
  const actual: any = await vi.importActual('antd');
  return {
    ...actual,
    Form: {
      ...actual.Form,
      useForm: () => [
        {
          getFieldValue: mockGetFieldValue,
          resetFields: mockResetFields,
          setFields: mockSetFields,
          setFieldValue: mockSetFieldValue,
          submit: mockSubmit,
          validateFields: mockValidateFields,
        },
      ],
    },
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
vi.stubGlobal('localStorage', mockLocalStorage);

const originalLocation = window.location;

describe('useSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.clear();
    mockSearchParamsGet.mockReturnValue(null);
    mockEnableBusinessFeatures = false;
    mockEnableMagicLink = false;
    mockProviderMetadata = [];
    mockBusinessSignin.ssoProviders = [];
    mockBusinessSignin.getAdditionalData.mockResolvedValue({});
    mockBusinessSignin.preSocialSigninCheck.mockResolvedValue(true);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: '' },
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should return initial values', () => {
      const { result } = renderHook(() => useSignIn());

      expect(result.current.step).toBe('email');
      expect(result.current.email).toBe('');
      expect(result.current.loading).toBe(false);
      expect(result.current.socialLoading).toBeNull();
      expect(result.current.isSocialOnly).toBe(false);
      expect(result.current.disableEmailPassword).toBe(false);
    });
  });

  describe('handleCheckUser', () => {
    it('should redirect to signup when user does not exist', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: false }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'new@example.com' });
      });

      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining('/signup?email=new%40example.com'),
      );
    });

    it('should go to password step when user exists with password', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      expect(result.current.step).toBe('password');
      expect(result.current.email).toBe('user@example.com');
    });

    it('should resolve username to email before checking', async () => {
      // First call: resolve-username
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ email: 'resolved@example.com', exists: true }),
          ok: true,
        })
        // Second call: check-user
        .mockResolvedValueOnce({
          json: async () => ({ exists: true, hasPassword: true }),
          ok: true,
        });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'myusername' });
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/resolve-username', expect.any(Object));
      expect(result.current.step).toBe('password');
      expect(result.current.email).toBe('resolved@example.com');
    });

    it('should show error for unregistered username', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: false }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'unknownuser' });
      });

      expect(mockMessageError).toHaveBeenCalled();
      expect(result.current.step).toBe('email');
    });

    it('should show error for invalid identifier', async () => {
      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'invalid email!@#' });
      });

      expect(mockMessageError).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('handleSignIn', () => {
    it('should call signIn.email and redirect on success', async () => {
      mockSignInEmail.mockImplementation(async (_data: any, opts: any) => {
        opts.onSuccess();
        return { error: null };
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      // Set email first via handleCheckUser
      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleSignIn({ password: 'password123' });
      });

      expect(mockSignInEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'user@example.com',
          password: 'password123',
        }),
        expect.any(Object),
      );
      expect(window.location.href).toBe('/');
    });

    it.each(['javascript:alert(1)', 'https://evil.com', '//evil.com'])(
      'should fall back to "/" instead of redirecting to hostile callbackUrl %s',
      async (hostileUrl) => {
        mockSearchParamsGet.mockImplementation((key: string) =>
          key === 'callbackUrl' ? hostileUrl : null,
        );
        mockSignInEmail.mockImplementation(async (_data: any, opts: any) => {
          opts.onSuccess();
          return { error: null };
        });
        mockFetch.mockResolvedValueOnce({
          json: async () => ({ exists: true, hasPassword: true }),
          ok: true,
        });

        const { result } = renderHook(() => useSignIn());

        await act(async () => {
          await result.current.handleCheckUser({ email: 'user@example.com' });
        });

        await act(async () => {
          await result.current.handleSignIn({ password: 'password123' });
        });

        expect(window.location.href).toBe('/');
      },
    );

    it('should surface sign in failure as an inline password error', async () => {
      mockSignInEmail.mockResolvedValue({
        error: { message: 'Invalid credentials', status: 401 },
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleSignIn({ password: 'wrong' });
      });

      // Error is pinned inline on the password field, not shown as a toast
      expect(mockSetFields).toHaveBeenCalledWith([
        { errors: ['Invalid credentials'], name: 'password' },
      ]);
      expect(mockMessageError).not.toHaveBeenCalled();
    });

    it('should redirect to verify-email on 403', async () => {
      mockSignInEmail.mockImplementation(async (_data: any, opts: any) => {
        opts.onError({ error: { status: 403 } });
        return { error: { message: 'Email not verified', status: 403 } };
      });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleSignIn({ password: 'password' });
      });

      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining('/verify-email?email=user%40example.com'),
      );
    });
  });

  describe('two-step verification', () => {
    // Drive the form to the 2FA challenge the way a real sign-in does.
    const arriveAtTwoFactorStep = async () => {
      mockSignInEmail.mockImplementation(async (_data: any, opts: any) => {
        // better-auth answers the challenge with HTTP 200, so better-fetch still
        // runs the caller's onSuccess handler.
        opts.onSuccess({ data: { twoFactorMethods: ['totp'], twoFactorRedirect: true } });
        return { data: { twoFactorMethods: ['totp'], twoFactorRedirect: true }, error: null };
      });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      await act(async () => {
        await result.current.handleSignIn({ password: 'password123' });
      });

      return result;
    };

    it('moves to the two-factor step and does NOT navigate away', async () => {
      const result = await arriveAtTwoFactorStep();

      expect(result.current.step).toBe('twoFactor');
      expect(result.current.twoFactorMode).toBe('totp');
      // The regression that would silently defeat 2FA: onSuccess fires on the
      // twoFactorRedirect response, so an ungated redirect navigates away before
      // the challenge can render.
      expect(window.location.href).toBe('');
      // …and a challenge is not a failed password
      expect(mockSetFields).not.toHaveBeenCalled();
    });

    it('completes sign-in on a correct TOTP code', async () => {
      const result = await arriveAtTwoFactorStep();
      mockVerifyTotp.mockResolvedValue({ data: { token: 'session-token' }, error: null });

      await act(async () => {
        await result.current.handleTwoFactorVerify({ code: '123456', trustDevice: true });
      });

      expect(mockVerifyTotp).toHaveBeenCalledWith({ code: '123456', trustDevice: true });
      expect(window.location.href).toBe('/');
    });

    it('pins a wrong code inline on the field instead of a toast', async () => {
      const result = await arriveAtTwoFactorStep();
      mockVerifyTotp.mockResolvedValue({
        data: null,
        error: { code: 'INVALID_CODE', message: 'Invalid code', status: 401 },
      });

      await act(async () => {
        await result.current.handleTwoFactorVerify({ code: '000000' });
      });

      expect(mockSetFields).toHaveBeenCalledWith([
        { errors: [expect.stringContaining('twoFactor.error')], name: 'code' },
      ]);
      expect(mockMessageError).not.toHaveBeenCalled();
      // The user stays on the challenge and can retry
      expect(result.current.step).toBe('twoFactor');
      expect(window.location.href).toBe('');
    });

    it('reads a 429 as too many attempts, distinctly from a wrong code', async () => {
      const result = await arriveAtTwoFactorStep();
      mockVerifyTotp.mockResolvedValue({
        data: null,
        error: { message: 'Too many requests', status: 429 },
      });

      await act(async () => {
        await result.current.handleTwoFactorVerify({ code: '123456' });
      });

      expect(mockSetFields).toHaveBeenCalledWith([
        { errors: [expect.stringContaining('RATE_LIMIT_EXCEEDED')], name: 'code' },
      ]);
      const [[[field]]] = mockSetFields.mock.calls as any;
      expect(field.errors[0]).not.toContain('twoFactor.error');
    });

    it('switches the submitted endpoint when the recovery-code path is chosen', async () => {
      const result = await arriveAtTwoFactorStep();
      mockVerifyBackupCode.mockResolvedValue({ data: { token: 'session-token' }, error: null });

      mockResetFields.mockClear();
      act(() => {
        result.current.handleToggleTwoFactorMode();
      });

      expect(result.current.twoFactorMode).toBe('backupCode');
      // Switching credentials clears the half-typed value + its inline error
      expect(mockResetFields).toHaveBeenCalledWith(['code']);

      await act(async () => {
        await result.current.handleTwoFactorVerify({ code: 'RECOVERY-1' });
      });

      expect(mockVerifyBackupCode).toHaveBeenCalledWith({
        code: 'RECOVERY-1',
        trustDevice: false,
      });
      expect(mockVerifyTotp).not.toHaveBeenCalled();
      expect(window.location.href).toBe('/');
    });

    it('returns to the password step without stranding the user', async () => {
      const result = await arriveAtTwoFactorStep();

      act(() => {
        result.current.handleBackToPassword();
      });

      expect(result.current.step).toBe('password');
      expect(result.current.email).toBe('user@example.com');
      expect(result.current.twoFactorMode).toBe('totp');
    });

    it('sends the user back to the password step when the challenge cookie has lapsed', async () => {
      const result = await arriveAtTwoFactorStep();
      mockVerifyTotp.mockResolvedValue({
        data: null,
        error: { code: 'INVALID_TWO_FACTOR_COOKIE', message: 'Invalid cookie', status: 401 },
      });

      await act(async () => {
        await result.current.handleTwoFactorVerify({ code: '123456' });
      });

      // No code can ever succeed against a lapsed challenge — don't leave the
      // user typing into a dead field.
      expect(result.current.step).toBe('password');
      expect(mockMessageError).toHaveBeenCalled();
    });

    it('still redirects normally when the account has no two-step verification', async () => {
      mockSignInEmail.mockImplementation(async (_data: any, opts: any) => {
        opts.onSuccess({ data: { redirect: false, token: 'session-token' } });
        return { data: { token: 'session-token' }, error: null };
      });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      await act(async () => {
        await result.current.handleSignIn({ password: 'password123' });
      });

      expect(result.current.step).toBe('password');
      expect(window.location.href).toBe('/');
    });
  });

  describe('passkey sign in', () => {
    it('signs in and redirects on a successful ceremony', async () => {
      mockSignInPasskey.mockResolvedValue({ data: { token: 'session-token' }, error: null });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handlePasskeySignIn();
      });

      expect(window.location.href).toBe('/');
      expect(mockMessageError).not.toHaveBeenCalled();
    });

    it.each(['AUTH_CANCELLED', 'ERROR_CEREMONY_ABORTED'])(
      'stays silent when the user dismisses the ceremony (%s)',
      async (code) => {
        mockSignInPasskey.mockResolvedValue({
          data: null,
          error: { code, message: 'Auth cancelled', status: 400 },
        });

        const { result } = renderHook(() => useSignIn());

        await act(async () => {
          await result.current.handlePasskeySignIn();
        });

        expect(mockMessageError).not.toHaveBeenCalled();
        expect(window.location.href).toBe('');
      },
    );

    it('reports a real passkey failure', async () => {
      mockSignInPasskey.mockResolvedValue({
        data: null,
        error: { code: 'UNKNOWN_ERROR', message: 'boom', status: 500 },
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handlePasskeySignIn();
      });

      expect(mockMessageError).toHaveBeenCalled();
    });

    it('skips the speculative autofill offer when WebAuthn is unavailable', async () => {
      const { result } = renderHook(() => useSignIn());

      expect(result.current.isPasskeySupported).toBe(false);

      await act(async () => {
        await result.current.handlePasskeyAutoFill();
      });

      expect(mockSignInPasskey).not.toHaveBeenCalled();
    });

    it('never surfaces a failed autofill attempt — it is speculative', async () => {
      Object.defineProperty(globalThis, 'PublicKeyCredential', {
        configurable: true,
        value: { isConditionalMediationAvailable: async () => true },
        writable: true,
      });
      mockSignInPasskey.mockResolvedValue({
        data: null,
        error: { code: 'ERROR_CEREMONY_ABORTED', message: 'aborted', status: 400 },
      });

      try {
        const { result } = renderHook(() => useSignIn());

        expect(result.current.isPasskeySupported).toBe(true);

        await act(async () => {
          await result.current.handlePasskeyAutoFill();
        });

        expect(mockSignInPasskey).toHaveBeenCalledWith({ autoFill: true });
        expect(mockMessageError).not.toHaveBeenCalled();
        expect(window.location.href).toBe('');
      } finally {
        Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
      }
    });
  });

  describe('handleSocialSignIn', () => {
    it('should call signIn.social for builtin providers', async () => {
      mockSignInSocial.mockResolvedValue({ url: 'https://google.com/auth' });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockSignInSocial).toHaveBeenCalledWith(
        expect.objectContaining({ newUserCallbackURL: '/onboarding', provider: 'google' }),
      );
      expect(mockMessageError).not.toHaveBeenCalled();
    });

    it('should call signIn.oauth2 for custom providers', async () => {
      mockSignInOauth2.mockResolvedValue({ url: 'https://custom.com/auth' });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('custom-oidc');
      });

      expect(mockSignInOauth2).toHaveBeenCalledWith(
        expect.objectContaining({ newUserCallbackURL: '/onboarding', providerId: 'custom-oidc' }),
      );
      // Ordinary OAuth must not inject reauth prompt flags
      const arg = mockSignInOauth2.mock.calls[0]![0];
      expect(arg.additionalData?.reauth).toBeUndefined();
      expect(arg.additionalData?.prompt).toBeUndefined();
    });

    it('reauth=1 injects prompt=login/max_age=0/reauth and keeps callback for oauth2', async () => {
      mockSearchParamsGet.mockImplementation((key: string) => {
        if (key === 'reauth') return '1';
        if (key === 'callbackUrl') return '/admin/reauth-complete?state=abc';
        return null;
      });
      mockSignInOauth2.mockResolvedValue({ url: 'https://authentik.example/auth' });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('authentik');
      });

      expect(mockSignInOauth2).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalData: expect.objectContaining({
            max_age: '0',
            prompt: 'login',
            reauth: true,
          }),
          callbackURL: '/admin/reauth-complete?state=abc',
          // reauth must not rewrite to onboarding
          newUserCallbackURL: '/admin/reauth-complete?state=abc',
          providerId: 'authentik',
        }),
      );
    });

    it('should NOT throw when result has error: null (redirect case)', async () => {
      mockSignInSocial.mockResolvedValue({
        error: null,
        redirect: true,
        url: 'https://google.com/auth',
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      // Should not show error toast — this is the critical regression test
      expect(mockMessageError).not.toHaveBeenCalled();
    });

    it('should show error when result has a real error', async () => {
      mockSignInSocial.mockResolvedValue({
        error: { message: 'OAuth failed', status: 500 },
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockMessageError).toHaveBeenCalled();
    });

    it('should not retry social sign in when captcha is returned unexpectedly', async () => {
      mockSignInSocial.mockResolvedValue({
        error: { code: 'CAPTCHA_REQUIRED', message: 'Missing CAPTCHA response', status: 400 },
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockSignInSocial).toHaveBeenCalledTimes(1);
      expect(mockMessageError).toHaveBeenCalled();
    });

    it('should save last auth provider to localStorage', async () => {
      mockSignInSocial.mockResolvedValue({ url: 'https://google.com/auth' });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(localStorage.getItem('lobehub:auth:last-provider:v1')).toBe('google');
    });

    it('should stop social sign in when business pre-check rejects', async () => {
      mockEnableBusinessFeatures = true;
      mockBusinessSignin.preSocialSigninCheck.mockResolvedValue(false);

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleSocialSignIn('google');
      });

      expect(mockBusinessSignin.preSocialSigninCheck).toHaveBeenCalled();
      expect(mockSignInSocial).not.toHaveBeenCalled();
    });
  });

  describe('handleBackToEmail', () => {
    it('should reset to email step', async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      expect(result.current.step).toBe('password');

      act(() => {
        result.current.handleBackToEmail();
      });

      expect(result.current.step).toBe('email');
      expect(result.current.email).toBe('');
      expect(result.current.isSocialOnly).toBe(false);
      // The shared form's password (+ any inline error) must be cleared so the
      // next email doesn't remount pre-filled with the previous account's value.
      expect(mockResetFields).toHaveBeenCalledWith(['password']);
    });
  });

  describe('handleForgotPassword', () => {
    it('should call requestPasswordReset and land on the email-sent state', async () => {
      mockRequestPasswordReset.mockResolvedValue(undefined);

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      // Set email first
      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(mockRequestPasswordReset).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'user@example.com' }),
      );
      // Success is a persistent landing state, not a fleeting toast
      expect(result.current.step).toBe('emailSent');
      expect(result.current.sentInfo).toEqual(
        expect.objectContaining({ email: 'user@example.com', type: 'resetPassword' }),
      );
    });

    it('should no-op when no email has been resolved yet', async () => {
      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
      expect(result.current.step).toBe('email');
    });

    it('should show error on failure', async () => {
      mockRequestPasswordReset.mockRejectedValue(new Error('fail'));

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(mockMessageError).toHaveBeenCalled();
      expect(result.current.step).toBe('password');
    });
  });

  describe('magic link', () => {
    it('should land on email-sent state when a passwordless user triggers magic link', async () => {
      mockEnableMagicLink = true;
      mockSignInMagicLink.mockResolvedValue({ error: null });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: false }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });

      expect(mockSignInMagicLink).toHaveBeenCalledTimes(1);
      expect(result.current.step).toBe('emailSent');
      expect(result.current.sentInfo).toEqual(
        expect.objectContaining({ email: 'user@example.com', type: 'magicLink' }),
      );
    });
  });

  describe('handleResendEmail', () => {
    it('should resend the password reset email and confirm', async () => {
      mockRequestPasswordReset.mockResolvedValue(undefined);
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      await act(async () => {
        await result.current.handleForgotPassword();
      });

      mockRequestPasswordReset.mockClear();

      await act(async () => {
        await result.current.handleResendEmail();
      });

      expect(mockRequestPasswordReset).toHaveBeenCalledTimes(1);
      expect(mockMessageSuccess).toHaveBeenCalled();
      expect(result.current.step).toBe('emailSent');
    });
  });

  describe('handleBackFromSent', () => {
    it('should return to the email entry (not the password step) after a reset email', async () => {
      mockRequestPasswordReset.mockResolvedValue(undefined);
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ exists: true, hasPassword: true }),
        ok: true,
      });

      const { result } = renderHook(() => useSignIn());

      await act(async () => {
        await result.current.handleCheckUser({ email: 'user@example.com' });
      });
      await act(async () => {
        await result.current.handleForgotPassword();
      });

      expect(result.current.step).toBe('emailSent');

      act(() => {
        result.current.handleBackFromSent();
      });

      // "Use a different email" must land on the email entry so the label
      // matches the action, and reset the shared password field.
      expect(result.current.step).toBe('email');
      expect(result.current.email).toBe('');
      expect(result.current.sentInfo).toBeNull();
      expect(mockResetFields).toHaveBeenCalledWith(['password']);
    });
  });

  describe('provider sorting', () => {
    it('should sort last used provider first', () => {
      localStorage.setItem('lobehub:auth:last-provider:v1', 'github');

      const { result } = renderHook(() => useSignIn());

      expect(result.current.oAuthSSOProviders[0]).toBe('github');

      localStorage.removeItem('lobehub:auth:last-provider:v1');
    });

    it('should use business SSO providers when business features are enabled by server config', () => {
      mockEnableBusinessFeatures = true;
      mockBusinessSignin.ssoProviders = ['saml'];

      const { result } = renderHook(() => useSignIn());

      expect(result.current.oAuthSSOProviders).toEqual(['saml']);
    });

    it('preserves the server-authoritative provider order when public metadata is present', () => {
      localStorage.setItem('lobehub:auth:last-provider:v1', 'github');
      mockProviderMetadata = [
        { icon: null, id: 'google', label: 'Work', order: 0, providerKey: 'google' },
        { icon: null, id: 'github', label: null, order: 1, providerKey: 'github' },
      ];

      const { result } = renderHook(() => useSignIn());

      expect(result.current.oAuthSSOProviders).toEqual(['google', 'github']);
      expect(result.current.oAuthSSOProviderMetadata).toEqual(mockProviderMetadata);
    });

    it('keeps non-artifact business SSO providers after the authoritative OIDC order', () => {
      mockEnableBusinessFeatures = true;
      mockBusinessSignin.ssoProviders = ['saml', 'work', 'enterprise-sso'];
      mockProviderMetadata = [
        { icon: null, id: 'work', label: 'Work account', order: 0, providerKey: 'work' },
      ];

      const { result } = renderHook(() => useSignIn());

      expect(result.current.oAuthSSOProviders).toEqual(['work', 'saml', 'enterprise-sso']);
    });
  });
});
