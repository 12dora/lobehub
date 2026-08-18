/**
 * Change-password modal: the body says the target once, and the generator fills both
 * fields so the admin never transcribes a 16-character string.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PASSWORD_CHARSET, PASSWORD_LENGTH } from '../generatePassword';
import { SetPasswordModalContent } from './SetPasswordModal';

const mockClose = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Alert: ({ message }: any) => React.createElement('div', { role: 'status' }, message),
    InputPassword: ({ value, onChange, disabled, 'aria-label': aria }: any) =>
      React.createElement('input', { 'aria-label': aria, disabled, onChange, value }),
    Text: ({ children, as: As, ...rest }: any) => React.createElement(As || 'span', rest, children),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Button: ({ children, onClick, disabled, loading, ...rest }: any) =>
      React.createElement(
        'button',
        { type: 'button', onClick, disabled: disabled || loading, ...rest },
        children,
      ),
    Checkbox: ({ checked, onChange, disabled }: any) =>
      React.createElement('input', {
        checked: Boolean(checked),
        disabled,
        onChange: (e: any) => onChange?.(e.target.checked),
        type: 'checkbox',
      }),
    createModal: vi.fn(),
    toast: { success: vi.fn() },
    useModalContext: () => ({ close: mockClose }),
  };
});

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAdminReauthRetry: async (fn: () => Promise<unknown>) => fn(),
  };
});

const renderModal = (onSubmit = vi.fn().mockResolvedValue(undefined)) =>
  render(<SetPasswordModalContent targetLabel="Bob" userId="u-bob" onSubmit={onSubmit} />);

const newPasswordInput = () =>
  screen.getByLabelText('users.security.password.newLabel') as HTMLInputElement;
const confirmInput = () =>
  screen.getByLabelText('users.security.password.confirmLabel') as HTMLInputElement;
const submitButton = () =>
  screen.getByText('users.security.password.submit').closest('button') as HTMLButtonElement;

describe('SetPasswordModalContent', () => {
  beforeEach(() => {
    mockClose.mockReset();
    document.body.innerHTML = '';
  });

  it('names the target once — the heading — with no separate target line', () => {
    renderModal();

    expect(screen.getByRole('heading', { name: 'users.security.password.title' })).toBeTruthy();
    expect(screen.queryByText('users.modals.target')).toBeNull();
  });

  it('generates a policy-valid password into both fields', () => {
    renderModal();

    fireEvent.click(screen.getByText('users.modals.create.generate'));

    const generated = newPasswordInput().value;
    expect(generated).toHaveLength(PASSWORD_LENGTH);
    // Retyping it would be transcription, not verification — confirm is filled too.
    expect(confirmInput().value).toBe(generated);
    const allowed = new Set(PASSWORD_CHARSET);
    for (const char of generated) expect(allowed.has(char)).toBe(true);
  });

  it('enables submit as soon as a password is generated', () => {
    renderModal();
    expect(submitButton().disabled).toBe(true);

    fireEvent.click(screen.getByText('users.modals.create.generate'));

    expect(submitButton().disabled).toBe(false);
  });

  it('keeps submit disabled while the two fields differ', () => {
    renderModal();

    fireEvent.change(newPasswordInput(), { target: { value: 'Sup3r-secret!' } });
    fireEvent.change(confirmInput(), { target: { value: 'Sup3r-secret?' } });
    expect(submitButton().disabled).toBe(true);

    fireEvent.change(confirmInput(), { target: { value: 'Sup3r-secret!' } });
    expect(submitButton().disabled).toBe(false);
  });

  it('submits the generated password with the session revoke default', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderModal(onSubmit);

    fireEvent.click(screen.getByText('users.modals.create.generate'));
    const generated = newPasswordInput().value;
    fireEvent.click(submitButton());

    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        newPassword: generated,
        revokeSessions: true,
        userId: 'u-bob',
      }),
    );
  });
});
