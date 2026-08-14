import { MotionProvider } from '@lobehub/ui';
import { render as rtlRender, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SharedOAuthConnect from './SharedOAuthConnect';

const mocks = vi.hoisted(() => ({
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
  useAdminSharedOAuthFlow: () => ({
    connect: vi.fn(),
    deviceCode: undefined,
    error: undefined,
    outcome: undefined,
    reset: vi.fn(),
    state: 'idle',
  }),
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
});

describe('SharedOAuthConnect', () => {
  it('explains the disconnected state and offers a connect action', () => {
    mocks.swr.mockReturnValue(
      swrResult({
        accountIdMasked: null,
        connected: false,
        expiresAt: null,
        secretConfigured: false,
      }),
    );

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
});
