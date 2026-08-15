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
    connect: vi.fn(),
    deviceCode: undefined as unknown,
    error: undefined as unknown,
    reset: vi.fn(),
    state: 'idle' as string,
    submitAccessToken: vi.fn(),
    submitCallback: vi.fn(),
    submitError: undefined as unknown,
    submitErrorSource: undefined as unknown,
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
  mocks.flow.connect = vi.fn();
  mocks.flow.deviceCode = undefined;
  mocks.flow.error = undefined;
  mocks.flow.reset = vi.fn();
  mocks.flow.state = 'idle';
  mocks.flow.submitAccessToken = vi.fn();
  mocks.flow.submitCallback = vi.fn();
  mocks.flow.submitError = undefined;
  mocks.flow.submitErrorSource = undefined;
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

    render(<SharedOAuthConnect providerId="chatgptweb" />);

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

    render(<SharedOAuthConnect providerId="chatgptweb" />);

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
    // The token fallback is opt-in per provider; this card did not offer it.
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.paste.accessTokenToggle')).toBeNull();
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

    expect(
      screen.getByText(/aiProviderSettings\.sharedOAuth\.paste\.cannotAutoRenewBefore/),
    ).toBeTruthy();
    expect(screen.queryByText(/aiProviderSettings\.sharedOAuth\.expiresAt/)).toBeNull();
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

    render(<SharedOAuthConnect providerId="chatgptweb" />);

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
      .getByText('aiProviderSettings.sharedOAuth.paste.accessTokenToggle')
      .closest('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const tokenField = screen.getByPlaceholderText(
      'aiProviderSettings.sharedOAuth.paste.accessTokenPlaceholder',
    );
    const tokenId = tokenField.getAttribute('id')!;
    expect(tokenId).not.toBe(callbackId);
    expect(document.querySelector(`label[for="${tokenId}"]`)?.textContent).toBe(
      'aiProviderSettings.sharedOAuth.paste.accessTokenLabel',
    );
    // A pasted token is a credential: it must never be readable on screen by default.
    expect(tokenField.getAttribute('type')).toBe('password');
    // The callback error stays on the callback field only.
    expect(tokenField.getAttribute('aria-invalid')).toBeNull();
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

    render(<SharedOAuthConnect providerId="chatgptweb" />);
    fireEvent.click(screen.getByText('aiProviderSettings.sharedOAuth.paste.accessTokenToggle'));

    const tokenField = screen.getByPlaceholderText(
      'aiProviderSettings.sharedOAuth.paste.accessTokenPlaceholder',
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

  it('ignores persisted models that belong to a different provider', () => {
    mocks.flow.state = 'success';
    mocks.enabledAiModels = [{ id: 'claude-x', providerId: 'anthropic' }];

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeTruthy();
  });
});
