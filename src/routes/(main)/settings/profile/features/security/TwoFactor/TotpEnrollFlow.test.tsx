import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TotpEnrollFlow from './TotpEnrollFlow';

const mocks = vi.hoisted(() => ({
  enable: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  verifyTotp: vi.fn(),
}));

vi.mock('@lobehub/ui', () => ({
  copyToClipboard: vi.fn(),
  Text: ({ as: As = 'span', children, ...rest }: { as?: 'h3' | 'span'; children: ReactNode }) => (
    <As {...rest}>{children}</As>
  ),
}));

/**
 * `InputOTP` is reproduced rather than imported, and the reproduction has to be exact on one
 * point: base-ui's `OTPField.Root` renders a `div role="group"` that receives the spread
 * ARIA props but *not* `id` — it keeps `id` back and hands it to the first `OTPField.Input`,
 * so the visible `<label htmlFor>` makes a real native association with an input. A stub that
 * put `id` on the wrapper would let `getByLabelText` pass while that association was broken,
 * which is the one thing these assertions exist to catch.
 */
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  InputOTP: ({
    disabled,
    id,
    length: _length,
    onChange,
    value,
    ...rest
  }: {
    disabled?: boolean;
    id?: string;
    length?: number;
    onChange?: (value: string) => void;
    value?: string;
  }) => (
    <div role="group" {...rest}>
      <input
        data-testid="otp-input"
        disabled={disabled}
        id={id}
        value={value ?? ''}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </div>
  ),
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('antd', () => ({
  QRCode: () => <div data-testid="qr" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => ({ name: 'Acme', shortName: 'Acme' }),
}));

vi.mock('@/libs/better-auth/auth-client', () => ({
  twoFactor: {
    enable: (...args: unknown[]) => mocks.enable(...args),
    verifyTotp: (...args: unknown[]) => mocks.verifyTotp(...args),
  },
}));

vi.mock('../PasswordField', () => ({
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
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  ),
}));

vi.mock('./StepIndicator', () => ({ default: () => <div data-testid="steps" /> }));

const renderFlow = () =>
  render(<TotpEnrollFlow onCancel={vi.fn()} onDone={vi.fn()} onLockChange={vi.fn()} />);

/** Walk the flow to the code step: password → scan → confirm. */
const goToConfirmStep = async () => {
  renderFlow();

  fireEvent.change(screen.getByLabelText('profile.security.password.currentLabel'), {
    target: { value: 'hunter2hunter2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'profile.security.twoFactor.totp.setUp' }));
  await screen.findByTestId('qr');
  fireEvent.click(
    screen.getByRole('button', { name: 'profile.security.twoFactor.totp.step.confirm' }),
  );
};

beforeEach(() => {
  mocks.toastError.mockClear();
  mocks.toastSuccess.mockClear();
  mocks.enable.mockReset();
  mocks.enable.mockResolvedValue({
    data: {
      backupCodes: ['aaa-111'],
      totpURI: 'otpauth://totp/Acme:me?secret=JBSWY3DP&issuer=Acme',
    },
    error: null,
  });
  mocks.verifyTotp.mockReset();
  mocks.verifyTotp.mockResolvedValue({ error: null });
});

afterEach(() => {
  cleanup();
});

describe('TotpEnrollFlow code step accessibility', () => {
  it('names the first OTP input through the native label association', async () => {
    await goToConfirmStep();

    // The selector matters: the group is *also* named by the same label through
    // `aria-labelledby`, so an unqualified query would pass on the wrapper alone and say
    // nothing about whether `htmlFor` still reaches an input.
    const input = screen.getByLabelText('profile.security.twoFactor.totp.codeLabel', {
      selector: 'input',
    });

    expect(input).toBe(screen.getByTestId('otp-input'));
    expect(input.id).toBeTruthy();
    expect(document.querySelector(`label[for="${input.id}"]`)).toHaveTextContent(
      'profile.security.twoFactor.totp.codeLabel',
    );
  });

  it('names the group and leaves it valid until something fails', async () => {
    await goToConfirmStep();

    const group = screen.getByRole('group');
    const labelledBy = group.getAttribute('aria-labelledby');

    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)).toHaveTextContent(
      'profile.security.twoFactor.totp.codeLabel',
    );
    expect(group).not.toHaveAttribute('id');
    expect(group).not.toHaveAttribute('aria-invalid');
    expect(group).not.toHaveAttribute('aria-describedby');
  });

  it('associates the validation message with the OTP group', async () => {
    mocks.verifyTotp.mockResolvedValue({ error: { message: 'nope' } });

    await goToConfirmStep();

    fireEvent.change(screen.getByTestId('otp-input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'profile.security.twoFactor.totp.setUp' }));

    const alert = await screen.findByRole('alert');
    const group = screen.getByRole('group');

    expect(alert).toHaveTextContent('profile.security.twoFactor.totp.invalidCode');
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group).toHaveAttribute('aria-describedby', alert.id);
    expect(alert.id).toBeTruthy();
  });
});

describe('TotpEnrollFlow enrolment errors', () => {
  const startEnrolment = async () => {
    renderFlow();

    fireEvent.change(screen.getByLabelText('profile.security.password.currentLabel'), {
      target: { value: 'hunter2hunter2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.security.twoFactor.totp.setUp' }));
  };

  it('translates a Better Auth code instead of echoing its message', async () => {
    mocks.enable.mockResolvedValue({
      data: null,
      error: { code: 'SESSION_NOT_FRESH', message: 'Session is not fresh', status: 403 },
    });

    await startEnrolment();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('profile.security.error.reauthRequired'),
    );
    expect(mocks.toastError).not.toHaveBeenCalledWith('Session is not fresh');
    expect(mocks.toastError).not.toHaveBeenCalledWith(expect.stringContaining('SESSION_NOT_FRESH'));
  });

  it('falls back to generic copy for a code it does not map', async () => {
    mocks.enable.mockResolvedValue({
      data: null,
      error: { code: 'FAILED_TO_UPDATE_USER', message: 'Failed to update user', status: 500 },
    });

    await startEnrolment();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('unknownError'));
    expect(mocks.toastError).not.toHaveBeenCalledWith('Failed to update user');
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      expect.stringContaining('FAILED_TO_UPDATE_USER'),
    );
  });
});
