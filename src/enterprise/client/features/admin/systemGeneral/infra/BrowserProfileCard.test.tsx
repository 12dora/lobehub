// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AdminBrowserProfileSummary } from '@/enterprise/client/services/adminSystem';

import { BrowserProfileCard } from './BrowserProfileCard';

const mocks = vi.hoisted(() => ({
  confirm: undefined as undefined | { content: string; onOk: () => Promise<void>; title: string },
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) => (
    <div>
      {message}
      {action}
    </div>
  ),
  CopyButton: ({ content }: { content: string }) => (
    <button data-copy={content} type="button">
      copy
    </button>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Skeleton: () => <div>profile-loading</div>,
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <span title={String(title)}>{children}</span>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal: (options: typeof mocks.confirm) => {
    mocks.confirm = options;
  },
  toast: { error: mocks.error, success: mocks.success },
}));

vi.mock('../styles', () => ({
  infraSettingsStyles: new Proxy({}, { get: () => '' }),
}));

vi.mock('../InfraSettingsCard', () => ({
  InfraSettingsCard: ({
    banner,
    editor,
    extraActions,
    fields,
    notice,
    status,
    title,
  }: {
    banner?: ReactNode;
    editor?: ReactNode;
    extraActions?: ReactNode;
    fields?: Array<{ label: string; value: ReactNode }>;
    notice?: ReactNode;
    status?: string;
    title: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <span data-testid="status">{status}</span>
      {banner}
      {editor}
      {fields?.map((field) => (
        <div key={field.label}>
          <span>{field.label}</span>
          <span>{field.value}</span>
        </div>
      ))}
      {extraActions}
      <p>{notice}</p>
    </section>
  ),
}));

const summary = (): AdminBrowserProfileSummary => ({
  arch: 'arm',
  chromeVersion: '150.0.7871.95',
  cores: 12,
  createdAt: new Date('2026-08-18T00:00:00.000Z'),
  impersonateProfile: 'chrome150',
  installationId: '123e4567-e89b-42d3-a456-426614174000',
  locale: 'en-US',
  memoryGiB: 36,
  platform: 'macOS',
  platformVersion: '15.6.1',
  revision: 3,
  screen: { dpr: 2, height: 982, width: 1512 },
  timezone: 'America/New_York',
  updatedAt: new Date('2026-08-18T01:00:00.000Z'),
});

describe('BrowserProfileCard', () => {
  it('shows the safe summary without exposing a seed', () => {
    const { container } = render(
      <BrowserProfileCard
        canOperate={false}
        data={summary()}
        error={undefined}
        isLoading={false}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    // The installation id identifies the deployment to upstream — it is not a secret, and an
    // 8-char mask could neither be read out in a support thread nor copied.
    expect(screen.getByText('123e4567-e89b-42d3-a456-426614174000')).toBeTruthy();
    expect(
      container.querySelector('[data-copy="123e4567-e89b-42d3-a456-426614174000"]'),
    ).toBeTruthy();
    // The curl-impersonate target name is jargon that repeats the same major version: hover only.
    expect(screen.getByText('150.0.7871.95')).toBeTruthy();
    expect(screen.queryByText('150.0.7871.95 · chrome150')).toBeNull();
    expect(container.querySelector('span[title]')?.getAttribute('title')).toContain('chrome150');
    expect(screen.getByText('macOS 15.6.1 · arm')).toBeTruthy();
    expect(screen.getByText('en-US · America/New_York')).toBeTruthy();
    expect(screen.getByText('#3')).toBeTruthy();
    expect(container.textContent).not.toContain('seed');
    expect(screen.queryByText('browserProfile.actions.regenerate')).toBeNull();
  });

  it('names the Windows release instead of printing its UA client-hint version', () => {
    render(
      <BrowserProfileCard
        canOperate={false}
        data={{ ...summary(), arch: 'x86', platform: 'Windows', platformVersion: '15.0.0' }}
        error={undefined}
        isLoading={false}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    // `Sec-CH-UA-Platform-Version` 13+ is Windows 11; "Windows 15.0.0" is not a release.
    expect(screen.getByText('Windows 11 · x86')).toBeTruthy();
  });

  it('reports the same configured / not-configured tag as the neighbouring infra cards', () => {
    const { rerender } = render(
      <BrowserProfileCard
        canOperate={false}
        data={summary()}
        error={undefined}
        isLoading={false}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId('status').textContent).toBe('unknown');

    rerender(
      <BrowserProfileCard
        canOperate={false}
        error={undefined}
        isLoading={false}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId('status').textContent).toBe('disabled');
  });

  it('confirms the new-device impact, regenerates, and reports success', async () => {
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    render(
      <BrowserProfileCard
        canOperate
        data={summary()}
        error={undefined}
        isLoading={false}
        onRegenerate={onRegenerate}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'browserProfile.actions.regenerate' }));
    expect(mocks.confirm).toMatchObject({
      // The shared cancel label rather than a private copy of the same word.
      cancelText: 'cancel:{"ns":"common"}',
      content: 'browserProfile.confirm.description',
      okText: 'browserProfile.actions.regenerate',
      title: 'browserProfile.confirm.title',
    });

    await mocks.confirm!.onOk();
    expect(onRegenerate).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith('browserProfile.toast.regenerated');
  });

  it('keeps the error visible and offers a retry', () => {
    const onRetry = vi.fn();
    render(
      <BrowserProfileCard
        canOperate
        error={new Error('offline')}
        isLoading={false}
        onRegenerate={vi.fn()}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('browserProfile.states.error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'browserProfile.actions.retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows an independent loading state', () => {
    render(
      <BrowserProfileCard
        isLoading
        canOperate={false}
        error={undefined}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('profile-loading')).toBeTruthy();
    expect(screen.queryByText('browserProfile.states.empty')).toBeNull();
  });

  it('explains an empty result instead of leaving a blank card', () => {
    render(
      <BrowserProfileCard
        canOperate={false}
        error={undefined}
        isLoading={false}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('browserProfile.states.empty')).toBeTruthy();
  });

  it('offers to GENERATE, not refresh, while nothing has been generated', () => {
    render(
      <BrowserProfileCard
        canOperate
        error={undefined}
        isLoading={false}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'browserProfile.actions.generate' })).toBeTruthy();
    expect(screen.queryByText('browserProfile.actions.regenerate')).toBeNull();
  });

  it('withholds the destructive action until the card knows what it would replace', () => {
    const { rerender } = render(
      <BrowserProfileCard
        canOperate
        isLoading
        error={undefined}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'browserProfile.actions.generate' })
        .hasAttribute('disabled'),
    ).toBe(true);

    rerender(
      <BrowserProfileCard
        canOperate
        data={summary()}
        error={new Error('offline')}
        isLoading={false}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'browserProfile.actions.regenerate' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});
