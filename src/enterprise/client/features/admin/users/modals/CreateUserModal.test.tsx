/**
 * Two-phase create-user modal tests (form → one-time credentials panel).
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CREATE_USER_AUTO_REASON, CreateUserModalContent } from './CreateUserModal';
import { PASSWORD_CHARSET, PASSWORD_LENGTH } from './generatePassword';

const mockClose = vi.fn();
const toastSuccess = vi.fn();

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
    CopyButton: ({ content, title }: any) =>
      React.createElement('button', {
        'aria-label': title,
        'data-copy': content,
        'type': 'button',
      }),
    Input: ({ value, onChange, disabled, 'aria-label': aria, status }: any) =>
      React.createElement('input', {
        'aria-label': aria,
        'data-status': status ?? '',
        disabled,
        onChange,
        value,
      }),
    InputPassword: ({ value, onChange, disabled, 'aria-label': aria }: any) =>
      React.createElement('input', {
        'aria-label': aria,
        disabled,
        onChange,
        value,
      }),
    Text: ({ children, ...rest }: any) => React.createElement('span', rest, children),
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
    createModal: vi.fn(),
    toast: { success: (...args: unknown[]) => toastSuccess(...args) },
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

const fillValidForm = (password = 'Sup3r-secret!') => {
  fireEvent.change(screen.getByLabelText('users.modals.create.emailLabel'), {
    target: { value: '  New.User@Example.com ' },
  });
  fireEvent.change(screen.getByLabelText('users.modals.create.fullNameLabel'), {
    target: { value: ' New User ' },
  });
  fireEvent.change(screen.getByLabelText('users.modals.create.passwordLabel'), {
    target: { value: password },
  });
};

const confirmButton = () =>
  screen.getByText('users.modals.create.confirm').closest('button') as HTMLButtonElement;

describe('CreateUserModalContent', () => {
  beforeEach(() => {
    mockClose.mockReset();
    toastSuccess.mockReset();
    document.body.innerHTML = '';
  });

  it('Generate fills the password field with a policy-valid password', () => {
    render(<CreateUserModalContent onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByText('users.modals.create.generate'));

    const password = (
      screen.getByLabelText('users.modals.create.passwordLabel') as HTMLInputElement
    ).value;
    expect(password).toHaveLength(PASSWORD_LENGTH);
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(password.length).toBeLessThanOrEqual(64);
    const allowed = new Set(PASSWORD_CHARSET);
    for (const char of password) expect(allowed.has(char)).toBe(true);
  });

  it('submit stays disabled until the form is valid', () => {
    render(<CreateUserModalContent onSubmit={vi.fn()} />);
    expect(confirmButton().disabled).toBe(true);

    fillValidForm();
    expect(confirmButton().disabled).toBe(false);

    // Too-short password disables submit again.
    fireEvent.change(screen.getByLabelText('users.modals.create.passwordLabel'), {
      target: { value: 'short' },
    });
    expect(confirmButton().disabled).toBe(true);
  });

  it('successful submit calls the service with normalized input and shows the one-time panel', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ created: true, email: 'new.user@example.com', userId: 'user_abc' });
    render(<CreateUserModalContent onSubmit={onSubmit} />);

    fillValidForm('Sup3r-secret!');
    fireEvent.change(screen.getByLabelText('users.modals.create.usernameLabel'), {
      target: { value: 'new.user' },
    });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByText('users.modals.create.successTitle')).toBeTruthy());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      email: 'new.user@example.com',
      fullName: 'New User',
      password: 'Sup3r-secret!',
      reason: CREATE_USER_AUTO_REASON,
      username: 'new.user',
    });

    // One-time credentials panel: warning + email + password with copy buttons.
    expect(screen.getByRole('alert').textContent).toBe('users.modals.create.successWarning');
    expect(screen.getByTestId('created-user-password').textContent).toBe('Sup3r-secret!');
    expect(screen.getByText('new.user@example.com')).toBeTruthy();
    expect(toastSuccess).toHaveBeenCalledWith('users.toast.createSuccess');
    expect(mockClose).not.toHaveBeenCalled();

    // Done clears the panel and closes the modal.
    fireEvent.click(screen.getByText('users.modals.create.done'));
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('rejects emails the server-side zod schema rejects (client mirror)', () => {
    render(<CreateUserModalContent onSubmit={vi.fn()} />);
    fillValidForm();

    const emailInput = () =>
      screen.getByLabelText('users.modals.create.emailLabel') as HTMLInputElement;

    // Divergent inputs the old loose pattern accepted but zod .email() rejects.
    for (const bad of ['john..doe@corp.com', 'user@x.c', '用户@corp.com', '.lead@corp.com']) {
      fireEvent.change(emailInput(), { target: { value: bad } });
      expect(screen.queryByText('users.modals.create.emailInvalid')).toBeTruthy();
      expect(confirmButton().disabled).toBe(true);
    }

    fireEvent.change(emailInput(), { target: { value: "o'brien+dev@corp-1.example.com" } });
    expect(screen.queryByText('users.modals.create.emailInvalid')).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });

  it('Escape is swallowed during mutating and success, but not while idle', async () => {
    // Simulates base-ui's dismiss: a bubble-phase document keydown listener.
    const dismissSpy = vi.fn();
    document.addEventListener('keydown', dismissSpy);

    let resolveSubmit!: (v: unknown) => void;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    try {
      render(<CreateUserModalContent onSubmit={onSubmit} />);

      // idle: Escape must reach the dismiss listener (modal stays closable).
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(dismissSpy).toHaveBeenCalledTimes(1);

      fillValidForm('Sup3r-secret!');
      fireEvent.click(confirmButton());
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      // mutating: Escape blocked at capture phase; form stays mounted.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(dismissSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText('users.modals.create.emailLabel')).toBeTruthy();

      // Mutation resolves — the one-time panel must still render.
      resolveSubmit({ created: true, email: 'new.user@example.com', userId: 'user_abc' });
      await waitFor(() =>
        expect(screen.getByText('users.modals.create.successTitle')).toBeTruthy(),
      );

      // success: Escape blocked; credentials panel stays.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(dismissSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('created-user-password').textContent).toBe('Sup3r-secret!');
      expect(mockClose).not.toHaveBeenCalled();

      // Done still closes.
      fireEvent.click(screen.getByText('users.modals.create.done'));
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', dismissSpy);
    }
  });

  it('Done keeps the credentials panel rendered through the exit animation (no form flash)', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ created: true, email: 'new.user@example.com', userId: 'user_abc' });
    render(<CreateUserModalContent onSubmit={onSubmit} />);

    fillValidForm('Sup3r-secret!');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('users.modals.create.successTitle')).toBeTruthy());

    fireEvent.click(screen.getByText('users.modals.create.done'));
    expect(mockClose).toHaveBeenCalledTimes(1);
    // Content stays mounted during base-ui's exit animation: the panel must not be
    // replaced by the empty create form.
    expect(screen.getByText('users.modals.create.successTitle')).toBeTruthy();
    expect(screen.getByTestId('created-user-password').textContent).toBe('Sup3r-secret!');
    expect(screen.queryByLabelText('users.modals.create.emailLabel')).toBeNull();
  });

  it('maps the server email-taken signal to the dedicated error message', async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      Object.assign(new Error('PLATFORM_INVALID_INPUT'), {
        data: {
          errorData: { code: 'PLATFORM_INVALID_INPUT', details: { reason: 'email_taken' } },
        },
      }),
    );
    render(<CreateUserModalContent onSubmit={onSubmit} />);

    fillValidForm();
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('users.errors.emailTaken');
    });
    // Back on the form with input preserved for correction.
    expect(
      (screen.getByLabelText('users.modals.create.emailLabel') as HTMLInputElement).value,
    ).toContain('New.User@Example.com');
    expect(confirmButton().disabled).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('maps the password-auth-disabled signal to its dedicated error message', async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      Object.assign(new Error('PLATFORM_INVALID_INPUT'), {
        data: {
          errorData: {
            code: 'PLATFORM_INVALID_INPUT',
            details: { reason: 'password_auth_disabled' },
          },
        },
      }),
    );
    render(<CreateUserModalContent onSubmit={onSubmit} />);

    fillValidForm();
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('users.errors.passwordAuthDisabled');
    });
  });

  it('maps a bare tRPC BAD_REQUEST (server zod rejection) to the invalid-input message', async () => {
    // Shape of a TRPCClientError for a zod input failure: data.code, no errorData body.
    const onSubmit = vi.fn().mockRejectedValue(
      Object.assign(new Error('[\n  {\n    "validation": "email"\n  }\n]'), {
        data: { code: 'BAD_REQUEST', httpStatus: 400 },
      }),
    );
    render(<CreateUserModalContent onSubmit={onSubmit} />);

    fillValidForm();
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('users.errors.invalidInput');
    });
  });
});
