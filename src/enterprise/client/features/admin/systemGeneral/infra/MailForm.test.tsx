// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { toMailDraft } from './draft';
import { MailForm } from './MailForm';
import type { InfraMailView } from './types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Icon: () => <span />,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Input: (props: Record<string, unknown>) => <input {...props} />,
  InputPassword: (props: Record<string, unknown>) => <input type="password" {...props} />,
  Segmented: ({
    onChange,
    options,
  }: {
    onChange?: (next: string) => void;
    options?: { label: string; value: string }[];
  }) => (
    <div>
      {(options ?? []).map((option) => (
        <button key={option.value} type="button" onClick={() => onChange?.(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
  // Mirrors the real control: a labelable <button role="switch"> that takes an id.
  Switch: ({
    checked,
    id,
    onChange,
  }: {
    checked?: boolean;
    id?: string;
    onChange?: (next: boolean) => void;
  }) => (
    <button
      aria-checked={checked}
      id={id}
      role="switch"
      type="button"
      onClick={() => onChange?.(!checked)}
    />
  ),
}));

const view = (overrides: Partial<InfraMailView> = {}): InfraMailView => ({
  enabled: true,
  errorCategory: null,
  fromAddress: 'noreply@example.com',
  hasResendApiKey: false,
  hasSmtpPass: true,
  host: 'smtp.example.com',
  port: 587,
  provider: 'smtp',
  revision: 1,
  secure: true,
  senderName: 'Platform',
  smtpUser: 'mailer',
  source: 'db',
  status: 'unknown',
  ...overrides,
});

describe('MailForm', () => {
  it('renders the SMTP fields for an SMTP configuration', () => {
    render(<MailForm disabled={false} draft={toMailDraft(view())} errors={{}} onPatch={vi.fn()} />);

    expect(screen.getByDisplayValue('smtp.example.com')).toBeTruthy();
    expect(screen.getByDisplayValue('587')).toBeTruthy();
    expect(screen.getByDisplayValue('mailer')).toBeTruthy();
    expect(screen.getByDisplayValue('noreply@example.com')).toBeTruthy();
  });

  it('shows only the API key for a Resend configuration', () => {
    render(
      <MailForm
        disabled={false}
        draft={toMailDraft(view({ provider: 'resend' }))}
        errors={{}}
        onPatch={vi.fn()}
      />,
    );

    expect(screen.queryByDisplayValue('smtp.example.com')).toBeNull();
    expect(screen.getByText('systemGeneral.mail.fields.resendApiKey')).toBeTruthy();
  });

  it('switches the provider through the segmented control', () => {
    const onPatch = vi.fn();
    render(<MailForm disabled={false} draft={toMailDraft(view())} errors={{}} onPatch={onPatch} />);

    fireEvent.click(screen.getByText('systemGeneral.mail.provider.resend'));
    expect(onPatch).toHaveBeenCalledWith({ provider: 'resend' });
  });

  it('states that a published branding sender wins over this address', () => {
    render(<MailForm disabled={false} draft={toMailDraft(view())} errors={{}} onPatch={vi.fn()} />);

    expect(screen.getByText('systemGeneral.mail.hints.brandingOverride')).toBeTruthy();
  });

  it('associates every control with its visible label and its error', () => {
    render(
      <MailForm
        disabled={false}
        draft={toMailDraft(view())}
        errors={{ host: 'Required.' }}
        onPatch={vi.fn()}
      />,
    );

    const host = screen.getByLabelText('systemGeneral.mail.fields.host');
    expect(host.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(host.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Required.',
    );
    expect(screen.getByLabelText('systemGeneral.mail.fields.pass')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'systemGeneral.mail.fields.secure' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'systemGeneral.mail.fields.provider' })).toBeTruthy();
  });

  it('shows validation messages next to their controls', () => {
    render(
      <MailForm
        disabled={false}
        draft={toMailDraft(view())}
        errors={{ fromAddress: 'Enter a valid email address.', port: 'Bad port.' }}
        onPatch={vi.fn()}
      />,
    );

    expect(screen.getByText('Bad port.')).toBeTruthy();
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
  });
});
