// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { StaticProxyUpdate, StaticProxyView } from '@/types/platform/networkProxy';

import StaticProxyForm from './StaticProxyForm';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Input: ({
    onChange,
    placeholder,
    value,
  }: {
    onChange?: (event: { target: { value: string } }) => void;
    placeholder?: string;
    value?: string;
  }) => (
    <input
      data-testid={placeholder ?? 'input'}
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
    />
  ),
  InputNumber: ({ onChange, value }: { onChange?: (v: number) => void; value?: number }) => (
    <input
      data-testid="port"
      value={String(value ?? '')}
      onChange={(event) => onChange?.(Number(event.target.value))}
    />
  ),
  InputPassword: ({
    onChange,
    value,
  }: {
    onChange?: (event: { target: { value: string } }) => void;
    value?: string;
  }) => (
    <input
      data-testid="password"
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
    />
  ),
  Select: ({ value }: { value?: string }) => <span data-testid="select">{value}</span>,
}));

const view = (server: string): StaticProxyView => ({
  hasPassword: false,
  port: 7890,
  server,
  type: 'http',
});

const setup = (props: Partial<Parameters<typeof StaticProxyForm>[0]> = {}) => {
  const onSubmit = vi.fn();
  const utils = render(
    <StaticProxyForm
      busy={false}
      disabled={false}
      value={view('a.example.com')}
      onRemove={vi.fn()}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { ...utils, onSubmit };
};

const serverInput = () =>
  screen.getByTestId('networkProxy.outlet.staticServerPlaceholder') as HTMLInputElement;

describe('StaticProxyForm', () => {
  it('submits an explicit password instruction rather than inferring one', () => {
    const { onSubmit } = setup();
    fireEvent.change(serverInput(), { target: { value: 'b.example.com' } });
    fireEvent.click(screen.getByText('networkProxy.outlet.saveStatic'));

    expect(onSubmit).toHaveBeenCalledWith({
      password: { action: 'keep' },
      port: 7890,
      server: 'b.example.com',
      type: 'http',
    });
  });

  it('re-seeds from the server when the stored proxy changes and nothing is pending', () => {
    const { rerender } = setup();
    expect(serverInput().value).toBe('a.example.com');

    rerender(
      <StaticProxyForm
        busy={false}
        disabled={false}
        value={view('winner.example.com')}
        onRemove={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(serverInput().value).toBe('winner.example.com');
  });

  it('keeps the admin submission on screen after a conflict reload brings the winner', () => {
    const pendingDraft: StaticProxyUpdate = {
      password: { action: 'keep' },
      port: 7890,
      server: 'mine.example.com',
      type: 'http',
    };
    const { rerender } = setup();

    fireEvent.change(serverInput(), { target: { value: 'mine.example.com' } });
    fireEvent.click(screen.getByText('networkProxy.outlet.saveStatic'));

    // The other administrator's proxy arrives with the conflict reload.
    rerender(
      <StaticProxyForm
        busy={false}
        disabled={false}
        pendingDraft={pendingDraft}
        value={view('winner.example.com')}
        onRemove={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    // What is on screen is still what Retry will submit.
    expect(serverInput().value).toBe('mine.example.com');
  });

  it('seeds from the pending submission on mount, not from the server view', () => {
    // The form was unmounted by a conflicting write and comes back with the draft still pending.
    setup({
      pendingDraft: {
        password: { action: 'replace', value: 's3cret' },
        port: 8080,
        server: 'mine.example.com',
        type: 'http',
      },
      value: view('winner.example.com'),
    });

    expect(serverInput().value).toBe('mine.example.com');
    expect((screen.getByTestId('port') as HTMLInputElement).value).toBe('8080');
    // What Retry sends is what is on screen, password instruction included.
    expect((screen.getByTestId('password') as HTMLInputElement).value).toBe('s3cret');
  });

  it('clears the rejected password on Discard even when the server view is unchanged', () => {
    // Password-only submission: type / host / port / username never change, so a signature-based
    // reset would leave the rejected replacement password sitting in the field.
    const stored = view('a.example.com');
    const pendingDraft: StaticProxyUpdate = {
      password: { action: 'replace', value: 'rejected-secret' },
      port: 7890,
      server: 'a.example.com',
      type: 'http',
    };
    const { rerender } = render(
      <StaticProxyForm
        busy={false}
        disabled={false}
        pendingDraft={pendingDraft}
        value={stored}
        onRemove={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect((screen.getByTestId('password') as HTMLInputElement).value).toBe('rejected-secret');

    // Discard: the entry disappears while the stored proxy is byte-for-byte the same.
    rerender(
      <StaticProxyForm
        busy={false}
        disabled={false}
        value={stored}
        onRemove={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect((screen.getByTestId('password') as HTMLInputElement).value).toBe('');
  });

  it('re-seeds again once the pending submission is dismissed', () => {
    const pendingDraft: StaticProxyUpdate = {
      password: { action: 'keep' },
      port: 7890,
      server: 'mine.example.com',
      type: 'http',
    };
    const { rerender } = setup({ pendingDraft, value: view('a.example.com') });
    fireEvent.change(serverInput(), { target: { value: 'mine.example.com' } });

    rerender(
      <StaticProxyForm
        busy={false}
        disabled={false}
        value={view('winner.example.com')}
        onRemove={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(serverInput().value).toBe('winner.example.com');
  });
});
