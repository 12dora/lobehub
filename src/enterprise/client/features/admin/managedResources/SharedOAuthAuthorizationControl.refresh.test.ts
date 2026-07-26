// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SharedOAuthAuthorizationControl, {
  commitSharedOAuthThenRefresh,
} from './SharedOAuthAuthorizationControl';

const mocks = vi.hoisted(() => ({
  confirmModal: vi.fn(),
  mutate: vi.fn(),
  setSharedAuthorization: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ extra, message }: { extra?: ReactNode; message?: ReactNode }) =>
    createElement('div', { role: 'alert' }, message, extra),
  Flexbox: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  Icon: () => createElement('span'),
  Tag: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
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
  }) => createElement('button', { disabled, onClick, type: 'button' }, children),
  confirmModal: mocks.confirmModal,
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: {
    setSharedAuthorization: mocks.setSharedAuthorization,
  },
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: () => ({
    data: { doc: { sharedAuthorization: { ownerUserId: null } }, revision: 2 },
    error: undefined,
    isLoading: false,
    mutate: mocks.mutate,
  }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutate.mockResolvedValue({ revision: 3 });
  mocks.setSharedAuthorization.mockResolvedValue(undefined);
});

describe('shared OAuth post-commit refresh boundary', () => {
  it('resolves as committed when refresh rejects', async () => {
    const setSharedAuthorization = vi.fn().mockResolvedValue(undefined);
    const mutate = vi.fn().mockRejectedValue(new Error('swr refresh failed'));

    const result = await commitSharedOAuthThenRefresh({ mutate, setSharedAuthorization });

    expect(setSharedAuthorization).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ committed: true, refreshFailed: true });
  });

  it('does not mark refreshFailed when mutate succeeds', async () => {
    const setSharedAuthorization = vi.fn().mockResolvedValue(undefined);
    const mutate = vi.fn().mockResolvedValue({ revision: 2 });

    const result = await commitSharedOAuthThenRefresh({ mutate, setSharedAuthorization });

    expect(result).toEqual({ committed: true, refreshFailed: false });
  });

  it('propagates mutation failures before refresh is attempted', async () => {
    const setSharedAuthorization = vi.fn().mockRejectedValue(new Error('write failed'));
    const mutate = vi.fn();

    await expect(commitSharedOAuthThenRefresh({ mutate, setSharedAuthorization })).rejects.toThrow(
      'write failed',
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('SharedOAuthAuthorizationControl feedback', () => {
  const submitConfirmation = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'managedResources.sharedOAuth.enable' }));
    const options = mocks.confirmModal.mock.calls.at(-1)?.[0] as { onOk: () => Promise<void> };
    await act(() => options.onOk());
  };

  it('surfaces a failed mutation without attempting refresh', async () => {
    mocks.setSharedAuthorization.mockRejectedValueOnce(new Error('write failed'));
    render(createElement(SharedOAuthAuthorizationControl, { canRead: true, canUpdate: true }));

    await submitConfirmation();

    expect(mocks.toastError).toHaveBeenCalledWith('managedResources.sharedOAuth.mutationFailed');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('shows a persistent warning and refresh-only retry after the mutation commits', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('refresh failed')).mockResolvedValueOnce({
      revision: 3,
    });
    render(createElement(SharedOAuthAuthorizationControl, { canRead: true, canUpdate: true }));

    await submitConfirmation();

    expect(mocks.setSharedAuthorization).toHaveBeenCalledOnce();
    expect(screen.getByText('managedResources.sharedOAuth.savedRefreshFailed')).toBeInTheDocument();
    const stalePrimaryAction = screen.getByRole('button', {
      name: 'managedResources.sharedOAuth.enable',
    });
    expect(stalePrimaryAction).toBeDisabled();
    fireEvent.click(stalePrimaryAction);
    expect(mocks.confirmModal).toHaveBeenCalledOnce();
    expect(mocks.setSharedAuthorization).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'managedResources.sharedOAuth.refreshRetry' }),
      );
    });
    await vi.waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
    expect(mocks.setSharedAuthorization).toHaveBeenCalledOnce();
    expect(
      screen.queryByText('managedResources.sharedOAuth.savedRefreshFailed'),
    ).not.toBeInTheDocument();
  });
});
