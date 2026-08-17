// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';

import ArtifactUploadButton from './ArtifactUploadButton';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  toast: { error: vi.fn(), success: vi.fn() },
}));

// antd Upload only picks the file; expose the picker as a plain button in tests.
vi.mock('antd', () => {
  const Upload = ({
    beforeUpload,
    children,
  }: {
    beforeUpload: (file: unknown) => unknown;
    children?: ReactNode;
  }) => (
    <div>
      <button
        data-testid="pick"
        type="button"
        onClick={() => beforeUpload((globalThis as { __pickedFile?: unknown }).__pickedFile)}
      >
        pick
      </button>
      {children}
    </div>
  );
  Upload.LIST_IGNORE = 'LIST_IGNORE';
  return { Upload };
});

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: [], status: 'allowed' }),
}));

const pick = (size: number) => {
  (globalThis as { __pickedFile?: unknown }).__pickedFile = { name: 'mihomo.gz', size };
};

const service = (overrides: Partial<AdminNetworkProxyService> = {}) =>
  ({ uploadArtifact: vi.fn(), ...overrides }) as unknown as AdminNetworkProxyService;

describe('ArtifactUploadButton', () => {
  it('rejects an oversized file before spending the upload', async () => {
    const uploadArtifact = vi.fn();
    pick(NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES + 1);

    render(
      <ArtifactUploadButton
        kind="engine"
        service={service({ uploadArtifact })}
        onInstalled={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick'));
    });

    expect(uploadArtifact).not.toHaveBeenCalled();
    expect(screen.getByText('networkProxy.engine.uploadTooLarge')).toBeTruthy();
  });

  it('offers a cancel control while the transfer is running and aborts it', async () => {
    let capturedSignal: AbortSignal | undefined;
    const uploadArtifact = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          capturedSignal = input.signal;
          input.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('ADMIN_UPLOAD_ABORTED'), { data: {} })),
          );
        }),
    );
    pick(1024);

    render(
      <ArtifactUploadButton
        kind="engine"
        service={service({ uploadArtifact } as unknown as Partial<AdminNetworkProxyService>)}
        onInstalled={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick'));
    });

    const cancel = screen.getByRole('button', { name: 'networkProxy.actions.cancel' });
    await act(async () => {
      fireEvent.click(cancel);
    });

    expect(capturedSignal?.aborted).toBe(true);
    // A cancel the admin asked for is not an error to shout about.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the verified digest and refreshes artifact status on success', async () => {
    const onInstalled = vi.fn();
    const uploadArtifact = vi.fn(async () => ({
      ok: true as const,
      sha256: '8ad44e28fe72be46',
      version: 'v1.19.30',
    }));
    pick(1024);

    render(
      <ArtifactUploadButton
        kind="geoip"
        service={service({ uploadArtifact })}
        onInstalled={onInstalled}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick'));
    });

    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(screen.getByText('networkProxy.engine.uploadVerified')).toBeTruthy();
  });
});
