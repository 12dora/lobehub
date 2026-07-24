// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformSidebarLayout } from '@/types/platform/sidebarLayout';

import SidebarLayoutControl, { reloadSidebarLayoutAfterConflict } from './SidebarLayoutControl';

const mocks = vi.hoisted(() => ({
  data: {
    layout: null,
    mode: 'user',
    revision: 1,
  } as PlatformSidebarLayout,
  error: undefined as Error | undefined,
  isLoading: false,
  mutate: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
  update: vi.fn(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  Icon: () => null,
  Text: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, loading, type: _type, ...props }: any) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
  Select: ({ disabled, onChange, options, value }: any) => (
    <select
      aria-label="sidebar-layout-mode"
      disabled={disabled}
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {(options ?? []).map((option: { label: string; value: string }) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  toast: mocks.toast,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/enterprise/client/services/adminSidebarLayout', () => ({
  adminSidebarLayoutService: {
    update: mocks.update,
  },
}));

vi.mock('./hooks/useAdminSidebarLayout', () => ({
  useFetchAdminSidebarLayout: () => ({
    data: mocks.data,
    error: mocks.error,
    isLoading: mocks.isLoading,
    mutate: mocks.mutate,
  }),
}));

vi.mock('@/routes/(main)/home/_layout/Body/CustomizeSidebarModal', () => ({
  openCustomizeSidebarModal: vi.fn(),
}));

describe('reloadSidebarLayoutAfterConflict', () => {
  it('does not swallow a failed revalidation — returns refreshFailed', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('swr refresh failed'));
    const result = await reloadSidebarLayoutAfterConflict({ mutate });
    expect(result).toEqual({ refreshFailed: true });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('returns refreshFailed false when revalidation succeeds', async () => {
    const mutate = vi.fn().mockResolvedValue({ revision: 2 });
    await expect(reloadSidebarLayoutAfterConflict({ mutate })).resolves.toEqual({
      refreshFailed: false,
    });
  });
});

describe('SidebarLayoutControl CAS conflict', () => {
  beforeEach(() => {
    mocks.data = { layout: null, mode: 'user', revision: 1 };
    mocks.error = undefined;
    mocks.isLoading = false;
    mocks.mutate.mockReset();
    mocks.update.mockReset();
    mocks.toast.error.mockReset();
    mocks.toast.success.mockReset();
  });

  it('surfaces a stale concurrent save as conflict, reloads the latest revision, then saves with the fresh revision', async () => {
    // Simulate two concurrent saves: this client still holds expectedRevision=1 while
    // another admin already advanced the singleton to revision 2.
    const latest: PlatformSidebarLayout = {
      layout: { hiddenSidebarSections: [], sidebarItems: ['home'] },
      mode: 'platform',
      revision: 2,
    };
    mocks.update
      .mockRejectedValueOnce(new Error('PLATFORM_REVISION_CONFLICT'))
      .mockResolvedValueOnce({
        layout: null,
        mode: 'platform',
        revision: 3,
      } satisfies PlatformSidebarLayout);
    mocks.mutate.mockImplementation(async (next?: PlatformSidebarLayout) => {
      if (next) {
        mocks.data = next;
        return next;
      }
      mocks.data = latest;
      return latest;
    });

    render(<SidebarLayoutControl canUpdate />);

    // First save races with a stale revision → CAS conflict (no silent overwrite).
    fireEvent.change(screen.getByLabelText('sidebar-layout-mode'), {
      target: { value: 'platform' },
    });

    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledTimes(1);
    });
    expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 1,
      mode: 'platform',
    });
    await waitFor(() => {
      expect(mocks.toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/changed elsewhere|Reloading the latest/i),
      );
    });
    // Store reloads the authoritative revision after the conflict.
    expect(mocks.mutate).toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.data.revision).toBe(2);
    });
    // Must not enter silent stale / reload-needed when revalidation succeeds.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();

    // Subsequent save uses the fresh revision and succeeds.
    fireEvent.change(screen.getByLabelText('sidebar-layout-mode'), {
      target: { value: 'user' },
    });
    // Mode select still shows platform (latest) — flip back toward user via re-select:
    // data.mode is platform after reload; changing to user is a real transition.
    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledTimes(2);
    });
    expect(mocks.update.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 2,
      mode: 'user',
    });
    await waitFor(() => {
      expect(mocks.toast.success).toHaveBeenCalledWith('sidebarLayout.saved');
    });
    expect(mocks.data.revision).toBe(3);
  });

  it('surfaces a failed post-conflict revalidation as reload-needed (not a silent stale view)', async () => {
    mocks.update.mockRejectedValueOnce(new Error('PLATFORM_REVISION_CONFLICT'));
    mocks.mutate.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async () => {
      mocks.data = { layout: null, mode: 'platform', revision: 2 };
      return mocks.data;
    });

    render(<SidebarLayoutControl canUpdate />);

    fireEvent.change(screen.getByLabelText('sidebar-layout-mode'), {
      target: { value: 'platform' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Reload to continue|latest sidebar/i,
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
    // Controls stay locked — no silent overwrite path with the stale revision.
    expect(screen.queryByLabelText('sidebar-layout-mode')).toBeNull();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/Could not load the latest|Reload to continue/i),
    );

    // Manual reload recovers; a subsequent save is allowed with the fresh revision.
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(screen.getByLabelText('sidebar-layout-mode')).toBeEnabled();
    });
    expect(mocks.data.revision).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();

    mocks.update.mockResolvedValueOnce({
      layout: null,
      mode: 'user',
      revision: 3,
    } satisfies PlatformSidebarLayout);
    fireEvent.change(screen.getByLabelText('sidebar-layout-mode'), {
      target: { value: 'user' },
    });
    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledTimes(2);
    });
    expect(mocks.update.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 2, mode: 'user' });
  });

  it('blocks persist while reload-needed is active', async () => {
    mocks.update.mockRejectedValueOnce(new Error('PLATFORM_REVISION_CONFLICT'));
    mocks.mutate.mockRejectedValue(new Error('offline'));

    render(<SidebarLayoutControl canUpdate />);
    fireEvent.change(screen.getByLabelText('sidebar-layout-mode'), {
      target: { value: 'platform' },
    });
    await screen.findByRole('button', { name: 'Reload' });

    // Even if something tried to re-fire a mode change, update must not be called again.
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('sidebar-layout-mode')).toBeNull();
  });
});
