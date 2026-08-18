// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileSummary,
} from '@/enterprise/client/services/adminSystem';

import { BrowserProfileCard, type BrowserProfileCardProps } from './BrowserProfileCard';

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
  Icon: () => <span />,
  Skeleton: () => <div>profile-loading</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  // A real <select> so the test can see what is offered and pick from it.
  Select: ({
    disabled,
    id,
    onChange,
    options: entries,
    value,
  }: {
    disabled?: boolean;
    id?: string;
    onChange?: (next: string) => void;
    options?: Array<{ label: string; value: string }>;
    value?: string;
  }) => (
    <select
      disabled={disabled}
      id={id}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {(entries ?? []).map((entry) => (
        <option key={entry.value} value={entry.value}>
          {entry.label}
        </option>
      ))}
    </select>
  ),
  Switch: () => <span />,
  toast: { error: mocks.error, success: mocks.success },
}));

vi.mock('../styles', () => ({
  infraSettingsStyles: new Proxy({}, { get: () => '' }),
}));

vi.mock('./styles', () => ({
  infraFormStyles: new Proxy({}, { get: () => '' }),
}));

vi.mock('../InfraSettingsCard', () => ({
  InfraFieldRows: ({ fields }: { fields: Array<{ label: string; value: ReactNode }> }) => (
    <div>
      {fields.map((field) => (
        <div key={field.label}>
          <span>{field.label}</span>
          <span>{field.value}</span>
        </div>
      ))}
    </div>
  ),
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

const MAC = 'system-macos-15-arm';
const WINDOWS = 'system-windows-11';

const onMac = {
  chromeId: 'chrome-150',
  computeId: 'compute-mac-arm-12-24',
  localeId: 'locale-en-us-new-york',
  screenId: 'screen-mac-1512-982-2',
  systemId: MAC,
  webglId: 'webgl-apple-m3',
};

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
  ...onMac,
  timezone: 'America/New_York',
  updatedAt: new Date('2026-08-18T01:00:00.000Z'),
});

const options = (): AdminBrowserProfileOptions => ({
  chrome: [
    {
      fullVersion: '150.0.7871.95',
      id: 'chrome-150',
      impersonateProfile: 'chrome150',
      label: 'Chrome 150',
      major: 150,
    },
    {
      fullVersion: '146.0.7680.74',
      id: 'chrome-146',
      impersonateProfile: 'chrome146',
      label: 'Chrome 146',
      major: 146,
    },
  ],
  compute: [
    {
      arch: 'arm',
      cores: 12,
      id: 'compute-mac-arm-12-24',
      label: '12 cores · 24 GiB',
      memoryGiB: 24,
      platform: 'macOS',
    },
    {
      arch: 'x86',
      cores: 16,
      id: 'compute-win-16-32',
      label: '16 cores · 32 GiB',
      memoryGiB: 32,
      platform: 'Windows',
    },
  ],
  locales: [
    {
      acceptLanguage: 'en-US,en;q=0.9',
      id: 'locale-en-us-new-york',
      label: 'en-US · America/New_York',
      timezone: 'America/New_York',
    },
    {
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      id: 'locale-zh-cn-shanghai',
      label: 'zh-CN · Asia/Shanghai',
      timezone: 'Asia/Shanghai',
    },
  ],
  screens: [
    {
      dpr: 2,
      height: 982,
      id: 'screen-mac-1512-982-2',
      label: '1512 × 982 @ 2×',
      platform: 'macOS',
      width: 1512,
    },
    {
      dpr: 1,
      height: 1080,
      id: 'screen-win-1920-1080-1',
      label: '1920 × 1080 @ 1×',
      platform: 'Windows',
      width: 1920,
    },
  ],
  systems: [
    {
      arch: 'arm',
      id: MAC,
      label: 'macOS 15 · Apple Silicon',
      navigatorPlatform: 'MacIntel',
      platform: 'macOS',
      platformVersion: '15.6.1',
    },
    {
      arch: 'x86',
      id: WINDOWS,
      label: 'Windows 11',
      navigatorPlatform: 'Win32',
      platform: 'Windows',
      platformVersion: '15.0.0',
    },
  ],
  webgl: [
    {
      arch: 'arm',
      id: 'webgl-apple-m3',
      label: 'Apple M3',
      platform: 'macOS',
      renderer: 'ANGLE (Apple, Apple M3, OpenGL 4.1)',
      vendor: 'Apple Inc.',
    },
    {
      arch: 'x86',
      id: 'webgl-nvidia-3060',
      label: 'NVIDIA GeForce RTX 3060',
      platform: 'Windows',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
      vendor: 'Google Inc. (NVIDIA)',
    },
  ],
});

const labelsOf = (element: HTMLElement) =>
  [...element.querySelectorAll('option')].map((option) => option.textContent);

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
        onSave={vi.fn()}
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
    // The CAS counter is not a version of the fingerprint and never was operator-facing.
    expect(screen.queryByText('#3')).toBeNull();
    expect(container.textContent).not.toContain('seed');
    expect(screen.queryByText('browserProfile.actions.regenerate')).toBeNull();
  });

  it('names the graphics adapter through the option it was chosen from', () => {
    render(
      <BrowserProfileCard
        canOperate={false}
        data={summary()}
        error={undefined}
        isLoading={false}
        options={options()}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText('browserProfile.fields.webgl')).toBeTruthy();
    expect(screen.getByText('Apple M3')).toBeTruthy();
  });

  it('leaves the fingerprint read-only, and unsavable, without operate permission', () => {
    const { container } = render(
      <BrowserProfileCard
        canOperate={false}
        data={summary()}
        error={undefined}
        isLoading={false}
        options={options()}
        onRegenerate={vi.fn()}
        onRetry={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(container.querySelector('select')).toBeNull();
    expect(screen.queryByText('browserProfile.actions.save')).toBeNull();
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
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
        onSave={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'browserProfile.actions.regenerate' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('BrowserProfileCard as an editable choice', () => {
  const editable = (props: Partial<BrowserProfileCardProps> = {}) => (
    <BrowserProfileCard
      canOperate
      data={summary()}
      error={undefined}
      isLoading={false}
      options={options()}
      onRegenerate={vi.fn()}
      onRetry={vi.fn()}
      onSave={vi.fn()}
      {...props}
    />
  );

  it('opens on what the platform is running', () => {
    render(editable());

    expect((screen.getByLabelText('browserProfile.fields.chrome') as HTMLSelectElement).value).toBe(
      'chrome-150',
    );
    expect(
      (screen.getByLabelText('browserProfile.fields.platform') as HTMLSelectElement).value,
    ).toBe(MAC);
    expect((screen.getByLabelText('browserProfile.fields.webgl') as HTMLSelectElement).value).toBe(
      'webgl-apple-m3',
    );
    // Nothing has been changed yet, so there is nothing to save.
    expect(
      screen.getByRole('button', { name: 'browserProfile.actions.save' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByText('browserProfile.states.dirty')).toBeNull();
  });

  it('only offers hardware the chosen machine can have, and repairs what a change invalidates', () => {
    render(editable());

    // The Apple GPU and the Apple-silicon memory size are gone the moment the machine is a PC —
    // the server would reject that combination, and upstream would read it as a tell.
    fireEvent.change(screen.getByLabelText('browserProfile.fields.platform'), {
      target: { value: WINDOWS },
    });

    expect(labelsOf(screen.getByLabelText('browserProfile.fields.webgl'))).toEqual([
      'NVIDIA GeForce RTX 3060',
    ]);
    expect(labelsOf(screen.getByLabelText('browserProfile.fields.compute'))).toEqual([
      '16 cores · 32 GiB',
    ]);
    expect(labelsOf(screen.getByLabelText('browserProfile.fields.screen'))).toEqual([
      '1920 × 1080 @ 1×',
    ]);
    expect((screen.getByLabelText('browserProfile.fields.webgl') as HTMLSelectElement).value).toBe(
      'webgl-nvidia-3060',
    );
    expect(
      (screen.getByLabelText('browserProfile.fields.compute') as HTMLSelectElement).value,
    ).toBe('compute-win-16-32');
    expect(screen.getByText('browserProfile.states.dirty')).toBeTruthy();
  });

  it('saves the chosen ids and says so', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(editable({ onSave }));

    fireEvent.change(screen.getByLabelText('browserProfile.fields.chrome'), {
      target: { value: 'chrome-146' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'browserProfile.actions.save' }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());

    expect(onSave).toHaveBeenCalledWith({ ...onMac, chromeId: 'chrome-146' });
    expect(mocks.success).toHaveBeenCalledWith('browserProfile.toast.saved');
  });

  it('keeps the choice on screen when the save is refused', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('conflict'));
    render(editable({ onSave }));

    fireEvent.change(screen.getByLabelText('browserProfile.fields.chrome'), {
      target: { value: 'chrome-146' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'browserProfile.actions.save' }));
    await vi.waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('browserProfile.toast.saveFailed'),
    );

    expect((screen.getByLabelText('browserProfile.fields.chrome') as HTMLSelectElement).value).toBe(
      'chrome-146',
    );
  });

  it('still regenerates in one confirmed step, with no save in between', async () => {
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    render(editable({ onRegenerate }));

    fireEvent.click(screen.getByRole('button', { name: 'browserProfile.actions.regenerate' }));
    expect(mocks.confirm).toMatchObject({
      content: 'browserProfile.confirm.description',
      title: 'browserProfile.confirm.title',
    });

    await mocks.confirm!.onOk();
    expect(onRegenerate).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith('browserProfile.toast.regenerated');
  });

  it('falls back to the read-only summary until the pools arrive', () => {
    const { container } = render(editable({ options: undefined }));

    expect(container.querySelector('select')).toBeNull();
    expect(screen.queryByText('browserProfile.actions.save')).toBeNull();
    // Regenerating never depended on the pools.
    expect(screen.getByRole('button', { name: 'browserProfile.actions.regenerate' })).toBeTruthy();
  });
});
