// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import FieldStatus from './FieldStatus';
import type { NetworkProxyActions, NetworkProxyEntry } from './useNetworkProxyActions';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

const setup = (
  entry: NetworkProxyEntry | undefined,
  props: Partial<{
    pendingLabel: string;
    successLabel: string;
  }> = {},
) => {
  const dismiss = vi.fn();
  const retry = vi.fn();
  const actions = { dismiss, entryOf: () => entry, retry } as unknown as NetworkProxyActions;
  const utils = render(<FieldStatus actions={actions} field="restart" {...props} />);
  return { ...utils, dismiss, retry };
};

describe('FieldStatus', () => {
  it('renders nothing when the field has no outcome yet', () => {
    const { container } = setup(undefined);
    expect(container.textContent).toBe('');
  });

  it("shows the server's own reason in preference to the generic key", () => {
    setup({
      errorKey: 'networkProxy.errors.localFailed',
      errorText: 'spawn failed: exit 1',
      status: 'error',
    });
    expect(screen.getByText('spawn failed: exit 1')).toBeTruthy();
    expect(screen.queryByText('networkProxy.errors.localFailed')).toBeNull();
  });

  it('falls back to the translated key when the failure carries no message', () => {
    setup({ errorKey: 'networkProxy.errors.localFailed', status: 'error' });
    expect(screen.getByText('networkProxy.errors.localFailed')).toBeTruthy();
  });

  it('offers Retry and Discard, and calls them for this field', () => {
    const { dismiss, retry } = setup({
      errorKey: 'networkProxy.errors.generic',
      retry: vi.fn(),
      status: 'error',
    });
    fireEvent.click(screen.getByText('networkProxy.actions.retry'));
    fireEvent.click(screen.getByText('networkProxy.actions.dismiss'));
    expect(retry).toHaveBeenCalledWith('restart');
    expect(dismiss).toHaveBeenCalledWith('restart');
  });

  it('uses conflict copy and marks the message as a warning, not a hard failure', () => {
    setup({ errorKey: 'networkProxy.conflict.field', retry: vi.fn(), status: 'conflict' });
    expect(screen.getByText('networkProxy.conflict.field')).toBeTruthy();
    expect(screen.getByText('networkProxy.conflict.dismiss')).toBeTruthy();
  });

  it('hides a Retry the runner could not build', () => {
    setup({ errorKey: 'networkProxy.errors.generic', status: 'error' });
    expect(screen.queryByText('networkProxy.actions.retry')).toBeNull();
  });

  it('only announces pending / success when the caller supplies copy for them', () => {
    const { unmount } = setup({ status: 'pending' });
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();

    setup({ status: 'success' }, { successLabel: 'done' });
    expect(screen.getByText('done')).toBeTruthy();
  });
});
