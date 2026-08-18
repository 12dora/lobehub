import { ConfigProvider } from '@lobehub/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import * as m from 'motion/react-m';
import { describe, expect, it, vi } from 'vitest';

import { SignInTwoFactorStep, type SignInTwoFactorStepProps } from './SignInTwoFactorStep';

// The step shares the sign-in form instance; give it a real one so the antd
// wiring (normalize / validation / inline errors) is exercised, not stubbed.
// `motion` mirrors what AuthThemeLite provides around the auth SPA.
const Harness = (props: Partial<SignInTwoFactorStepProps>) => {
  const [form] = Form.useForm<{ code: string }>();

  return (
    <ConfigProvider motion={m}>
      <SignInTwoFactorStep
        form={form}
        loading={false}
        mode={'totp'}
        onBack={vi.fn()}
        onSubmit={vi.fn(async () => {})}
        onToggleMode={vi.fn()}
        {...props}
      />
    </ConfigProvider>
  );
};

const getCodeInput = () => screen.getByLabelText('betterAuth.signin.twoFactor.code.label');

describe('SignInTwoFactorStep', () => {
  it('renders the challenge with the recovery-code fallback in plain sight', () => {
    render(<Harness />);

    expect(screen.getByText('betterAuth.signin.twoFactor.title')).toBeInTheDocument();
    // Someone here may have just lost their phone — the fallback must not be
    // hidden behind a disclosure.
    expect(screen.getByText('betterAuth.signin.twoFactor.useBackupCode')).toBeInTheDocument();
    expect(screen.getByText('betterAuth.signin.twoFactor.trustDevice')).toBeInTheDocument();
    expect(screen.getByText('betterAuth.signin.twoFactor.backToPassword')).toBeInTheDocument();
  });

  it('autofocuses the code field so the user can type straight away', () => {
    render(<Harness />);

    expect(getCodeInput()).toHaveFocus();
  });

  it('uses one-time-code autofill hints on a numeric field', () => {
    render(<Harness />);
    const input = getCodeInput();

    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
  });

  it('accepts a pasted code that carries separators', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.change(getCodeInput(), { target: { value: '123 456' } });
    fireEvent.click(screen.getByText('betterAuth.signin.twoFactor.submit'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ code: '123456', trustDevice: false });
    });
  });

  it('passes the trust-this-device choice through to the verification call', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('betterAuth.signin.twoFactor.trustDevice'));
    fireEvent.change(getCodeInput(), { target: { value: '654321' } });
    fireEvent.click(screen.getByText('betterAuth.signin.twoFactor.submit'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ code: '654321', trustDevice: true });
    });
  });

  it('does not submit an empty code', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('betterAuth.signin.twoFactor.submit'));

    await waitFor(() => {
      expect(
        screen.getByText('betterAuth.signin.twoFactor.code.placeholder', { selector: 'div' }),
      ).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('swaps to a free-text recovery-code field in backup mode', () => {
    render(<Harness mode={'backupCode'} />);

    expect(screen.getByText('betterAuth.signin.twoFactor.backupCode.title')).toBeInTheDocument();
    const input = screen.getByLabelText('betterAuth.signin.twoFactor.backupCode.label');
    // Recovery codes are not 6 numeric digits — the TOTP constraints must lift
    expect(input).toHaveAttribute('inputmode', 'text');
    expect(input).not.toHaveAttribute('maxlength');
    // …and the way back to the authenticator stays offered
    expect(screen.getByText('betterAuth.signin.twoFactor.useTotp')).toBeInTheDocument();
  });

  it('offers a way back to the password step', () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);

    fireEvent.click(screen.getByText('betterAuth.signin.twoFactor.backToPassword'));

    expect(onBack).toHaveBeenCalled();
  });
});
