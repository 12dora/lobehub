/**
 * Dismissal-guard tests for openCreateUserModal.
 *
 * base-ui's imperative createModal only suppresses `outside-press` when
 * `maskClosable: false` — Escape ('escape-key') still commits the close
 * (closeModal runs BEFORE the onOpenChange callback). These tests exercise the
 * veto: during 'mutating' / 'success' the modal must re-open itself so the
 * one-time credentials are never lost; explicit Cancel/Done still close.
 * @vitest-environment happy-dom
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCreateUserModal } from './CreateUserModal';

const mockClose = vi.fn();
const updateSpy = vi.fn();

/** Captured from createModal props when openCreateUserModal runs. */
let capturedOnOpenChange: ((open: boolean) => void) | undefined;
/** Mirrors base-ui's stack open state: closeModal commits before onOpenChange. */
let committedOpen = true;
let modalRoot: Root | null = null;
let modalHost: HTMLDivElement | null = null;
let capturedDiscardConfirm:
  | {
      onCancel?: () => void;
      onOk?: () => void;
    }
  | undefined;

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
    Input: ({ value, onChange, disabled, 'aria-label': aria }: any) =>
      React.createElement('input', { 'aria-label': aria, disabled, onChange, value }),
    InputPassword: ({ value, onChange, disabled, 'aria-label': aria }: any) =>
      React.createElement('input', { 'aria-label': aria, disabled, onChange, value }),
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
    confirmModal: (props: { onCancel?: () => void; onOk?: () => void }) => {
      capturedDiscardConfirm = props;
      return { close: vi.fn() };
    },
    createModal: (props: any) => {
      capturedOnOpenChange = props.onOpenChange;
      committedOpen = true;
      modalHost = document.createElement('div');
      document.body.appendChild(modalHost);
      modalRoot = createRoot(modalHost);
      modalRoot.render(props.content);
      return {
        close: () => {
          committedOpen = false;
        },
        destroy: () => {
          modalRoot?.unmount();
          modalRoot = null;
        },
        setCanDismissByClickOutside: vi.fn(),
        update: (next: any) => {
          updateSpy(next);
          if (next?.open === true) committedOpen = true;
          if (next?.open === false) committedOpen = false;
        },
      };
    },
    toast: { success: vi.fn() },
    // Real base-ui: useModalContext().close() calls closeModal directly and does
    // NOT invoke the createModal onOpenChange callback.
    useModalContext: () => ({
      close: () => {
        committedOpen = false;
        mockClose();
      },
    }),
  };
});

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAdminReauthRetry: async (fn: () => Promise<unknown>) => fn(),
  };
});

/**
 * Faithful re-play of base-ui StackItem.handleOpenChange for reason 'escape-key':
 * maskClosable:false does NOT guard it — closeModal commits, then onOpenChange fires.
 */
const simulateEscapeDismiss = () => {
  committedOpen = false;
  capturedOnOpenChange?.(false);
};

const fillValidForm = (password = 'Sup3r-secret!') => {
  fireEvent.change(screen.getByLabelText('users.modals.create.emailLabel'), {
    target: { value: 'new.user@example.com' },
  });
  fireEvent.change(screen.getByLabelText('users.modals.create.fullNameLabel'), {
    target: { value: 'New User' },
  });
  fireEvent.change(screen.getByLabelText('users.modals.create.passwordLabel'), {
    target: { value: password },
  });
};

const confirmButton = () =>
  screen.getByText('users.modals.create.confirm').closest('button') as HTMLButtonElement;

describe('openCreateUserModal dismissal guard', () => {
  beforeEach(() => {
    mockClose.mockReset();
    updateSpy.mockReset();
    capturedOnOpenChange = undefined;
    capturedDiscardConfirm = undefined;
  });

  afterEach(() => {
    modalRoot?.unmount();
    modalRoot = null;
    modalHost?.remove();
    modalHost = null;
    document.body.innerHTML = '';
  });

  it('Escape during mutating re-opens the modal and the success panel still renders', async () => {
    let resolveSubmit!: (v: unknown) => void;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const phases: string[] = [];

    openCreateUserModal({ onPhaseChange: (p) => phases.push(p), onSubmit });

    await waitFor(() =>
      expect(screen.getByLabelText('users.modals.create.emailLabel')).toBeTruthy(),
    );
    fillValidForm();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(phases).toContain('mutating'));

    simulateEscapeDismiss();

    // Veto: the committed close is reverted synchronously; no abort of the mutation.
    expect(updateSpy).toHaveBeenCalledWith({ open: true });
    expect(committedOpen).toBe(true);

    // The in-flight create resolves — the one-time credentials panel must show.
    resolveSubmit({ created: true, email: 'new.user@example.com', userId: 'user_abc' });
    await waitFor(() => expect(screen.getByText('users.modals.create.successTitle')).toBeTruthy());
    expect(screen.getByTestId('created-user-password').textContent).toBe('Sup3r-secret!');
  });

  it('Escape during success re-opens; Done still closes and later dismissals stay closed', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ created: true, email: 'new.user@example.com', userId: 'user_abc' });

    openCreateUserModal({ onSubmit });

    await waitFor(() =>
      expect(screen.getByLabelText('users.modals.create.emailLabel')).toBeTruthy(),
    );
    fillValidForm();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText('users.modals.create.successTitle')).toBeTruthy());

    simulateEscapeDismiss();
    expect(updateSpy).toHaveBeenCalledWith({ open: true });
    expect(committedOpen).toBe(true);
    expect(screen.getByTestId('created-user-password')).toBeTruthy();

    // Done: explicit close path (bypasses onOpenChange) must win.
    updateSpy.mockClear();
    fireEvent.click(screen.getByText('users.modals.create.done'));
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(committedOpen).toBe(false);

    // A stray framework dismissal during the exit animation must not resurrect it.
    capturedOnOpenChange?.(false);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(committedOpen).toBe(false);
  });

  it('Escape while idle closes normally (no veto, no re-open)', async () => {
    openCreateUserModal({ onSubmit: vi.fn() });

    await waitFor(() =>
      expect(screen.getByLabelText('users.modals.create.emailLabel')).toBeTruthy(),
    );

    simulateEscapeDismiss();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(committedOpen).toBe(false);
  });

  it('keeps a populated idle draft until discard is explicitly confirmed', async () => {
    openCreateUserModal({ onSubmit: vi.fn() });

    await waitFor(() =>
      expect(screen.getByLabelText('users.modals.create.emailLabel')).toBeTruthy(),
    );
    fillValidForm('Generated-secret!');
    fireEvent.change(screen.getByLabelText('users.modals.create.usernameLabel'), {
      target: { value: 'new.user' },
    });

    simulateEscapeDismiss();

    expect(updateSpy).toHaveBeenCalledWith({ open: true });
    expect(committedOpen).toBe(true);
    expect(capturedDiscardConfirm).toBeTruthy();
    expect(
      (screen.getByLabelText('users.modals.create.emailLabel') as HTMLInputElement).value,
    ).toBe('new.user@example.com');
    expect(
      (screen.getByLabelText('users.modals.create.passwordLabel') as HTMLInputElement).value,
    ).toBe('Generated-secret!');

    capturedDiscardConfirm?.onCancel?.();
    expect(committedOpen).toBe(true);

    simulateEscapeDismiss();
    capturedDiscardConfirm?.onOk?.();
    expect(committedOpen).toBe(false);
  });
});
