import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OAuthDeviceFlowAuth from './index';

const render = (ui: ReactElement) =>
  rtlRender(<MotionProvider motion={motion}>{ui}</MotionProvider>);

const mocks = vi.hoisted(() => ({
  authStatus: undefined as unknown,
  flow: {
    cancelAuth: vi.fn(),
    deviceCodeInfo: undefined as unknown,
    error: undefined as unknown,
    startAuth: vi.fn(),
    state: 'idle' as string,
    submitAccessToken: vi.fn(),
    submitCallback: vi.fn(),
    submitError: undefined as unknown,
    submitErrorSource: undefined as unknown,
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
  useTranslation: () => ({ t: (key: string) => key }),
}));

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

const startPasteFlow = async () => {
  const view = render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);
  fireEvent.click(screen.getByText('providerModels.config.oauth.connect'));
  await screen.findByText('providerModels.config.oauth.paste.openAuthorizePage');
  return view;
};

beforeEach(() => {
  mocks.authStatus = undefined;
  mocks.revoke = vi.fn();
  mocks.flow.cancelAuth = vi.fn();
  mocks.flow.deviceCodeInfo = pasteDeviceCode;
  mocks.flow.error = undefined;
  mocks.flow.state = 'pending_user_auth';
  mocks.flow.startAuth = vi.fn().mockResolvedValue(pasteDeviceCode);
  mocks.flow.submitAccessToken = vi.fn();
  mocks.flow.submitCallback = vi.fn();
  mocks.flow.submitError = undefined;
  mocks.flow.submitErrorSource = undefined;
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

  it('keeps the access-token fallback behind an explicit disclosure', async () => {
    await startPasteFlow();

    expect(
      screen.queryByPlaceholderText('providerModels.config.oauth.paste.accessTokenPlaceholder'),
    ).toBeNull();

    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.accessTokenToggle'));
    fireEvent.change(
      screen.getByPlaceholderText('providerModels.config.oauth.paste.accessTokenPlaceholder'),
      { target: { value: 'sk-pasted' } },
    );
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.accessTokenSubmit'));

    expect(mocks.flow.submitAccessToken).toHaveBeenCalledWith('sk-pasted');
  });

  it('hides the token fallback for providers that do not accept one', async () => {
    mocks.flow.deviceCodeInfo = { ...pasteDeviceCode, allowAccessTokenPaste: false };
    mocks.flow.startAuth = vi.fn().mockResolvedValue(mocks.flow.deviceCodeInfo);

    await startPasteFlow();

    expect(screen.queryByText('providerModels.config.oauth.paste.accessTokenToggle')).toBeNull();
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

  it('names the connected account and warns when it cannot be renewed', () => {
    mocks.authStatus = {
      canRefresh: false,
      email: 'me@example.com',
      expiresAt: Date.UTC(2030, 0, 1),
      status: 'ACTIVE',
    };

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);

    expect(screen.getByText('providerModels.config.oauth.paste.connectedEmail')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.paste.expiresAt')).toBeTruthy();
    expect(
      screen.getByText('providerModels.config.oauth.paste.cannotAutoRenewBefore'),
    ).toBeTruthy();
  });

  it('stays quiet about renewal when the server does not report it', () => {
    mocks.authStatus = { email: 'me@example.com', status: 'ACTIVE' };

    render(<OAuthDeviceFlowAuth name="ChatGPT Web" providerId="chatgptweb" />);

    expect(screen.queryByText('providerModels.config.oauth.paste.cannotAutoRenew')).toBeNull();
    expect(
      screen.queryByText('providerModels.config.oauth.paste.cannotAutoRenewBefore'),
    ).toBeNull();
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
    expect(screen.queryByText('providerModels.config.oauth.paste.cannotAutoRenew')).toBeNull();
    expect(
      screen.queryByText('providerModels.config.oauth.paste.cannotAutoRenewBefore'),
    ).toBeNull();
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
      .getByText('providerModels.config.oauth.paste.accessTokenToggle')
      .closest('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('reports a rejected access token on the token field, not the callback field', async () => {
    mocks.flow.submitError = 'accessTokenInvalid';

    await startPasteFlow();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.accessTokenToggle'));

    const callbackField = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.callbackPlaceholder',
    );
    const tokenField = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.accessTokenPlaceholder',
    );
    expect(callbackField.getAttribute('aria-invalid')).toBeNull();
    expect(tokenField.getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps a generic token failure on the token field it was submitted from', async () => {
    // A network blip during a token submit maps to the generic `authError`, which carries no
    // field of its own: only the submit SOURCE says where it belongs.
    mocks.flow.submitError = 'authError';
    mocks.flow.submitErrorSource = 'token';

    await startPasteFlow();
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.accessTokenToggle'));

    const callbackField = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.callbackPlaceholder',
    );
    const tokenField = screen.getByPlaceholderText(
      'providerModels.config.oauth.paste.accessTokenPlaceholder',
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
    fireEvent.click(screen.getByText('providerModels.config.oauth.paste.accessTokenToggle'));

    expect(
      screen
        .getByPlaceholderText('providerModels.config.oauth.paste.callbackPlaceholder')
        .getAttribute('aria-invalid'),
    ).toBe('true');
    expect(
      screen
        .getByPlaceholderText('providerModels.config.oauth.paste.accessTokenPlaceholder')
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

describe('OAuthDeviceFlowAuth device-code flow', () => {
  it('still shows the user code and polling hint for SuperGrok', async () => {
    mocks.flow.deviceCodeInfo = deviceCode;
    mocks.flow.startAuth = vi.fn().mockResolvedValue(deviceCode);

    render(<OAuthDeviceFlowAuth name="SuperGrok" providerId="supergrok" />);
    fireEvent.click(screen.getByText('providerModels.config.oauth.connect'));

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.enterCode')).toBeTruthy();
    expect(screen.getByText('providerModels.config.oauth.polling')).toBeTruthy();
    // The paste chrome belongs to the other grant only.
    expect(screen.queryByText('providerModels.config.oauth.paste.instruction')).toBeNull();
    // Connect counts as user activation, so the prefilled page opens right away — isolated.
    expect(window.open).toHaveBeenCalledWith(
      deviceCode.verificationUriComplete,
      '_blank',
      'noopener,noreferrer',
    );
  });
});
