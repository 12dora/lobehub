import { cleanup, render, screen } from '@testing-library/react';
import type { ChangeEvent, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangePasswordContent } from './ChangePasswordModal';
import { securityStyles } from './styles';

vi.mock('@lobehub/ui', () => ({
  Text: ({ as: As = 'span', children }: { as?: 'h2' | 'span'; children: ReactNode }) => (
    <As>{children}</As>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  Checkbox: ({ children }: { children: ReactNode }) => <label>{children}</label>,
  createModal: vi.fn(),
  InputPassword: (props: Record<string, unknown>) => <input type="password" {...props} />,
  toast: { error: vi.fn(), success: vi.fn() },
  useModalContext: () => ({ close: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/libs/better-auth/auth-client', () => ({
  changePassword: vi.fn(),
  requestPasswordReset: vi.fn(),
}));

vi.mock('./PasswordField', () => ({
  default: ({
    label,
    onChange,
    value,
  }: {
    label: string;
    onChange: (value: string) => void;
    value: string;
  }) => (
    <label>
      {label}
      <input
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </label>
  ),
}));

afterEach(() => {
  cleanup();
});

describe('ChangePasswordContent', () => {
  it('renders the three password fields, the revoke option and both actions', () => {
    render(<ChangePasswordContent email="someone@example.com" />);

    expect(screen.getByText('profile.security.password.currentLabel')).toBeInTheDocument();
    expect(screen.getByText('profile.security.password.newLabel')).toBeInTheDocument();
    expect(screen.getByText('profile.security.password.confirmLabel')).toBeInTheDocument();
    expect(screen.getByText('profile.security.password.revokeOthers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'profile.security.close' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'profile.security.password.submit' }),
    ).toBeInTheDocument();
  });

  it('puts the email-reset escape hatch in the same row as the actions', () => {
    render(<ChangePasswordContent email="someone@example.com" />);

    const emailReset = screen.getByRole('button', {
      name: 'profile.security.password.useEmailReset',
    });
    const submit = screen.getByRole('button', { name: 'profile.security.password.submit' });

    expect(emailReset.parentElement).toBe(submit.parentElement?.parentElement);
  });

  it('uses the wrapping footer row so narrow modals cannot clip an action', () => {
    render(<ChangePasswordContent email="someone@example.com" />);

    const row = screen.getByRole('button', { name: 'profile.security.password.submit' })
      .parentElement?.parentElement;

    // The modal is ~262px of content on a 320px viewport and the labels are translated; the
    // shared class is the one that carries `flex-wrap: wrap`.
    expect(row).toHaveClass(securityStyles.footerSpread);
  });

  it('omits the email-reset action when the account has no email', () => {
    render(<ChangePasswordContent />);

    expect(
      screen.queryByRole('button', { name: 'profile.security.password.useEmailReset' }),
    ).toBeNull();
  });
});
