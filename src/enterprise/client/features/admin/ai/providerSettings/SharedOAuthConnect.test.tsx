import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SharedOAuthConnect from './SharedOAuthConnect';

const mocks = vi.hoisted(() => ({
  aiProviderModelList: [] as { enabled: boolean; id: string }[],
  enabledAiModels: [] as { id: string; providerId: string }[],
  flow: {
    connect: vi.fn(),
    deviceCode: undefined as unknown,
    error: undefined as unknown,
    reset: vi.fn(),
    state: 'idle' as string,
  },
  flowOptions: { value: undefined as Record<string, unknown> | undefined },
  swr: vi.fn(),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (...args: unknown[]) => mocks.swr(...args),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: { aiProviderOAuth: { getConnectionStatus: { query: vi.fn() } } },
  },
}));

vi.mock('@/store/aiInfra', () => ({
  useAiInfraStoreApi: () => ({ getState: () => ({}) }),
  useScopedAiInfraStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
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
  rtlRender(<MotionProvider motion={motion}>{ui}</MotionProvider>);

const swrResult = (data: unknown) => ({
  data,
  error: undefined,
  isLoading: false,
  mutate: vi.fn(),
});

beforeEach(() => {
  mocks.swr.mockReset();
  mocks.aiProviderModelList = [];
  mocks.enabledAiModels = [];
  mocks.flow.connect = vi.fn();
  mocks.flow.deviceCode = undefined;
  mocks.flow.error = undefined;
  mocks.flow.reset = vi.fn();
  mocks.flow.state = 'idle';
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

  it('confirms the provider is live once a persisted model row is enabled', () => {
    mocks.flow.state = 'success';
    mocks.enabledAiModels = [{ id: 'gpt-5', providerId: 'chatgpt' }];

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.published')).toBeTruthy();
    expect(screen.queryByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeNull();
  });

  it('ignores persisted models that belong to a different provider', () => {
    mocks.flow.state = 'success';
    mocks.enabledAiModels = [{ id: 'claude-x', providerId: 'anthropic' }];

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeTruthy();
  });
});
