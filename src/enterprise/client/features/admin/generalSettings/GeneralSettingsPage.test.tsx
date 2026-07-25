// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import GeneralSettingsPage from './GeneralSettingsPage';

const mocks = vi.hoisted(() => ({
  blocker: { proceed: vi.fn(), reset: vi.fn(), state: 'unblocked' as string },
  createModal: vi.fn((_options: { onOpenChange?: (open: boolean) => void }) => ({
    close: vi.fn(),
    destroy: vi.fn(),
  })),
  data: {
    emailDomainAllowlist: [] as string[],
    emailDomainAllowlistEnabled: false,
    openRegistration: true,
    revision: 0,
  } as {
    emailDomainAllowlist: string[];
    emailDomainAllowlistEnabled: boolean;
    openRegistration: boolean;
    revision: number;
  },
  mutate: vi.fn(),
  permissions: [] as string[],
  update: vi.fn(),
  useBlocker: vi.fn((when: boolean | ((args: unknown) => boolean)) => {
    const enabled = typeof when === 'function' ? true : Boolean(when);
    return enabled && mocks.blocker.state === 'blocked'
      ? mocks.blocker
      : { proceed: vi.fn(), reset: vi.fn(), state: 'unblocked' };
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({
    description,
    extra,
    message,
  }: {
    description?: ReactNode;
    extra?: ReactNode;
    message?: ReactNode;
  }) => (
    <div role="alert">
      <div>{message}</div>
      {description ? <div>{description}</div> : null}
      {extra}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, ...props }: any) => <span {...props}>{children}</span>,
  TextArea: (props: any) => <textarea {...props} />,
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, loading, type: _type, ...props }: any) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
  Switch: ({ checked, disabled, onChange }: any) => (
    <input
      aria-label="switch"
      checked={checked}
      disabled={disabled}
      type="checkbox"
      onChange={(event) => onChange?.(event.target.checked)}
    />
  ),
  createModal: mocks.createModal,
  ModalFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  toast: toastMocks,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', () => ({
  useBlocker: mocks.useBlocker,
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ permissions: mocks.permissions }),
}));

vi.mock('@/enterprise/client/services/adminAuthSettings', () => ({
  adminAuthSettingsService: {
    update: mocks.update,
  },
}));

vi.mock('./useAdminAuthSettings', () => ({
  useFetchAdminAuthSettings: () => ({
    data: mocks.data,
    error: undefined,
    isLoading: false,
    mutate: mocks.mutate,
  }),
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ children, description, title }: any) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </main>
  ),
}));

vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: () => <div>loading</div>,
}));

const evalBlocker = (
  current: { pathname: string; search: string },
  next: { pathname: string; search: string },
) => {
  const shouldBlock = mocks.useBlocker.mock.calls.at(-1)?.[0];
  if (typeof shouldBlock !== 'function') throw new TypeError('expected a blocker predicate');
  return shouldBlock({ currentLocation: current, nextLocation: next });
};

describe('GeneralSettingsPage unsaved guard', () => {
  beforeEach(() => {
    mocks.permissions = [PLATFORM_PERMISSIONS.IDENTITY_READ, PLATFORM_PERMISSIONS.IDENTITY_UPDATE];
    mocks.data = {
      emailDomainAllowlist: [],
      emailDomainAllowlistEnabled: false,
      openRegistration: true,
      revision: 0,
    };
    mocks.blocker.state = 'unblocked';
    mocks.blocker.proceed.mockReset();
    mocks.blocker.reset.mockReset();
    mocks.createModal.mockClear();
    mocks.useBlocker.mockClear();
    mocks.update.mockReset();
    mocks.mutate.mockReset();
  });

  it('blocks cross-path navigation when dirty', async () => {
    render(<GeneralSettingsPage />);
    const switches = await screen.findAllByLabelText('switch');
    fireEvent.click(switches[0]!); // toggle openRegistration

    await waitFor(() => {
      expect(
        evalBlocker(
          { pathname: '/admin/security', search: '?tab=general' },
          { pathname: '/admin/users', search: '' },
        ),
      ).toBe(true);
    });
  });

  it('blocks embedded tab search-param switches when dirty', async () => {
    render(<GeneralSettingsPage embedded />);
    const switches = await screen.findAllByLabelText('switch');
    fireEvent.click(switches[0]!);

    await waitFor(() => {
      expect(
        evalBlocker(
          { pathname: '/admin/security', search: '?tab=general' },
          { pathname: '/admin/security', search: '?tab=login' },
        ),
      ).toBe(true);
    });
  });

  it('does not block same-path search changes when not embedded', async () => {
    render(<GeneralSettingsPage />);
    const switches = await screen.findAllByLabelText('switch');
    fireEvent.click(switches[0]!);

    await waitFor(() => {
      expect(
        evalBlocker(
          { pathname: '/admin/general', search: '' },
          { pathname: '/admin/general', search: '?x=1' },
        ),
      ).toBe(false);
    });
  });

  it('registers beforeunload while dirty', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    render(<GeneralSettingsPage />);
    const switches = await screen.findAllByLabelText('switch');
    fireEvent.click(switches[0]!);

    await waitFor(() => {
      expect(
        addSpy.mock.calls.some((call) => call[0] === ('beforeunload' as (typeof call)[0])),
      ).toBe(true);
    });
    addSpy.mockRestore();
  });

  it('prompts via createModal when the router reports a blocked navigation', async () => {
    mocks.blocker.state = 'blocked';
    render(<GeneralSettingsPage embedded />);
    const switches = await screen.findAllByLabelText('switch');
    fireEvent.click(switches[0]!);

    await waitFor(() => expect(mocks.createModal).toHaveBeenCalled());
    // Passive dismiss (Escape / close) resolves cancel via onOpenChange(false).
    act(() => mocks.createModal.mock.calls[0]![0].onOpenChange?.(false));
    expect(mocks.blocker.reset).toHaveBeenCalled();
  });
});

describe('GeneralSettingsPage CAS conflict recovery', () => {
  beforeEach(() => {
    mocks.permissions = [PLATFORM_PERMISSIONS.IDENTITY_READ, PLATFORM_PERMISSIONS.IDENTITY_UPDATE];
    mocks.data = {
      emailDomainAllowlist: [],
      emailDomainAllowlistEnabled: false,
      openRegistration: true,
      revision: 4,
    };
    mocks.blocker.state = 'unblocked';
    mocks.update.mockReset();
    mocks.mutate.mockReset();
    toastMocks.error.mockClear();
    toastMocks.success.mockClear();
  });

  it('keeps edits and conflict state when discard refresh fails (ASI-001)', async () => {
    mocks.update.mockRejectedValueOnce({
      data: { errorData: { code: 'PLATFORM_REVISION_CONFLICT' } },
      message: 'revision conflict',
    });
    // Auto-refresh after conflict fails, then discard-and-refresh also fails.
    mocks.mutate.mockRejectedValue(new Error('network down'));

    render(<GeneralSettingsPage />);
    const switches = await screen.findAllByLabelText('switch');
    // Toggle openRegistration off (dirty edit).
    fireEvent.click(switches[0]!);

    fireEvent.click(await screen.findByRole('button', { name: 'generalSettings.save' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('generalSettings.conflict.title');
    });

    // Local edit must still be reflected (openRegistration now false → first switch unchecked).
    expect((switches[0] as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'generalSettings.stale.refresh' }));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith('generalSettings.stale.refreshFailed');
    });

    // Conflict alert remains; save stays disabled; edits retained.
    expect(screen.getByRole('alert')).toHaveTextContent('generalSettings.conflict.title');
    expect(screen.getByRole('button', { name: 'generalSettings.save' })).toBeDisabled();
    expect((switches[0] as HTMLInputElement).checked).toBe(false);
  });
});
