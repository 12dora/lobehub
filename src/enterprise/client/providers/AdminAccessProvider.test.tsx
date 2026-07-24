import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AdminAccessProvider, { useAdminAccess } from './AdminAccessProvider';

const fetchAccess = vi.fn();

const Probe = () => {
  const { status, permissions, retryable, refresh } = useAdminAccess();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="perms">{permissions.join(',')}</span>
      <span data-testid="retryable">{String(retryable)}</span>
      <button type="button" onClick={() => void refresh()}>
        retry
      </button>
    </div>
  );
};

describe('AdminAccessProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts loading then allows when hasAdminAccess is true', async () => {
    fetchAccess.mockResolvedValueOnce({
      hasAdminAccess: true,
      permissions: ['platform_admin:access:all', 'platform_user:read:all'],
      roles: [{ displayName: 'Admin', name: 'super_admin' }],
    });

    render(
      <AdminAccessProvider fetchAccess={fetchAccess}>
        <Probe />
      </AdminAccessProvider>,
    );

    expect(screen.getByTestId('status').textContent).toBe('loading');

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('allowed');
    });
    expect(screen.getByTestId('perms').textContent).toContain('platform_user:read:all');
    expect(fetchAccess).toHaveBeenCalledTimes(1);
  });

  it('forbidden when authenticated but hasAdminAccess is false — no retry pretend', async () => {
    fetchAccess.mockResolvedValueOnce({
      hasAdminAccess: false,
      permissions: [],
      roles: [],
    });

    render(
      <AdminAccessProvider fetchAccess={fetchAccess}>
        <Probe />
      </AdminAccessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('forbidden');
    });
    expect(screen.getByTestId('perms').textContent).toBe('');
  });

  it('error with retryable=false for UNAUTHORIZED', async () => {
    fetchAccess.mockRejectedValueOnce({ data: { code: 'UNAUTHORIZED' }, message: 'UNAUTHORIZED' });

    render(
      <AdminAccessProvider fetchAccess={fetchAccess}>
        <Probe />
      </AdminAccessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('error');
    });
    expect(screen.getByTestId('retryable').textContent).toBe('false');
  });

  it('error with retryable=true for network failures and supports refresh', async () => {
    fetchAccess.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({
      hasAdminAccess: true,
      permissions: ['platform_admin:access:all'],
      roles: [],
    });

    render(
      <AdminAccessProvider fetchAccess={fetchAccess}>
        <Probe />
      </AdminAccessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('error');
    });
    expect(screen.getByTestId('retryable').textContent).toBe('true');

    await act(async () => {
      screen.getByRole('button', { name: 'retry' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('allowed');
    });
    expect(fetchAccess).toHaveBeenCalledTimes(2);
  });

  it('disabled provider never fetches and ends forbidden', async () => {
    render(
      <AdminAccessProvider enabled={false} fetchAccess={fetchAccess}>
        <Probe />
      </AdminAccessProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('forbidden');
    });
    expect(fetchAccess).not.toHaveBeenCalled();
  });

  it('ignores out-of-order access responses (stale allowed does not clobber later forbidden)', async () => {
    type Snapshot = {
      hasAdminAccess: boolean;
      permissions: string[];
      roles: never[];
    };
    let resolveFirst!: (value: Snapshot) => void;
    const first = new Promise<Snapshot>((resolve) => {
      resolveFirst = resolve;
    });
    fetchAccess
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({
        hasAdminAccess: false,
        permissions: [],
        roles: [],
      });

    render(
      <AdminAccessProvider fetchAccess={fetchAccess}>
        <Probe />
      </AdminAccessProvider>,
    );

    await act(async () => {
      screen.getByRole('button', { name: 'retry' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('forbidden');
    });

    await act(async () => {
      resolveFirst({
        hasAdminAccess: true,
        permissions: ['platform_admin:access:all'],
        roles: [],
      });
    });

    // Stale first response must not restore allowed after a later forbidden result.
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('forbidden');
    });
    expect(screen.getByTestId('perms').textContent).toBe('');
  });
});
