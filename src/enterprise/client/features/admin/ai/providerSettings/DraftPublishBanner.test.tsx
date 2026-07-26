// @vitest-environment happy-dom
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearLastAdminPublishOutcome,
  recordPublishOutcome,
} from '@/enterprise/client/services/adminAiInfraAdapter/shared';

import DraftPublishBanner from './DraftPublishBanner';

const mocks = vi.hoisted(() => ({
  activeAiProvider: 'openai' as string | undefined,
  publishNow: vi.fn(),
  refreshAiProviderDetail: vi.fn(),
  refreshAiProviderList: vi.fn(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({
    action,
    description,
    message,
    type,
  }: {
    action?: ReactNode;
    description?: ReactNode;
    message?: ReactNode;
    type?: string;
  }) => (
    <div data-testid={`draft-banner-${type}`}>
      <span data-testid="draft-banner-message">{message}</span>
      <div data-testid="draft-banner-description">{description}</div>
      {action}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    loading?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  toast: { error: vi.fn() },
}));

vi.mock('@/store/aiInfra', () => ({
  useScopedAiInfraStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeAiProvider: mocks.activeAiProvider,
      refreshAiProviderDetail: mocks.refreshAiProviderDetail,
      refreshAiProviderList: mocks.refreshAiProviderList,
    }),
}));

vi.mock('@/enterprise/client/services/adminAiInfraAdapter', async () => {
  const shared = await import('@/enterprise/client/services/adminAiInfraAdapter/shared');
  return {
    adminAiProviderService: { publishNow: mocks.publishNow },
    clearLastAdminPublishOutcome: shared.clearLastAdminPublishOutcome,
    useAdminPublishOutcome: shared.useAdminPublishOutcome,
  };
});

describe('DraftPublishBanner (AI-02)', () => {
  beforeEach(() => {
    clearLastAdminPublishOutcome();
    mocks.activeAiProvider = 'openai';
    mocks.publishNow.mockReset();
    mocks.refreshAiProviderDetail.mockReset();
    mocks.refreshAiProviderList.mockReset();
  });

  it('renders the real banner after a soft publish failure recorded post-mount', async () => {
    const { container } = render(<DraftPublishBanner />);
    // Closed: AdminDraftPublishBanner returns null when open=false.
    expect(container.querySelector('[data-testid="draft-banner-warning"]')).toBeNull();

    act(() => {
      recordPublishOutcome('openai', {
        published: false,
        publishError: 'validation_failed',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('draft-banner-warning')).toBeTruthy();
    });
    // useAdminDraftBannerCopy supplies defaultValue for title/retry; assert visible copy.
    expect(screen.getByTestId('draft-banner-message')).toHaveTextContent(
      'Changes saved as draft — not live yet',
    );
    expect(screen.getByText('aiSettings.draftBanner.error.validation_failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry publish' })).toBeTruthy();
  });

  it('keeps the active Provider failure when another Provider records a later outcome', async () => {
    render(<DraftPublishBanner />);

    act(() => {
      recordPublishOutcome('openai', {
        published: false,
        publishError: 'validation_failed',
      });
      recordPublishOutcome('anthropic', {
        published: true,
        publishError: null,
      });
    });

    await waitFor(() => expect(screen.getByTestId('draft-banner-warning')).toBeTruthy());
    expect(screen.getByText('aiSettings.draftBanner.error.validation_failed')).toBeTruthy();
  });
});
