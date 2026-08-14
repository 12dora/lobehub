import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SharedOAuthConnect from './SharedOAuthConnect';

const mocks = vi.hoisted(() => ({
  flow: {
    connect: vi.fn(),
    deviceCode: undefined as unknown,
    error: undefined as unknown,
    outcome: undefined as unknown,
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
  mocks.flow.connect = vi.fn();
  mocks.flow.deviceCode = undefined;
  mocks.flow.error = undefined;
  mocks.flow.outcome = undefined;
  mocks.flow.reset = vi.fn();
  mocks.flow.state = 'idle';
  mocks.flowOptions.value = undefined;
  mocks.swr.mockReturnValue(
    swrResult({
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

  it('shows the masked account and expiry once connected', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountIdMasked: 'acc1…',
        connected: true,
        expiresAt: String(Date.UTC(2030, 0, 1)),
        secretConfigured: true,
      }),
    );

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.connected')).toBeTruthy();
    expect(screen.getByText(/"account":"acc1…"/)).toBeTruthy();
    expect(screen.getByText(/aiProviderSettings\.sharedOAuth\.expiresAt/)).toBeTruthy();
    expect(screen.getByText('aiProviderSettings.sharedOAuth.reconnect')).toBeTruthy();
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

  it('tells the operator to add models when the publish only waits on models', () => {
    mocks.flow.state = 'success';
    mocks.flow.outcome = { publishError: 'model_required', published: false, revision: 3 };

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeTruthy();
  });

  it('points at the draft banner with the stable code when publishing failed otherwise', () => {
    mocks.flow.state = 'success';
    mocks.flow.outcome = { publishError: 'connection_test_failed', published: false, revision: 3 };

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.queryByText('aiProviderSettings.sharedOAuth.success.needsModels')).toBeNull();
    expect(
      screen.getByText(
        'aiProviderSettings.sharedOAuth.success.publishFailed:{"code":"connection_test_failed"}',
      ),
    ).toBeTruthy();
  });

  it('confirms the provider is live when the publish landed', () => {
    mocks.flow.state = 'success';
    mocks.flow.outcome = { publishError: null, published: true, revision: 4 };

    render(<SharedOAuthConnect providerId="chatgpt" />);

    expect(screen.getByText('aiProviderSettings.sharedOAuth.success.published')).toBeTruthy();
  });
});
