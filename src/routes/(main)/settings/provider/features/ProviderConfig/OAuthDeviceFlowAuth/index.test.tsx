import { MotionProvider } from '@lobehub/ui';
import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OAuthDeviceFlowAuth from './index';

const render = (ui: ReactElement) =>
  rtlRender(<MotionProvider motion={motion}>{ui}</MotionProvider>);

const mocks = vi.hoisted(() => ({
  authStatus: undefined as unknown,
  flow: {
    apiKeyPhase: 'idle' as string,
    cancelAuth: vi.fn(),
    deviceCodeInfo: undefined as unknown,
    error: undefined as unknown,
    startAuth: vi.fn(),
    state: 'idle' as string,
    submitAccessToken: vi.fn(),
    submitApiKey: vi.fn(),
    submitCallback: vi.fn(),
    submitError: undefined as unknown,
    submitErrorSource: undefined as unknown,
    submitSessionToken: vi.fn(),
    submitting: false,
  },
  flowOptions: { value: undefined as Record<string, unknown> | undefined },
  invalidate: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('./useOAuthDeviceFlow', () => ({
  useOAuthDeviceFlow: (options: Record<string, unknown>) => {
    mocks.flowOptions.value = options;
    return mocks.flow;
  },
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));

vi.mock('@/libs/trpc/client', () => ({
  lambdaQuery: {
    oauthDeviceFlow: {
      getAuthStatus: { useQuery: () => ({ data: mocks.authStatus }) },
      revokeAuth: { useMutation: () => ({ isPending: false, mutateAsync: mocks.revoke }) },
    },
    useUtils: () => ({
      oauthDeviceFlow: {
        getAuthStatus: { invalidate: (...args: unknown[]) => mocks.invalidate(...args) },
      },
    }),
  },
}));

vi.mock('react-i18next', () => ({
  // The key is the assertion surface here; the link markup is exercised by the browser check.
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  useTranslation: () => ({ t: (key: string) => key }),
}));

const b64url = (value: string) =>
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

/** next-auth compact JWE, the shape of a real chatgpt.com session cookie. */
const SESSION_JWE = [b64url('{"alg":"dir","enc":"A256GCM"}'), '', 'aXY', 'Y3Q', 'dGFn'].join('.');
/** Compact JWS — an access token, which cannot renew itself. */
const ACCESS_JWT = [b64url('{"alg":"RS256"}'), b64url('{"sub":"u"}'), 'sig'].join('.');

const pasteDeviceCode = {
  allowAccessTokenPaste: true,
  deviceCode: 'envelope',
  expiresIn: 600,
  flow: 'authorization_code_paste',
  interval: 0,
  userCode: '',
  verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
};

const deviceCode = {
  allowAccessTokenPaste: false,
  deviceCode: 'dc-1',
  expiresIn: 600,
  flow: 'device_code',
  interval: 5,
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://x.ai/device',
  verificationUriComplete: 'https://x.ai/device?code=ABCD-EFGH',
};

/**
 * The two-route paste layout (authorization page + a disclosed paste box). `chatgpt` stands
 * in for a provider whose card does NOT set `webSessionOnly`: the panel picks the layout off
 * the card, and `chatgptweb` now declares the session as its only route.
 */
const startPasteFlow = async () => {
  const view = render(<OAuthDeviceFlowAuth name="ChatGPT" providerId="chatgpt" />);
  fireEvent.click(screen.getByText('providerModels.config.oauth.connect'));
  await screen.findByText('providerModels.config.oauth.paste.openAuthorizePage');
  return view;
};

/** The single-route layout: paste the chatgpt.com web session, connect, done. */
const startSessionOnlyFlow = async () => {
  const view = render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);
  fireEvent.click(screen.getByText('providerModels.config.oauth.connect'));
  await screen.findByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder');
  return view;
};

beforeEach(() => {
  mocks.authStatus = undefined;
  mocks.revoke = vi.fn();
  mocks.flow.apiKeyPhase = 'idle';
  mocks.flow.cancelAuth = vi.fn();
  mocks.flow.deviceCodeInfo = pasteDeviceCode;
  mocks.flow.error = undefined;
  mocks.flow.state = 'pending_user_auth';
  mocks.flow.startAuth = vi.fn().mockResolvedValue(pasteDeviceCode);
  mocks.flow.submitAccessToken = vi.fn();
  mocks.flow.submitApiKey = vi.fn();
  mocks.flow.submitCallback = vi.fn();
  mocks.flow.submitError = undefined;
  mocks.flow.submitErrorSource = undefined;
  mocks.flow.submitSessionToken = vi.fn();
  mocks.flow.submitting = false;
  mocks.flowOptions.value = undefined;
  mocks.invalidate = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('open', vi.fn());
});

describe('OAuthDeviceFlowAuth paste flow', () => {
  it('replaces the device-code chrome with the open/paste steps', async () => {
    await startPasteFlow();

    expect(screen.getByText('providerModels.config.oauth.paste.instruction')).toBeTruthy();
    // Nothing is polled and there is no code to type in this flow.
    expect(screen.queryByText('providerModels.config.oauth.polling')).toBeNull();
    expect(screen.queryByText('providerModels.config.oauth.enterCode')).toBeNull();
  });

  it('submits the trimmed callback URL', async () => {
    await startPasteFlow();

    fireEvent.change(
      screen.getByPlaceholderText('providerModels.config.oauth.paste.callbackPlaceholder'),
      { target: { value: '  https://platform.openai.com/auth/callback?code=a&state=b  ' } },
    );
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.submit'));

    expect(mocks.flow.submitCallback).toHaveBeenCalledWith(
      'https://platform.openai.com/auth/callback?code=a&state=b',
    );
  });

  it('keeps the pasted-credential route behind an explicit disclosure', async () => {
    await startPasteFlow();

    expect(
      screen.queryByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder'),
    ).toBeNull();

    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionToggle'));
    fireEvent.change(
      screen.getByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder'),
      { target: { value: `__Secure-next-auth.session-token=${SESSION_JWE}` } },
    );
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionSubmit'));

    // A web session is the renewable half, so it is what gets stored.
    expect(mocks.flow.submitSessionToken).toHaveBeenCalledWith(SESSION_JWE);
    expect(mocks.flow.submitAccessToken).not.toHaveBeenCalled();
  });

  it('names what was pasted, and falls back to the non-renewable access token', async () => {
    await startPasteFlow();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionToggle'));

    const field = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.sessionPlaceholder',
    );
    fireEvent.change(field, { target: { value: 'nonsense' } });
    expect(screen.getByText('providerModels.config.oauth.paste.detected.unknown')).toBeTruthy();
    expect(
      screen
        .getByText('providerModels.config.oauth.paste.sessionSubmit')
        .closest('button')!
        .hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.change(field, { target: { value: `Bearer ${ACCESS_JWT}` } });
    expect(screen.getByText('providerModels.config.oauth.paste.detected.accessToken')).toBeTruthy();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionSubmit'));
    expect(mocks.flow.submitAccessToken).toHaveBeenCalledWith(ACCESS_JWT);
    expect(mocks.flow.submitSessionToken).not.toHaveBeenCalled();
  });

  it('threads a captured device id through an access-token paste', async () => {
    await startPasteFlow();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionToggle'));
    fireEvent.change(
      screen.getByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder'),
      {
        target: {
          value: `-H 'OAI-Device-Id: chrome-did'\nAuthorization: Bearer ${ACCESS_JWT}`,
        },
      },
    );
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionSubmit'));
    expect(mocks.flow.submitAccessToken).toHaveBeenCalledWith(ACCESS_JWT, {
      deviceId: 'chrome-did',
    });
    expect(mocks.flow.submitSessionToken).not.toHaveBeenCalled();
  });

  it('drops the pasted credential the moment it is stored, even if the status re-read fails', async () => {
    // The REJECTED revalidation is the load-bearing part: clearing the flow behind an awaited
    // invalidate left `isAuthenticating` set for good when that read failed, so the textarea
    // kept a live chatgpt.com session cookie on screen indefinitely (and the rejection went
    // unhandled, because the flow never awaits this callback).
    mocks.invalidate = vi.fn().mockRejectedValue(new Error('offline'));
    const credential = `__Secure-next-auth.session-token=${SESSION_JWE}`;

    await startPasteFlow();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionToggle'));
    fireEvent.change(
      screen.getByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder'),
      { target: { value: credential } },
    );
    expect(screen.getByDisplayValue(credential)).toBeTruthy();

    // The server stored it: the flow reports success and the card is told to re-read.
    mocks.flow.state = 'success';
    await act(async () => {
      (mocks.flowOptions.value?.onSuccess as () => void)();
    });

    expect(
      screen.queryByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder'),
    ).toBeNull();
    expect(screen.queryByDisplayValue(credential)).toBeNull();
    expect(document.body.innerHTML).not.toContain(SESSION_JWE);
    expect(screen.getByText('providerModels.config.oauth.connected')).toBeTruthy();
  });

  it('hides the pasted-credential route for providers that do not accept one', async () => {
    mocks.flow.deviceCodeInfo = { ...pasteDeviceCode, allowAccessTokenPaste: false };
    mocks.flow.startAuth = vi.fn().mockResolvedValue(mocks.flow.deviceCodeInfo);

    await startPasteFlow();

    expect(screen.queryByText('providerModels.config.oauth.paste.sessionToggle')).toBeNull();
  });

  it('shows a recoverable submit error without tearing the form down', async () => {
    mocks.flow.submitError = 'invalidCallback';

    await startPasteFlow();

    expect(
      screen.getByText('providerModels.config.oauth.paste.errors.invalidCallback'),
    ).toBeTruthy();
    // The paste field survives so the user can correct it in place.
    expect(
      screen.getByPlaceholderText('providerModels.config.oauth.paste.callbackPlaceholder'),
    ).toBeTruthy();
  });

  it('does not auto-open the authorization page before the user reads the steps', async () => {
    await startPasteFlow();

    expect(window.open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.openAuthorizePage'));
    // noopener/noreferrer: the provider's page never gets a handle on this window.
    expect(window.open).toHaveBeenCalledWith(
      pasteDeviceCode.verificationUri,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('offers the web session alone for a provider that connects no other way', async () => {
    await startSessionOnlyFlow();

    expect(screen.getByText('providerModels.config.oauth.paste.sessionOnlyTitle')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.paste.sessionOnlyDesc')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.paste.sessionStep1')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.paste.sessionStep2')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.paste.sessionStep3')).toBeTruthy();
    // Step 1 used to name a page with nothing to click; both routes are now one click away.
    expect(
      screen.getByText('providerModels.config.oauth.paste.openChatGPT').closest('a'),
    ).toMatchObject({ rel: 'noopener noreferrer', target: '_blank' });
    expect(
      screen
        .getByText('providerModels.config.oauth.paste.openSessionPage')
        .closest('a')
        ?.getAttribute('href'),
    ).toBe('https://chatgpt.com/api/auth/session');
    // The 10-day fallback is offered, and never as a peer of the renewable route.
    expect(screen.getByText('providerModels.config.oauth.paste.sessionQuickTry')).toBeTruthy();
    // The box is the whole form — never behind a disclosure the user has to find.
    expect(screen.queryByText('providerModels.config.oauth.paste.sessionToggle')).toBeNull();
    // The authorization page signs the user into a different product and the server refuses
    // the exchange: none of that UI may be on screen.
    expect(screen.queryByText('providerModels.config.oauth.paste.openAuthorizePage')).toBeNull();
    expect(screen.queryByText('providerModels.config.oauth.paste.instruction')).toBeNull();
    expect(screen.queryByText('providerModels.config.oauth.paste.regenerate')).toBeNull();
    expect(
      screen.queryByPlaceholderText('providerModels.config.oauth.paste.callbackPlaceholder'),
    ).toBeNull();
    expect(screen.queryByText(pasteDeviceCode.verificationUri)).toBeNull();
  });

  it('submits the pasted session from the primary action of a web-session-only provider', async () => {
    await startSessionOnlyFlow();

    const submit = screen.getByText('providerModels.config.oauth.paste.submit').closest('button')!;
    // Nothing pasted yet: the one action of the form says so instead of failing on submit.
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(
      screen.getByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder'),
      { target: { value: `__Secure-next-auth.session-token=${SESSION_JWE}` } },
    );
    expect(screen.getByText('providerModels.config.oauth.paste.detected.session')).toBeTruthy();

    fireEvent.click(submit);
    expect(mocks.flow.submitSessionToken).toHaveBeenCalledWith(SESSION_JWE);
    expect(mocks.flow.submitCallback).not.toHaveBeenCalled();
  });

  it('names the connected account and warns when it cannot be renewed', () => {
    mocks.authStatus = {
      canRefresh: false,
      email: 'me@example.com',
      expiresAt: Date.UTC(2030, 0, 1),
      status: 'ACTIVE',
    };

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);

    expect(screen.getByText('providerModels.config.oauth.paste.connectedEmail')).toBeTruthy();
    // The session-only wording: it names the one remedy this provider actually offers, and
    // the generic copy (which also points at the authorization page) stays off screen.
    expect(
      screen.getByText('providerModels.config.oauth.paste.cannotAutoRenewBeforeSessionOnly'),
    ).toBeTruthy();
    expect(
      screen.queryByText('providerModels.config.oauth.paste.cannotAutoRenewBefore'),
    ).toBeNull();
    // ONE deadline, in the warning that explains it — not printed again as a neutral
    // "Expires {{time}}" line right above it.
    expect(screen.queryByText('providerModels.config.oauth.paste.expiresAt')).toBeNull();

    // The warning is not a dead end: the way out is offered right there. The authorization
    // page is not among them — this provider's server refuses that exchange.
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.pasteSession'));
    expect(mocks.flow.startAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('providerModels.config.oauth.paste.reconnectRenewable')).toBeNull();
  });

  it('lands on the web-session box when the warning sent the user there', async () => {
    mocks.authStatus = { canRefresh: false, email: 'me@example.com', status: 'ACTIVE' };

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.pasteSession'));

    // Already expanded: the user asked for this box, so it must not be behind a toggle.
    expect(
      await screen.findByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder'),
    ).toBeTruthy();
  });

  it('names the renewal path of a self-renewing connection', () => {
    mocks.authStatus = {
      canRefresh: true,
      email: 'me@example.com',
      expiresAt: Date.UTC(2030, 0, 1),
      renewalKind: 'web_session',
      status: 'ACTIVE',
    };

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);

    expect(screen.getByText('providerModels.config.oauth.paste.autoRenewKind')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.oauth.paste.reconnectRenewable')).toBeNull();
  });

  it('confirms a renewable connection instead of only dating its expiry', () => {
    mocks.authStatus = {
      canRefresh: true,
      email: 'me@example.com',
      expiresAt: Date.UTC(2030, 0, 1),
      status: 'ACTIVE',
    };

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);

    // No stored label (a connection made before it existed): the unnamed copy still applies.
    expect(screen.getByText('providerModels.config.oauth.paste.autoRenew')).toBeTruthy();
    // The expiry of a self-renewing connection is a rollover date, so it is labelled as one
    // instead of the bare "Expires {{time}}" that reads as a deadline.
    expect(screen.getByText('providerModels.config.oauth.paste.currentTokenUntil')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.oauth.paste.expiresAt')).toBeNull();
    // Nothing to fix, so no reconnect prompt and no warning.
    expect(screen.queryByText('providerModels.config.oauth.paste.reconnectRenewable')).toBeNull();
    expect(screen.queryByText(/providerModels\.config\.oauth\.paste\.cannotAutoRenew/)).toBeNull();
  });

  it('stays quiet about renewal when the server does not report it', () => {
    mocks.authStatus = { email: 'me@example.com', status: 'ACTIVE' };

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);

    expect(screen.queryByText(/providerModels\.config\.oauth\.paste\.cannotAutoRenew/)).toBeNull();
  });

  it('leaves the connected card of device-code providers untouched', () => {
    // GitHub Copilot reports canRefresh=false BY DESIGN: it is deliberately excluded from
    // the rotating-refresh set because its stable OAuth token mints new bearer tokens. The
    // paste flow's identity/expiry/renewal additions must therefore never render here, or
    // its users are told to reconnect before an expiry that never bites.
    mocks.authStatus = {
      canRefresh: false,
      email: 'me@example.com',
      expiresAt: Date.UTC(2030, 0, 1),
      status: 'ACTIVE',
      username: 'octocat',
    };

    render(<OAuthDeviceFlowAuth name="GitHub Copilot" providerId="githubcopilot" />);

    expect(screen.getByText('octocat')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.connected')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.oauth.paste.connectedEmail')).toBeNull();
    expect(screen.queryByText('providerModels.config.oauth.paste.expiresAt')).toBeNull();
    expect(screen.queryByText(/providerModels\.config\.oauth\.paste\.cannotAutoRenew/)).toBeNull();
    expect(screen.queryByText('providerModels.config.oauth.paste.autoRenew')).toBeNull();
    expect(screen.queryByText('providerModels.config.oauth.paste.reconnectRenewable')).toBeNull();
    expect(screen.queryByText('providerModels.config.oauth.paste.pasteSession')).toBeNull();
  });

  it('associates inline errors and labels with the paste inputs', async () => {
    mocks.flow.submitError = 'invalidCallback';

    await startPasteFlow();

    const field = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.callbackPlaceholder',
    );
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'providerModels.config.oauth.paste.errors.invalidCallback',
    );
    // The label points at the field it names.
    expect(document.querySelector(`label[for="${field.getAttribute('id')}"]`)?.textContent).toBe(
      'providerModels.config.oauth.paste.callbackLabel',
    );

    // The disclosure exposes its state.
    const toggle = screen
      .getByText('providerModels.config.oauth.paste.sessionToggle')
      .closest('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('reports a rejected access token on the token field, not the callback field', async () => {
    mocks.flow.submitError = 'accessTokenInvalid';

    await startPasteFlow();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionToggle'));

    const callbackField = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.callbackPlaceholder',
    );
    const tokenField = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.sessionPlaceholder',
    );
    expect(callbackField.getAttribute('aria-invalid')).toBeNull();
    expect(tokenField.getAttribute('aria-invalid')).toBe('true');
    // A provider that still HAS an authorization page keeps the copy that offers it.
    expect(
      document.getElementById(tokenField.getAttribute('aria-describedby')!.split(' ')[0])
        ?.textContent,
    ).toBe('providerModels.config.oauth.paste.errors.accessTokenInvalid');
  });

  /**
   * The same two rejections, on a provider whose authorization page its own server refuses:
   * the copy has to stop sending the user there, and only there.
   */
  it.each(['accessTokenInvalid', 'tokenNotWeb'])(
    'points a rejected %s at the web session alone for a web-session-only provider',
    async (submitError) => {
      mocks.flow.submitError = submitError;

      await startSessionOnlyFlow();

      const tokenField = screen.getByPlaceholderText(
        'providerModels.config.oauth.paste.sessionPlaceholder',
      );
      expect(
        document.getElementById(tokenField.getAttribute('aria-describedby')!.split(' ')[0])
          ?.textContent,
      ).toBe(`providerModels.config.oauth.paste.errors.${submitError}SessionOnly`);
    },
  );

  it('keeps a generic token failure on the token field it was submitted from', async () => {
    // A network blip during a token submit maps to the generic `authError`, which carries no
    // field of its own: only the submit SOURCE says where it belongs.
    mocks.flow.submitError = 'authError';
    mocks.flow.submitErrorSource = 'token';

    await startPasteFlow();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionToggle'));

    const callbackField = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.callbackPlaceholder',
    );
    const tokenField = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.sessionPlaceholder',
    );
    expect(callbackField.getAttribute('aria-invalid')).toBeNull();
    expect(tokenField.getAttribute('aria-invalid')).toBe('true');
    const describedBy = tokenField.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'providerModels.config.oauth.paste.errors.authError',
    );
  });

  it('keeps a generic callback failure on the callback field', async () => {
    mocks.flow.submitError = 'authError';
    mocks.flow.submitErrorSource = 'callback';

    await startPasteFlow();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.sessionToggle'));

    expect(
      screen
        .getByPlaceholderText('providerModels.config.oauth.paste.callbackPlaceholder')
        .getAttribute('aria-invalid'),
    ).toBe('true');
    expect(
      screen
        .getByPlaceholderText('providerModels.config.oauth.paste.sessionPlaceholder')
        .getAttribute('aria-invalid'),
    ).toBeNull();
  });
});

describe('OAuthDeviceFlowAuth failure states', () => {
  it('offers retry and cancel when the initiation fails, never an endless spinner', async () => {
    // Initiation drops the envelope before it fails, so a `!deviceCodeInfo` loading guard
    // placed first would swallow the error UI and strand the user on the spinner.
    mocks.flow.deviceCodeInfo = undefined;
    mocks.flow.error = 'authError';
    mocks.flow.state = 'error';
    mocks.flow.startAuth = vi.fn().mockResolvedValue(undefined);

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);
    fireEvent.click(screen.getByText('providerModels.config.oauth.connect'));

    expect(await screen.findByText('providerModels.config.oauth.retry')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.cancel')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.authError')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.oauth.connecting')).toBeNull();
  });

  it('offers retry and cancel when regenerating the link fails', async () => {
    const { rerender } = await startPasteFlow();

    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.regenerate'));

    // The regeneration rejects: the envelope is gone and the flow reports the error.
    mocks.flow.deviceCodeInfo = undefined;
    mocks.flow.error = 'authError';
    mocks.flow.state = 'error';
    // The real hook re-renders the card from its own state; the mocked one has none, so a
    // fresh `extra` node crosses the memo boundary in its place.
    rerender(
      <MotionProvider motion={motion}>
        <OAuthDeviceFlowAuth extra={<span />} name="ChatGPT Web" providerId="chatgptweb" />
      </MotionProvider>,
    );

    expect(screen.getByText('providerModels.config.oauth.retry')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.oauth.connecting')).toBeNull();
  });

  it('cancels out of the failed authentication back to the connect card', async () => {
    mocks.flow.deviceCodeInfo = undefined;
    mocks.flow.error = 'authError';
    mocks.flow.state = 'error';
    mocks.flow.startAuth = vi.fn().mockResolvedValue(undefined);

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);
    fireEvent.click(screen.getByText('providerModels.config.oauth.connect'));
    fireEvent.click(await screen.findByText('providerModels.config.oauth.cancel'));

    expect(mocks.flow.cancelAuth).toHaveBeenCalledTimes(1);
  });

  it('re-reads the connection status when the flow reports it stale', () => {
    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);

    (mocks.flowOptions.value?.onStatusStale as () => void)();

    // A credential stored by an abandoned run must not leave the card on "not connected".
    expect(mocks.invalidate).toHaveBeenCalledWith({ providerId: 'chatgptweb' });
  });
});

/**
 * Cursor: a device-flow SHAPE with no code to type (the browser login is approved on the page
 * itself) and a second route whose pasted credential is a dashboard API KEY, not an access
 * token. Both are read off the card / the server's answer, never off the provider id.
 */
describe('OAuthDeviceFlowAuth code-less browser login', () => {
  const cursorDeviceCode = {
    allowAccessTokenPaste: true,
    deviceCode: 'uuid.verifier',
    expiresIn: 1400,
    flow: 'device_code',
    interval: 3,
    userCode: '',
    verificationUri: 'https://cursor.com/loginDeepControl',
    verificationUriComplete: 'https://cursor.com/loginDeepControl?challenge=abc&uuid=u1',
  };

  const startCursorFlow = async () => {
    mocks.flow.deviceCodeInfo = cursorDeviceCode;
    mocks.flow.startAuth = vi.fn().mockResolvedValue(cursorDeviceCode);
    const view = render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);
    fireEvent.click(screen.getByText('providerModels.config.oauth.connect'));
    await screen.findByText('providerModels.config.oauth.openLinkToAuthorize');
    return view;
  };

  it('drops the code block when the provider issues no user code', async () => {
    await startCursorFlow();

    expect(screen.queryByText('providerModels.config.oauth.enterCode')).toBeNull();
    // The polling/expiry chrome is untouched — only the code instructions go.
    expect(screen.getByText('providerModels.config.oauth.polling')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.openBrowser')).toBeTruthy();
    // The bare verification page approves nothing without the challenge, so the copyable
    // fallback has to be the prefilled URI.
    expect(screen.getByText(cursorDeviceCode.verificationUriComplete)).toBeTruthy();
  });

  it('labels the pasted credential as an API key and submits it trimmed', async () => {
    await startCursorFlow();

    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.apiKeyToggle'));

    const field = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.apiKeyPlaceholder',
    );
    expect(screen.getByText('providerModels.config.oauth.paste.apiKeyLabel')).toBeTruthy();
    // Cursor's card names a dashboard, so the hint is the linked variant.
    expect(screen.getByText('providerModels.config.oauth.paste.apiKeyHintWithUrl')).toBeTruthy();
    // No access-token / web-session wording on this route.
    expect(screen.queryByText('providerModels.config.oauth.paste.sessionLabel')).toBeNull();

    const submit = screen.getByText('providerModels.config.oauth.paste.apiKeySubmit');
    // Empty is not a submit: no shape validation, but no blank redemption either.
    fireEvent.click(submit);
    expect(mocks.flow.submitApiKey).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '  key_live_abc  ' } });
    fireEvent.click(submit);

    expect(mocks.flow.submitApiKey).toHaveBeenCalledWith('key_live_abc');
  });

  it('labels the fallback URL and makes it copyable instead of dumping it as body text', async () => {
    await startCursorFlow();

    // For a code-less provider this link IS the connect route, so it cannot read as debug
    // output printed under the spinner.
    expect(screen.getByText('providerModels.config.oauth.verificationUrlLabel')).toBeTruthy();
    expect(screen.getByText(cursorDeviceCode.verificationUriComplete).getAttribute('href')).toBe(
      cursorDeviceCode.verificationUriComplete,
    );
  });

  it('offers the API-key route from the idle card, before any browser login is started', () => {
    mocks.flow.deviceCodeInfo = undefined;
    mocks.flow.state = 'idle';
    mocks.flow.startAuth = vi.fn();

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    // The durable route used to be reachable only after firing a real device-code request.
    expect(screen.getByText('providerModels.config.oauth.connect')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.paste.apiKeyToggle')).toBeTruthy();
    expect(mocks.flow.startAuth).not.toHaveBeenCalled();
  });

  it('hands the key to the flow instead of deciding envelope liveness from render state', async () => {
    // Nothing started yet: the shared beforeEach seeds a paste envelope this case must not see.
    mocks.flow.deviceCodeInfo = undefined;
    mocks.flow.state = 'idle';
    mocks.flow.startAuth = vi.fn().mockResolvedValue(cursorDeviceCode);

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.apiKeyToggle'));
    fireEvent.change(
      screen.getByPlaceholderText('providerModels.config.oauth.paste.apiKeyPlaceholder'),
      { target: { value: ' key_live_idle ' } },
    );
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.apiKeySubmit'));

    // The envelope belongs to the flow: only it can tell a live one from render state an
    // expiry already invalidated. No page opened and no user code shown on this route either.
    await vi.waitFor(() => expect(mocks.flow.submitApiKey).toHaveBeenCalledWith('key_live_idle'));
    expect(mocks.flow.startAuth).not.toHaveBeenCalled();
    expect(mocks.flow.submitAccessToken).not.toHaveBeenCalled();
    expect(screen.queryByText('providerModels.config.oauth.openBrowser')).toBeNull();
  });

  it('reports a refused envelope in the flow’s own words, not as a rejected key', () => {
    mocks.flow.deviceCodeInfo = undefined;
    mocks.flow.state = 'error';
    mocks.flow.error = 'authError';

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    // The idle card owns the failure; the key form keeps the box (and the typed key) intact.
    expect(screen.getByText('providerModels.config.oauth.authError')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.paste.apiKeyToggle')).toBeTruthy();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.apiKeyToggle'));
    expect(screen.queryByText('providerModels.config.oauth.paste.apiKeyError')).toBeNull();
  });

  it('offers a way out of a pending exchange and stands the browser login down', () => {
    mocks.flow.deviceCodeInfo = undefined;
    mocks.flow.state = 'idle';
    mocks.flow.apiKeyPhase = 'exchangingKey';

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.apiKeyToggle'));
    // A hidden round trip against the provider must never be a dead end.
    fireEvent.click(screen.getByText('providerModels.config.oauth.cancel'));
    expect(mocks.flow.cancelAuth).toHaveBeenCalledTimes(1);

    // And nothing else may start a competing run that would retire the same envelope.
    expect(
      screen
        .getByText('providerModels.config.oauth.connect')
        .closest('button')!
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('keeps the API-key route off a provider whose card does not offer one', () => {
    mocks.flow.deviceCodeInfo = undefined;
    mocks.flow.state = 'idle';

    render(<OAuthDeviceFlowAuth name="Grok" providerId="supergrok" />);

    expect(screen.queryByText('providerModels.config.oauth.paste.apiKeyToggle')).toBeNull();
  });

  it('names the API key as what renews the connection, and warns about nothing', () => {
    mocks.authStatus = {
      canRefresh: true,
      expiresAt: Date.UTC(2030, 0, 1),
      renewalKind: 'cursor_api_key',
      status: 'ACTIVE',
    };

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    expect(screen.getByText('providerModels.config.oauth.paste.autoRenewKind')).toBeTruthy();
    // It renews forever: the expiry is the current token's rollover, never a deadline.
    expect(screen.getByText('providerModels.config.oauth.paste.currentTokenUntil')).toBeTruthy();
    expect(screen.queryByText('providerModels.config.oauth.paste.expiresAt')).toBeNull();
    expect(screen.queryByText(/providerModels\.config\.oauth\.paste\.cannotAutoRenew/)).toBeNull();
  });
});

describe('OAuthDeviceFlowAuth device-code flow', () => {
  it('still shows the user code and polling hint for supergrok', async () => {
    mocks.flow.deviceCodeInfo = deviceCode;
    mocks.flow.startAuth = vi.fn().mockResolvedValue(deviceCode);

    render(<OAuthDeviceFlowAuth name="Grok" providerId="supergrok" />);
    fireEvent.click(screen.getByText('providerModels.config.oauth.connect'));

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.enterCode')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.polling')).toBeTruthy();
    // The paste chrome belongs to the other grant only.
    expect(screen.queryByText('providerModels.config.oauth.paste.instruction')).toBeNull();
    // And the API-key route belongs to the cards that declare one.
    expect(screen.queryByText('providerModels.config.oauth.paste.apiKeyToggle')).toBeNull();
    // Connect counts as user activation, so the prefilled page opens right away — isolated.
    expect(window.open).toHaveBeenCalledWith(
      deviceCode.verificationUriComplete,
      '_blank',
      'noopener,noreferrer',
    );
  });
});
