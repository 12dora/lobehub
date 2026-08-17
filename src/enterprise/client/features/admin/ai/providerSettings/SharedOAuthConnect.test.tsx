import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SharedOAuthConnect from './SharedOAuthConnect';

const mocks = vi.hoisted(() => ({
  aiProviderList: [] as { enabled: boolean; id: string }[],
  aiProviderModelList: [] as { enabled: boolean; id: string }[],
  confirmModal: vi.fn(),
  disconnect: vi.fn(),
  enabledAiModels: [] as { id: string; providerId: string }[],
  flow: {
    apiKeyPhase: 'idle' as string,
    connect: vi.fn(),
    deviceCode: undefined as unknown,
    error: undefined as unknown,
    reset: vi.fn(),
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
  managedResource: {
    blocked: false,
    error: null as unknown,
    loading: false,
    managed: false,
    refresh: vi.fn(),
  },
  /** Real runtime takeover (published managed+enforced+flag), NOT the ui-only capability. */
  platformAiTakeover: { error: null as unknown, loading: false, takeover: false },
  notifyError: vi.fn(),
  refreshAiProviderDetail: vi.fn(),
  refreshAiProviderList: vi.fn(),
  refreshAiProviderRuntimeState: vi.fn(),
  swr: vi.fn(),
  toastSuccess: vi.fn(),
  withAdminReauthRetry: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmModal: (config: unknown) => mocks.confirmModal(config),
  toast: { error: vi.fn(), success: (...args: unknown[]) => mocks.toastSuccess(...args) },
}));

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  withAdminReauthRetry: (fn: () => Promise<unknown>) => mocks.withAdminReauthRetry(fn),
}));

vi.mock('@/enterprise/client/services/adminAiInfraAdapter/errors', () => ({
  notifyAdminAiInfraError: (...args: unknown[]) => mocks.notifyError(...args),
}));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => mocks.managedResource,
  usePlatformAiTakeover: () => mocks.platformAiTakeover,
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (...args: unknown[]) => mocks.swr(...args),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiProviderOAuth: {
        disconnect: { mutate: (...args: unknown[]) => mocks.disconnect(...args) },
        getConnectionStatus: { query: vi.fn() },
      },
    },
  },
}));

vi.mock('@/store/aiInfra', () => ({
  useAiInfraStoreApi: () => ({
    getState: () => ({
      refreshAiProviderDetail: mocks.refreshAiProviderDetail,
      refreshAiProviderList: mocks.refreshAiProviderList,
      refreshAiProviderRuntimeState: mocks.refreshAiProviderRuntimeState,
    }),
  }),
  useScopedAiInfraStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      aiProviderList: mocks.aiProviderList,
      aiProviderModelList: mocks.aiProviderModelList,
      enabledAiModels: mocks.enabledAiModels,
    }),
}));

vi.mock('./useAdminSharedOAuthFlow', () => ({
  useAdminSharedOAuthFlow: (options: Record<string, unknown>) => {
    mocks.flowOptions.value = options;
    return mocks.flow;
  },
}));

vi.mock('react-i18next', () => ({
  // The key is the assertion surface here; the link markup is exercised by the browser check.
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const render = (ui: ReactElement) =>
  rtlRender(
    <MemoryRouter>
      <MotionProvider motion={motion}>{ui}</MotionProvider>
    </MemoryRouter>,
  );

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

const connectedStatus = {
  accountEmail: 'ops@example.com',
  accountIdMasked: 'acc1…',
  connected: true,
  expiresAt: null,
  secretConfigured: true,
};

/** The config the component handed to `confirmModal` on the last Disconnect click. */
const lastConfirmConfig = () =>
  mocks.confirmModal.mock.calls.at(-1)?.[0] as {
    content: string;
    okButtonProps?: { danger?: boolean };
    okText: string;
    onOk: () => Promise<void>;
    title: string;
  };

const swrResult = (data: unknown) => ({
  data,
  error: undefined,
  isLoading: false,
  mutate: vi.fn(),
});

beforeEach(() => {
  mocks.swr.mockReset();
  mocks.confirmModal.mockReset();
  mocks.disconnect.mockReset();
  mocks.disconnect.mockResolvedValue({ disconnected: true, revision: 2 });
  mocks.notifyError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.refreshAiProviderDetail.mockReset();
  mocks.refreshAiProviderDetail.mockResolvedValue(undefined);
  mocks.refreshAiProviderList.mockReset();
  mocks.refreshAiProviderList.mockResolvedValue(undefined);
  mocks.refreshAiProviderRuntimeState.mockReset();
  mocks.refreshAiProviderRuntimeState.mockResolvedValue(undefined);
  mocks.withAdminReauthRetry.mockReset();
  mocks.withAdminReauthRetry.mockImplementation((fn: () => Promise<unknown>) => fn());
  mocks.managedResource = {
    blocked: false,
    error: null,
    loading: false,
    managed: false,
    refresh: vi.fn(),
  };
  mocks.platformAiTakeover = { error: null, loading: false, takeover: false };
  // Connect only enables the provider on FIRST connect, so the success copy reads this —
  // default to the ordinary "provider is on" case and override where a test needs off.
  mocks.aiProviderList = [{ enabled: true, id: 'chatgpt' }];
  mocks.aiProviderModelList = [];
  mocks.enabledAiModels = [];
  mocks.flow.apiKeyPhase = 'idle';
  mocks.flow.connect = vi.fn();
  mocks.flow.deviceCode = undefined;
  mocks.flow.error = undefined;
  mocks.flow.reset = vi.fn();
  mocks.flow.state = 'idle';
  mocks.flow.submitAccessToken = vi.fn();
  mocks.flow.submitApiKey = vi.fn();
  mocks.flow.submitCallback = vi.fn();
  mocks.flow.submitError = undefined;
  mocks.flow.submitErrorSource = undefined;
  mocks.flow.submitSessionToken = vi.fn();
  mocks.flow.submitting = false;
  mocks.flowOptions.value = undefined;
  mocks.swr.mockReturnValue(
    swrResult({
      accountEmail: null,
      accountIdMasked: null,
      connected: false,
      expiresAt: null,
      secretConfigured: false,
    }),
  );
});

describe('SharedOAuthConnect', () => {
  it('explains the disconnected state and offers a connect action', () => {
    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.notConnected')).toBeTruthy();
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.disconnectedHint/)).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.connect')).toBeTruthy();
  });

  it('shows the full sign-in email and expiry once connected', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        connected: true,
        expiresAt: String(Date.UTC(2030, 0, 1)),
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.connected')).toBeTruthy();
    // The email wins over the masked Codex workspace UUID: only it identifies the account.
    expect(screen.getByText(/"account":"ops@example.com"/)).toBeTruthy();
    expect(screen.queryByText(/"account":"acc1…"/)).toBeNull();
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.expiresAt/)).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.reconnect')).toBeTruthy();
  });

  it('falls back to the masked account id for connections stored before the email', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: null,
        accountIdMasked: 'acc1…',
        connected: true,
        expiresAt: null,
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText(/"account":"acc1…"/)).toBeTruthy();
  });

  it('says the account is unknown when neither identity is available', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: null,
        accountIdMasked: null,
        connected: true,
        expiresAt: null,
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.accountUnknown')).toBeTruthy();
  });

  it('offers a reload when the connection status cannot be read', () => {
    mocks.swr.mockReturnValue({
      data: undefined,
      error: new Error('boom'),
      isLoading: false,
      mutate: vi.fn(),
    });

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.statusFailed')).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.retryStatus')).toBeTruthy();
  });

  it('lets the operator cancel while the device code is still being requested', () => {
    mocks.flow.state = 'requesting';

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.requesting')).toBeTruthy();
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.cancel'));
    expect(mocks.flow.reset).toHaveBeenCalledTimes(1);
  });

  it('revalidates the connection status when the flow reports it stale', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('offline'));
    mocks.swr.mockReturnValue({ data: undefined, error: undefined, isLoading: false, mutate });

    render(<SharedOAuthConnect providerId="chatgpt" />);

    (mocks.flowOptions.value?.onStatusStale as () => void)();
    expect(mutate).toHaveBeenCalledTimes(1);
    // A failing revalidation must stay swallowed — the panel is not a failed action.
    await Promise.resolve();
  });

  it('asks for a model when the connected provider has no persisted enabled model', () => {
    mocks.flow.state = 'success';
    // The merged list carries enabled model-bank DEFAULTS even with zero platform rows —
    // claiming "live" off that is exactly the bug: runtime drops a model-less provider.
    mocks.aiProviderModelList = [
      { enabled: true, id: 'gpt-5' },
      { enabled: true, id: 'gpt-5-mini' },
    ];
    mocks.enabledAiModels = [];

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.success.published')).toBeNull();
  });

  it('confirms the provider is on only when the platform actually takes over', () => {
    mocks.flow.state = 'success';
    mocks.enabledAiModels = [{ id: 'gpt-5', providerId: 'chatgpt' }];
    mocks.platformAiTakeover.takeover = true;

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.published')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeNull();
    // Nothing is pending, so the hint stays away.
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeNull();
  });

  it('does not claim members are served while the catalog only blocks their settings UI', () => {
    // The ui-only policy: `managedResources.aiProviders` is true, yet members keep using
    // their own accounts because runtime takeover needs managed + enforced.
    mocks.flow.state = 'success';
    mocks.enabledAiModels = [{ id: 'gpt-5', providerId: 'chatgpt' }];
    mocks.managedResource.managed = true;
    mocks.platformAiTakeover.takeover = false;

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.pendingTakeover')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.success.published')).toBeNull();
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeTruthy();
  });

  it('never claims members are served while the takeover reading is unknown', () => {
    mocks.flow.state = 'success';
    mocks.enabledAiModels = [{ id: 'gpt-5', providerId: 'chatgpt' }];
    mocks.platformAiTakeover = { error: null, loading: true, takeover: false };

    render(<SharedOAuthConnect providerId="chatgpt" />);

    // The alert must pick one string, so it fails closed; the additive hint stays hidden.
    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.pendingTakeover')).toBeTruthy();
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeNull();
  });

  it('never claims a stored credential is serving members while the provider is off', () => {
    mocks.flow.state = 'success';
    // Reconnect after a disconnect: the update path deliberately does not re-enable, so the
    // write succeeds while the provider stays unavailable.
    mocks.aiProviderList = [{ enabled: false, id: 'chatgpt' }];
    mocks.enabledAiModels = [{ id: 'gpt-5', providerId: 'chatgpt' }];

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.providerOff')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.success.published')).toBeNull();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeNull();
  });

  it('warns right after connecting that the account reaches nobody yet', () => {
    // The just-connected screen is exactly where an operator concludes "done".
    mocks.flow.state = 'success';
    mocks.enabledAiModels = [{ id: 'gpt-5', providerId: 'chatgpt' }];

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.enforcementHintLink')).toBeTruthy();
  });

  it('drops the post-connect hint once the platform actually takes over', () => {
    mocks.flow.state = 'success';
    mocks.platformAiTakeover.takeover = true;

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeNull();
  });

  it('offers no disconnect action while nothing is connected', () => {
    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.queryByText('aiProviderSettings.sharedOAuth.disconnect')).toBeNull();
  });

  it('offers disconnect next to reconnect once an account is connected', () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.reconnect')).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.disconnect')).toBeTruthy();
  });

  it('asks for a destructive confirmation naming the provider before disconnecting', () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));
    render(<SharedOAuthConnect providerId="chatgpt" />);

    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.disconnect'));

    const config = lastConfirmConfig();
    expect(config.title).toBe('aiProviderSettings.sharedOAuth.disconnect');
    expect(config.okText).toBe('aiProviderSettings.sharedOAuth.disconnect');
    expect(config.okButtonProps?.danger).toBe(true);
    // The copy must name WHICH account is being withdrawn.
    expect(config.content).toContain('aiProviderSettings.sharedOAuth.disconnectConfirm');
    expect(config.content).toContain('ChatGPT');
    // Confirming is what writes: opening the dialog must not touch the server.
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it('writes and re-reads every affected view only after the operator confirms', async () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));
    render(<SharedOAuthConnect providerId="chatgpt" />);
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.disconnect'));

    await lastConfirmConfig().onOk();

    expect(mocks.disconnect).toHaveBeenCalledWith({
      id: 'chatgpt',
      reason: expect.stringContaining('disconnect'),
    });
    // Reauth is handled exactly like the connect flow: the step-up replays the same call.
    expect(mocks.withAdminReauthRetry).toHaveBeenCalledTimes(1);
    // Disconnect flips `enabled`, so the runtime projection behind the header switch and
    // the provider grid must be re-read — the status SWR alone would leave them lying.
    expect(mocks.refreshAiProviderDetail).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAiProviderList).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAiProviderRuntimeState).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'aiProviderSettings.sharedOAuth.disconnectSuccess',
    );
  });

  it('still re-reads the runtime state when an earlier revalidation rejects', async () => {
    // One rejected refresh used to skip every later one. The runtime-state read is the one
    // that must survive: it drives the header switch and the provider grid, which would
    // otherwise keep showing the provider this write just turned off.
    const mutate = vi.fn().mockRejectedValue(new Error('offline'));
    mocks.swr.mockReturnValue({ ...swrResult(connectedStatus), mutate });
    mocks.refreshAiProviderDetail.mockRejectedValue(new Error('offline'));
    render(<SharedOAuthConnect providerId="chatgpt" />);
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.disconnect'));

    await lastConfirmConfig().onOk();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAiProviderDetail).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAiProviderList).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAiProviderRuntimeState).toHaveBeenCalledTimes(1);
    // A stale view is not a failed disconnect.
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'aiProviderSettings.sharedOAuth.disconnectSuccess',
    );
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });

  it('reports a failed disconnect with its own message and keeps the dialog open', async () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));
    const failure = new Error('nope');
    mocks.disconnect.mockRejectedValue(failure);
    render(<SharedOAuthConnect providerId="chatgpt" />);
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.disconnect'));

    // Rejecting keeps base-ui's confirm open so the operator can retry.
    await expect(lastConfirmConfig().onOk()).rejects.toBe(failure);

    expect(mocks.notifyError).toHaveBeenCalledWith(
      failure,
      'aiProviderSettings.sharedOAuth.disconnectFailed',
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('does nothing when the operator dismisses the confirmation', () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));
    render(<SharedOAuthConnect providerId="chatgpt" />);

    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.disconnect'));

    // Dismissing never invokes onOk — no write, no refresh, no toast.
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.refreshAiProviderRuntimeState).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('warns that a connected account reaches nobody until providers are platform managed', () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));

    render(<SharedOAuthConnect providerId="chatgpt" />);

    // `\b` keeps the hint apart from its sibling `…enforcementHintLink` label.
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.enforcementHintLink')).toBeTruthy();
  });

  it('drops the hint once the platform actually takes over', () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));
    mocks.platformAiTakeover.takeover = true;

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeNull();
  });

  it('shows the hint under a ui-only policy, where members keep their own accounts', () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));
    mocks.managedResource.managed = true;
    mocks.platformAiTakeover.takeover = false;

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeTruthy();
  });

  it('stays silent about enforcement while the platform capability is unknown', () => {
    mocks.swr.mockReturnValue(swrResult(connectedStatus));
    mocks.platformAiTakeover.loading = true;

    render(<SharedOAuthConnect providerId="chatgpt" />);

    // Guessing "not in effect" from an unloaded capability would be worse than no hint.
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.enforcementHint\b/)).toBeNull();
  });

  it('renders the paste form instead of a user code for the authorization-code flow', () => {
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: true,
      deviceCode: 'envelope',
      expiresIn: 600,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
      verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
      verificationUriComplete: null,
    };

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.instruction')).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.openAuthorizePage')).toBeTruthy();
    // No code to type and nothing to wait for: the device-code chrome must not show up.
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.enterCode/)).toBeNull();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.polling')).toBeNull();
  });

  it('submits the pasted callback URL through the flow', () => {
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: false,
      deviceCode: 'envelope',
      expiresIn: 600,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
      verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
      verificationUriComplete: null,
    };

    render(<SharedOAuthConnect providerId="chatgpt" />);

    const input = screen.getByPlaceholderText(
      'aiProviderSettings.sharedOAuth.paste.callbackPlaceholder',
    );
    fireEvent.change(input, {
      target: { value: '  https://platform.openai.com/auth/callback?code=abc&state=s  ' },
    });
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.submit'));

    expect(mocks.flow.submitCallback).toHaveBeenCalledWith(
      'https://platform.openai.com/auth/callback?code=abc&state=s',
    );
    // The pasted-credential route is opt-in per provider; this card did not offer it.
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.sessionToggle')).toBeNull();
  });

  it('offers the web session alone for a provider that connects no other way', () => {
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: true,
      deviceCode: 'envelope',
      expiresIn: 600,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
      verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
      verificationUriComplete: null,
    };

    render(<SharedOAuthConnect providerId="chatgptweb" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionOnlyTitle')).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionOnlyDesc')).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionStep1')).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionStep2')).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionStep3')).toBeTruthy();
    // Step 1 used to name a page with nothing to click; both routes are now one click away.
    expect(
      screen
        .getByText('aiProviderSettings.sharedOAuth.paste.openChatGPT')
        .closest('a')
        ?.getAttribute('href'),
    ).toBe('https://chatgpt.com');
    expect(
      screen
        .getByText('aiProviderSettings.sharedOAuth.paste.openSessionPage')
        .closest('a')
        ?.getAttribute('rel'),
    ).toBe('noopener noreferrer');
    // The 10-day fallback is offered, and never as a peer of the renewable route.
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionQuickTry')).toBeTruthy();
    // The box is the whole form — never behind a disclosure the operator has to find.
    expect(
      screen.getByPlaceholderText('aiProviderSettings.sharedOAuth.paste.sessionPlaceholder'),
    ).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.sessionToggle')).toBeNull();
    // The authorization page signs the operator into a different product and the server
    // refuses the exchange: none of that UI may be on screen.
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.openAuthorizePage')).toBeNull();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.instruction')).toBeNull();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.regenerate')).toBeNull();
    expect(
      screen.queryByPlaceholderText('aiProviderSettings.sharedOAuth.paste.callbackPlaceholder'),
    ).toBeNull();
    expect(screen.queryByText(/auth\.openai\.com/)).toBeNull();
  });

  it('submits the pasted session from the primary action of a web-session-only provider', () => {
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: true,
      deviceCode: 'envelope',
      expiresIn: 600,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
      verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
      verificationUriComplete: null,
    };

    render(<SharedOAuthConnect providerId="chatgptweb" />);

    const submit = screen
      .getByText('aiProviderSettings.sharedOAuth.paste.submit')
      .closest('button')!;
    // Nothing pasted yet: the one action of the form says so instead of failing on submit.
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(
      screen.getByPlaceholderText('aiProviderSettings.sharedOAuth.paste.sessionPlaceholder'),
      { target: { value: `__Secure-next-auth.session-token=${SESSION_JWE}` } },
    );
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.detected.session')).toBeTruthy();

    fireEvent.click(submit);
    expect(mocks.flow.submitSessionToken).toHaveBeenCalledWith(SESSION_JWE);
    expect(mocks.flow.submitCallback).not.toHaveBeenCalled();
  });

  it('warns that a hand-pasted token connection cannot renew itself', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        canRefresh: false,
        connected: true,
        expiresAt: String(Date.UTC(2030, 0, 1)),
        flow: 'authorization_code_paste',
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgptweb" />);

    // The session-only wording: it names the one remedy this provider actually offers, and
    // the generic copy (which also points at the authorization page) stays off screen.
    expect(
      screen.getByText(/aiProviderSettings\.sharedOAuth\.paste\.cannotAutoRenewBeforeSessionOnly/),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        /aiProviderSettings\.sharedOAuth\.paste\.cannotAutoRenewBefore(?!SessionOnly)/,
      ),
    ).toBeNull();
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.expiresAt/)).toBeNull();
  });

  it('offers the renewable path from inside the warning instead of stating a dead end', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        canRefresh: false,
        connected: true,
        expiresAt: null,
        flow: 'authorization_code_paste',
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgpt" />);

    // A provider that still HAS an authorization page keeps the copy that offers it — the
    // session-only variant would name a remedy that is missing one of its two buttons.
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.cannotAutoRenew')).toBeTruthy();
    expect(
      screen.queryByText('aiProviderSettings.sharedOAuth.paste.cannotAutoRenewSessionOnly'),
    ).toBeNull();

    // Both ways out are offered, and both start the same flow — one lands on the web-session
    // box (the cheap fix), the other on the authorization page.
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.pasteSession'));
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.reconnectRenewable'));
    expect(mocks.flow.connect).toHaveBeenCalledTimes(2);
  });

  it('offers only the session fix where the authorization page is not a route at all', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        canRefresh: false,
        connected: true,
        expiresAt: null,
        flow: 'authorization_code_paste',
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgptweb" />);

    // The server refuses a callback exchange for this provider, so pointing at that page
    // would be pointing at a dead end.
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.pasteSession')).toBeTruthy();
    expect(
      screen.queryByText('aiProviderSettings.sharedOAuth.paste.reconnectRenewable'),
    ).toBeNull();
  });

  it('opens the paste panel on the web-session box when the warning sent the operator there', async () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        canRefresh: false,
        connected: true,
        expiresAt: null,
        flow: 'authorization_code_paste',
        secretConfigured: true,
      }),
    );
    // The flow answers the click by moving into the paste step, exactly as the real hook does.
    mocks.flow.connect = vi.fn(async () => {
      mocks.flow.state = 'awaiting';
      mocks.flow.deviceCode = {
        allowAccessTokenPaste: true,
        deviceCode: 'envelope',
        expiresIn: 600,
        flow: 'authorization_code_paste',
        interval: 0,
        userCode: '',
        verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
        verificationUriComplete: null,
      };
      return mocks.flow.deviceCode;
    });

    const { rerender } = render(<SharedOAuthConnect providerId="chatgptweb" />);
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.pasteSession'));
    await Promise.resolve();
    rerender(
      <MemoryRouter>
        <MotionProvider motion={motion}>
          <SharedOAuthConnect providerId="chatgptweb" />
        </MotionProvider>
      </MemoryRouter>,
    );

    // Already expanded: the operator asked for this box, so it must not be behind a toggle.
    expect(
      screen.getByPlaceholderText('aiProviderSettings.sharedOAuth.paste.sessionPlaceholder'),
    ).toBeTruthy();
  });

  it('names the renewal path of a self-renewing connection, and when it last renewed', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        canRefresh: true,
        connected: true,
        expiresAt: String(Date.UTC(2030, 0, 1)),
        flow: 'authorization_code_paste',
        lastRefreshAt: String(Date.UTC(2029, 11, 31)),
        renewalKind: 'web_session',
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgptweb" />);

    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.autoRenewKind/)).toBeTruthy();
    expect(
      screen.getByText(/aiProviderSettings\.sharedOAuth\.renewalKind\.webSession/),
    ).toBeTruthy();
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.currentTokenUntil/)).toBeTruthy();
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.lastRefreshAt/)).toBeTruthy();
    // A rollover date is not a deadline: the bare expiry line would read as a warning.
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.expiresAt/)).toBeNull();
    expect(
      screen.queryByText(/aiProviderSettings\.sharedOAuth\.paste\.cannotAutoRenew/),
    ).toBeNull();
    expect(
      screen.queryByText('aiProviderSettings.sharedOAuth.paste.reconnectRenewable'),
    ).toBeNull();
  });

  it('falls back to the unnamed renewal copy when the stored connection predates the label', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        canRefresh: true,
        connected: true,
        expiresAt: null,
        flow: 'authorization_code_paste',
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgptweb" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.autoRefresh')).toBeTruthy();
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.autoRenewKind/)).toBeNull();
  });

  it('leaves the connected copy of device-code providers untouched', () => {
    // GitHub Copilot-style providers report canRefresh=false by design; the paste flow's
    // renewal warning must not leak into the cards that shipped before it.
    mocks.swr.mockReturnValue(
      swrResult({
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        canRefresh: false,
        connected: true,
        expiresAt: String(Date.UTC(2030, 0, 1)),
        flow: 'device_code',
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.expiresAt/)).toBeTruthy();
    expect(
      screen.queryByText(/aiProviderSettings\.sharedOAuth\.paste\.cannotAutoRenew/),
    ).toBeNull();
  });

  it('still shows the user code and polling hint for a device-code provider', () => {
    // SuperGrok keeps the RFC 8628 chrome: the paste flow must not have replaced it.
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: false,
      deviceCode: 'dc-1',
      expiresIn: 600,
      flow: 'device_code',
      interval: 5,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://x.ai/device',
      verificationUriComplete: 'https://x.ai/device?code=ABCD-EFGH',
    };
    vi.stubGlobal('open', vi.fn());

    render(<SharedOAuthConnect providerId="supergrok" />);

    expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.enterCode/)).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.polling')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.instruction')).toBeNull();

    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.openPage'));
    // The provider's page never gets a handle on the admin window.
    expect(window.open).toHaveBeenCalledWith(
      'https://x.ai/device?code=ABCD-EFGH',
      '_blank',
      'noopener,noreferrer',
    );
    vi.unstubAllGlobals();
  });

  it('associates inline errors and labels with the paste inputs', () => {
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: true,
      deviceCode: 'envelope',
      expiresIn: 600,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
      verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
      verificationUriComplete: null,
    };
    mocks.flow.submitError = 'invalidCallback';

    render(<SharedOAuthConnect providerId="chatgpt" />);

    const field = screen.getByPlaceholderText(
      'aiProviderSettings.sharedOAuth.paste.callbackPlaceholder',
    );
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'aiProviderSettings.sharedOAuth.paste.errors.invalidCallback',
    );
    // Every input is named by a label pointing at its own id.
    const callbackId = field.getAttribute('id')!;
    expect(document.querySelector(`label[for="${callbackId}"]`)?.textContent).toBe(
      'aiProviderSettings.sharedOAuth.paste.callbackLabel',
    );

    const toggle = screen
      .getByText('aiProviderSettings.sharedOAuth.paste.sessionToggle')
      .closest('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const tokenField = screen.getByPlaceholderText(
      'aiProviderSettings.sharedOAuth.paste.sessionPlaceholder',
    );
    const tokenId = tokenField.getAttribute('id')!;
    expect(tokenId).not.toBe(callbackId);
    expect(document.querySelector(`label[for="${tokenId}"]`)?.textContent).toBe(
      'aiProviderSettings.sharedOAuth.paste.sessionLabel',
    );
    // A whole cURL command has to fit and stay readable — masking it would make the paste
    // impossible to check, and the value is a multi-line command, not a single secret field.
    expect(tokenField.tagName).toBe('TEXTAREA');
    // The callback error stays on the callback field only.
    expect(tokenField.getAttribute('aria-invalid')).toBeNull();
  });

  it('names what was pasted before anything is submitted, and submits the renewable half', () => {
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: true,
      deviceCode: 'envelope',
      expiresIn: 600,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
      verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
      verificationUriComplete: null,
    };

    render(<SharedOAuthConnect providerId="chatgpt" />);
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionToggle'));

    const field = screen.getByPlaceholderText(
      'aiProviderSettings.sharedOAuth.paste.sessionPlaceholder',
    );

    // Unrecognised input is named as such, and cannot be submitted.
    fireEvent.change(field, { target: { value: 'not a credential' } });
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.detected.unknown')).toBeTruthy();
    expect(
      screen
        .getByText('aiProviderSettings.sharedOAuth.paste.sessionSubmit')
        .closest('button')!
        .hasAttribute('disabled'),
    ).toBe(true);

    // A cookie string is a WEB SESSION: it renews itself, and that is what gets stored.
    fireEvent.change(field, {
      target: { value: `oai-did=d1; __Secure-next-auth.session-token=${SESSION_JWE}; a=b` },
    });
    expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.detected.session')).toBeTruthy();
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionSubmit'));
    expect(mocks.flow.submitSessionToken).toHaveBeenCalledWith(SESSION_JWE);
    expect(mocks.flow.submitAccessToken).not.toHaveBeenCalled();
  });

  it('warns that a pasted access token cannot renew, and submits it as the token it is', () => {
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: true,
      deviceCode: 'envelope',
      expiresIn: 600,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
      verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
      verificationUriComplete: null,
    };

    render(<SharedOAuthConnect providerId="chatgpt" />);
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionToggle'));
    fireEvent.change(
      screen.getByPlaceholderText('aiProviderSettings.sharedOAuth.paste.sessionPlaceholder'),
      { target: { value: `  ${ACCESS_JWT}  ` } },
    );

    expect(
      screen.getByText('aiProviderSettings.sharedOAuth.paste.detected.accessToken'),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionSubmit'));
    expect(mocks.flow.submitAccessToken).toHaveBeenCalledWith(ACCESS_JWT);
    expect(mocks.flow.submitSessionToken).not.toHaveBeenCalled();
  });

  it('keeps a generic token failure on the token field it was submitted from', () => {
    mocks.flow.state = 'awaiting';
    mocks.flow.deviceCode = {
      allowAccessTokenPaste: true,
      deviceCode: 'envelope',
      expiresIn: 600,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
      verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
      verificationUriComplete: null,
    };
    // A network blip during a token submit maps to the generic `authError`, which carries no
    // field of its own: only the submit SOURCE says where it belongs.
    mocks.flow.submitError = 'authError';
    mocks.flow.submitErrorSource = 'token';

    render(<SharedOAuthConnect providerId="chatgpt" />);
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionToggle'));

    const tokenField = screen.getByPlaceholderText(
      'aiProviderSettings.sharedOAuth.paste.sessionPlaceholder',
    );
    expect(
      screen
        .getByPlaceholderText('aiProviderSettings.sharedOAuth.paste.callbackPlaceholder')
        .getAttribute('aria-invalid'),
    ).toBeNull();
    expect(tokenField.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(tokenField.getAttribute('aria-describedby')!)?.textContent).toBe(
      'aiProviderSettings.sharedOAuth.paste.errors.authError',
    );
  });

  /**
   * Two rejections whose generic copy sends the operator to the authorization page. That page
   * is a dead end for a web-session-only provider, so the copy switches with the layout — and
   * only for that provider: `chatgpt` still has the page and keeps the sentence offering it.
   */
  it.each(['accessTokenInvalid', 'tokenNotWeb'])(
    'points a rejected %s at the page it still has, or at the web session alone',
    (submitError) => {
      mocks.flow.state = 'awaiting';
      mocks.flow.deviceCode = {
        allowAccessTokenPaste: true,
        deviceCode: 'envelope',
        expiresIn: 600,
        flow: 'authorization_code_paste',
        interval: 0,
        userCode: '',
        verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
        verificationUriComplete: null,
      };
      mocks.flow.submitError = submitError;

      const generic = render(<SharedOAuthConnect providerId="chatgpt" />);
      fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.sessionToggle'));
      const genericField = screen.getByPlaceholderText(
        'aiProviderSettings.sharedOAuth.paste.sessionPlaceholder',
      );
      expect(
        document.getElementById(genericField.getAttribute('aria-describedby')!.split(' ')[0])
          ?.textContent,
      ).toBe(`aiProviderSettings.sharedOAuth.paste.errors.${submitError}`);
      generic.unmount();

      render(<SharedOAuthConnect providerId="chatgptweb" />);
      const sessionOnlyField = screen.getByPlaceholderText(
        'aiProviderSettings.sharedOAuth.paste.sessionPlaceholder',
      );
      expect(
        document.getElementById(sessionOnlyField.getAttribute('aria-describedby')!.split(' ')[0])
          ?.textContent,
      ).toBe(`aiProviderSettings.sharedOAuth.paste.errors.${submitError}SessionOnly`);
    },
  );

  /**
   * The desync this state exists for: the vault still holds an unexpired access-token STRING,
   * so the status refresh is a no-op and the card said 已连接 while every member's chat came
   * back "需要重新授权". A third badge is the whole point — collapsing it into 未连接 would lose
   * the difference between "never connected" and "connected, no longer accepted".
   */
  it('warns that a stored shared account was rejected and must be re-authorized', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        ...connectedStatus,
        canRefresh: true,
        flow: 'authorization_code_paste',
        invalidAt: String(Date.UTC(2030, 0, 1)),
        invalidReason: 'runtimeAuth',
        needsReauth: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgptweb" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.needsReauth')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.connected')).toBeNull();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.notConnected')).toBeNull();
    // The account stays on screen: the operator has to know WHICH account to reconnect.
    expect(screen.getByText(/"account":"ops@example.com"/)).toBeTruthy();
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.reauth\.message/)).toBeTruthy();
    expect(
      screen.getByText(/aiProviderSettings\.sharedOAuth\.reauth\.reason\.runtimeAuth/),
    ).toBeTruthy();
    // The remedy is one click, and it is the cheap one for a web-session-only provider.
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.pasteSession'));
    expect(mocks.flow.connect).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText('aiProviderSettings.sharedOAuth.paste.reconnectRenewable'),
    ).toBeNull();
    // ONE primary action: the footer must not repeat the alert's remedy in another shape.
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.reconnect')).toBeNull();
    // Withdrawing must stay possible — the dead credential is still stored.
    expect(screen.getByText('aiProviderSettings.sharedOAuth.disconnect')).toBeTruthy();
  });

  it('sends a device-code provider to its own flow instead of a paste box it does not have', () => {
    // SuperGrok has no pasted-credential route at all; offering "paste a web session" as the
    // remedy would name a box that never appears.
    mocks.swr.mockReturnValue(
      swrResult({ ...connectedStatus, flow: 'device_code', needsReauth: true }),
    );

    render(<SharedOAuthConnect providerId="supergrok" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.needsReauth')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.pasteSession')).toBeNull();
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.reconnect'));
    expect(mocks.flow.connect).toHaveBeenCalledTimes(1);
  });

  it('reads a dead grant reported by the status query itself as the same state', () => {
    // `expired` is this request's own refresh coming back invalid_grant. It used to be
    // returned and read by nobody, which left `connected: false` masquerading as 未连接.
    mocks.swr.mockReturnValue(
      swrResult({
        ...connectedStatus,
        connected: false,
        expired: true,
        flow: 'authorization_code_paste',
        invalidAt: null,
        invalidReason: 'invalidGrant',
      }),
    );

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.needsReauth')).toBeTruthy();
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.disconnectedHint/)).toBeNull();
    // A provider that still HAS an authorization page keeps offering it as the second way out —
    // as the alert's SECONDARY button, not as a third copy of the same remedy in the footer.
    expect(
      screen.getByText('aiProviderSettings.sharedOAuth.paste.reconnectRenewable'),
    ).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.reconnect')).toBeNull();
  });

  it('keeps the healthy badge while nothing has reported a rejection', () => {
    mocks.swr.mockReturnValue(swrResult({ ...connectedStatus, needsReauth: false }));

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.connected')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.needsReauth')).toBeNull();
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.reauth\.message/)).toBeNull();
  });

  /**
   * Cursor: a device-flow SHAPE with no code to type (the browser login is approved on the
   * page itself) and a second route whose pasted credential is a dashboard API key, not an
   * access token. Both are read off the card / the server's answer, never off the id.
   */
  describe('code-less browser login with an API-key route', () => {
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

    beforeEach(() => {
      mocks.flow.state = 'awaiting';
      mocks.flow.deviceCode = cursorDeviceCode;
    });

    it('drops the code block when the provider issues no user code', () => {
      render(<SharedOAuthConnect providerId="cursor" />);

      expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.openLinkToAuthorize/)).toBeTruthy();
      expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.enterCode/)).toBeNull();
      // The polling/expiry chrome is untouched — only the code instructions go.
      expect(screen.getByText('aiProviderSettings.sharedOAuth.polling')).toBeTruthy();
      expect(screen.getByText('aiProviderSettings.sharedOAuth.openPage')).toBeTruthy();
      // The bare verification page approves nothing without the challenge, so the copyable
      // fallback has to be the prefilled URI.
      expect(screen.getByText(cursorDeviceCode.verificationUriComplete)).toBeTruthy();
    });

    it('labels the pasted credential as an API key and submits it trimmed', () => {
      render(<SharedOAuthConnect providerId="cursor" />);

      fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeyToggle'));

      const field = screen.getByPlaceholderText(
        /aiProviderSettings\.sharedOAuth\.paste\.apiKeyPlaceholder/,
      );
      // No access-token wording anywhere on this route.
      expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeyLabel')).toBeTruthy();
      expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.paste\.apiKeyHint/)).toBeTruthy();
      expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.sessionLabel')).toBeNull();

      const submit = screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeySubmit');
      // Empty is not a submit: no shape validation, but no blank redemption either.
      fireEvent.click(submit);
      expect(mocks.flow.submitApiKey).not.toHaveBeenCalled();

      fireEvent.change(field, { target: { value: '  key_live_abc  ' } });
      fireEvent.click(submit);

      expect(mocks.flow.submitApiKey).toHaveBeenCalledWith('key_live_abc');
    });

    it('labels the fallback URL and makes it copyable instead of dumping it as body text', () => {
      render(<SharedOAuthConnect providerId="cursor" />);

      // For a code-less provider this link IS the connect route, so it cannot read as debug
      // output printed under the spinner.
      expect(screen.getByText('aiProviderSettings.sharedOAuth.verificationUrlLabel')).toBeTruthy();
      const link = screen.getByText(cursorDeviceCode.verificationUriComplete);
      expect(link.getAttribute('href')).toBe(cursorDeviceCode.verificationUriComplete);
    });

    it('offers the API-key route from the idle card, before any browser login is started', () => {
      mocks.flow.state = 'idle';
      mocks.flow.deviceCode = undefined;

      render(<SharedOAuthConnect providerId="cursor" />);

      // The durable route used to be reachable only after firing a real device-code request.
      expect(screen.getByText('aiProviderSettings.sharedOAuth.connect')).toBeTruthy();
      expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeyToggle')).toBeTruthy();
      expect(mocks.flow.connect).not.toHaveBeenCalled();
    });

    it('hands the key to the flow instead of deciding envelope liveness from render state', async () => {
      mocks.flow.state = 'idle';
      mocks.flow.deviceCode = undefined;
      mocks.flow.connect = vi.fn().mockResolvedValue(cursorDeviceCode);

      render(<SharedOAuthConnect providerId="cursor" />);

      fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeyToggle'));
      fireEvent.change(
        screen.getByPlaceholderText(/aiProviderSettings\.sharedOAuth\.paste\.apiKeyPlaceholder/),
        { target: { value: ' key_live_idle ' } },
      );
      fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeySubmit'));

      // The envelope belongs to the flow: only it can tell a live one from the render state
      // an expiry already invalidated. No page opened, no user code shown either.
      await vi.waitFor(() => expect(mocks.flow.submitApiKey).toHaveBeenCalledWith('key_live_idle'));
      expect(mocks.flow.connect).not.toHaveBeenCalled();
      expect(mocks.flow.submitAccessToken).not.toHaveBeenCalled();
    });

    it('reports a refused envelope in the flow’s own words, not as a rejected key', async () => {
      mocks.flow.state = 'idle';
      mocks.flow.deviceCode = undefined;
      // The envelope request fails before the key is ever sent: the flow reports the
      // authorization/network failure and `submitError` — the exchange's verdict — stays unset.
      mocks.flow.submitApiKey = vi.fn().mockImplementation(async () => {
        mocks.flow.state = 'error';
        mocks.flow.error = 'authError';
      });

      render(<SharedOAuthConnect providerId="cursor" />);

      fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeyToggle'));
      fireEvent.change(
        screen.getByPlaceholderText(/aiProviderSettings\.sharedOAuth\.paste\.apiKeyPlaceholder/),
        { target: { value: 'key_live_idle' } },
      );
      fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeySubmit'));

      await vi.waitFor(() =>
        expect(screen.getByText('aiProviderSettings.sharedOAuth.error.authError')).toBeTruthy(),
      );
      // "Check the key" about a network failure sends the operator to rewrite a good key.
      expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.apiKeyError')).toBeNull();
      // The box is still there, with what was typed in it: a failure must not rebuild the
      // form and throw away the key the operator just pasted.
      expect(
        (
          screen.getByPlaceholderText(
            /aiProviderSettings\.sharedOAuth\.paste\.apiKeyPlaceholder/,
          ) as HTMLInputElement
        ).value,
      ).toBe('key_live_idle');
    });

    it('offers a way out of a pending exchange and stands the browser login down', () => {
      mocks.flow.state = 'idle';
      mocks.flow.deviceCode = undefined;
      mocks.flow.apiKeyPhase = 'exchangingKey';

      render(<SharedOAuthConnect providerId="cursor" />);

      fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeyToggle'));
      // A hidden round trip against the provider must never be a dead end.
      fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.cancel'));
      expect(mocks.flow.reset).toHaveBeenCalledTimes(1);

      // And nothing else may start a competing run that would retire the same envelope.
      expect(
        screen
          .getByText('aiProviderSettings.sharedOAuth.connect')
          .closest('button')!
          .hasAttribute('disabled'),
      ).toBe(true);
    });

    it('reports a rejected key inside the form that produced it', () => {
      mocks.flow.state = 'idle';
      mocks.flow.deviceCode = undefined;
      mocks.flow.submitError = 'accessTokenInvalid';

      render(<SharedOAuthConnect providerId="cursor" />);

      expect(screen.getByText('aiProviderSettings.sharedOAuth.paste.apiKeyError')).toBeTruthy();
    });

    it('keeps the API-key route off the idle card of a provider that has no such route', () => {
      mocks.flow.state = 'idle';
      mocks.flow.deviceCode = undefined;

      render(<SharedOAuthConnect providerId="supergrok" />);

      expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.apiKeyToggle')).toBeNull();
    });

    it('keeps the API-key route off the providers whose card does not offer one', () => {
      // SuperGrok: RFC 8628 chrome, no paste route at all.
      mocks.flow.deviceCode = {
        allowAccessTokenPaste: false,
        deviceCode: 'dc-1',
        expiresIn: 600,
        flow: 'device_code',
        interval: 5,
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://x.ai/device',
        verificationUriComplete: 'https://x.ai/device?code=ABCD-EFGH',
      };

      render(<SharedOAuthConnect providerId="supergrok" />);

      expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
      expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.apiKeyToggle')).toBeNull();
    });

    it('names the API key as what renews the connection, and warns about nothing', () => {
      mocks.flow.state = 'idle';
      mocks.flow.deviceCode = undefined;
      mocks.swr.mockReturnValue(
        swrResult({
          accountIdMasked: null,
          canRefresh: true,
          connected: true,
          expiresAt: String(Date.UTC(2030, 0, 1)),
          flow: 'device_code',
          renewalKind: 'cursor_api_key',
          secretConfigured: true,
        }),
      );

      render(<SharedOAuthConnect providerId="cursor" />);

      expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.autoRenewKind/)).toBeTruthy();
      expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.renewalKind\.apiKey/)).toBeTruthy();
      // It renews forever: the expiry is the current token's rollover, never a deadline.
      expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.currentTokenUntil/)).toBeTruthy();
      expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.expiresAt/)).toBeNull();
      expect(
        screen.queryByText(/aiProviderSettings\.sharedOAuth\.paste\.cannotAutoRenew/),
      ).toBeNull();
    });
  });

  it('ignores persisted models that belong to a different provider', () => {
    mocks.flow.state = 'success';
    mocks.enabledAiModels = [{ id: 'claude-x', providerId: 'anthropic' }];

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeTruthy();
  });
});
